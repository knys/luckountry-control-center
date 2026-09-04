import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { CommissionInbox } from "./commission-inbox.js";

export const commissionLabel = "lcc:commission";
export const githubCommissionRepositories = ["knys/luckountry-control-center", "knys/TOBIE"] as const;

export interface GitHubCommissionIssue {
  repository: string;
  number: number;
  nodeId: string;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed";
  updatedAt: string;
  author: string;
  labels: string[];
}

export interface GitHubCommissionProvider { list(repository:string,label:string):Promise<GitHubCommissionIssue[]> }

export class GhCommissionProvider implements GitHubCommissionProvider {
  async list(repository:string,label:string) {
    if (!(githubCommissionRepositories as readonly string[]).includes(repository)) throw new Error("repository is not allowlisted");
    const value=await runGh(["api",`repos/${repository}/issues`,"--method","GET","-f","state=open","-f",`labels=${label}`,"-f","per_page=100"]);
    const raw=JSON.parse(value) as Record<string,unknown>[];
    return raw.filter(x=>!x.pull_request).map(x=>({repository,number:Number(x.number),nodeId:String(x.node_id),title:String(x.title),body:String(x.body??""),url:String(x.html_url),state:x.state==="open"?"open":"closed",updatedAt:String(x.updated_at),author:String((x.user as {login?:string})?.login??""),labels:((x.labels as {name?:string}[])??[]).map(v=>String(v.name))} satisfies GitHubCommissionIssue));
  }
}

export class GitHubCommissionScanner {
  constructor(private inbox:CommissionInbox,private provider:GitHubCommissionProvider,private repositories:readonly string[]=githubCommissionRepositories) {}
  async scan() {
    const imported=[];
    for(const repository of this.repositories){
      if(!(githubCommissionRepositories as readonly string[]).includes(repository))throw new Error("repository is not allowlisted");
      for(const issue of await this.provider.list(repository,commissionLabel)){
        validate(issue,repository);
        const revision=sourceRevision(issue),existing=(await this.inbox.list()).find(v=>v.repository===repository&&v.issueNumber===issue.number);
        if(existing){
          if(existing.sourceRevision&&existing.sourceRevision!==revision&&["COMMISSIONED","COMPLETED"].includes(existing.commissionState))await this.inbox.patch(existing.id,{sourceRevision:revision});
          continue;
        }
        const human=parseHumanGate(issue.body),candidate=await this.inbox.register({title:issue.title,product:repository.endsWith("/TOBIE")?"TOBIE WALL":"LCC",source:"GITHUB",sourceRef:issue.url,repository,issueNumber:issue.number,issueUrl:issue.url,commissionState:"READY",suggestedNextActionJa:`Issue #${issue.number} のAcceptance Criteriaを実装・検証・promotionする`,whyNotCommissioned:"GitHub Commission label verified",humanGate:human,humanActionJa:null,priority:50,sourceRevision:revision,githubIdentity:issue.author,commissionLabel});
        imported.push(await this.inbox.commission(candidate.id));
      }
    }
    return imported;
  }
}

export function sourceRevision(issue:GitHubCommissionIssue){return createHash("sha256").update([issue.repository,issue.nodeId,issue.number,issue.updatedAt,[...issue.labels].sort().join(",")].join("\0")).digest("hex").slice(0,32)}
function validate(issue:GitHubCommissionIssue,repository:string){if(issue.repository!==repository||issue.state!=="open"||!issue.labels.includes(commissionLabel)||!Number.isInteger(issue.number)||issue.number<1||!issue.nodeId||!/^https:\/\/github\.com\/knys\/[\w.-]+\/issues\/\d+$/.test(issue.url)||!issue.author)throw new Error("invalid GitHub Commission identity")}
function parseHumanGate(body:string){const heading=/^## Human Gate[^\n]*$/m.exec(body);if(!heading)return null;const start=heading.index+heading[0].length,end=body.indexOf("\n## ",start),value=body.slice(start,end<0?body.length:end).trim();return value.slice(0,1200)||null}
function runGh(args:string[]){return new Promise<string>((resolve,reject)=>{const child=spawn("/usr/bin/gh",args,{stdio:["ignore","pipe","pipe"],shell:false,env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:process.env.HOME??"/home/user",GH_CONFIG_DIR:process.env.GH_CONFIG_DIR??"/home/user/.config/gh"}});let out="",err="";child.stdout.on("data",v=>{out+=v;if(out.length>2_000_000)child.kill()});child.stderr.on("data",v=>{err+=v;if(err.length>2000)err=err.slice(-2000)});child.once("error",reject);child.once("exit",code=>code===0?resolve(out):reject(new Error(`GitHub query failed (${code??1}): ${err.slice(-500)}`)))})}
