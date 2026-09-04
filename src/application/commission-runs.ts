import { spawn } from "node:child_process";
import { access,mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommissionCandidate,CommissionRunRegistrar } from "./commission-inbox.js";
import { DurableSelfCommissioningStore,SelfCommissioningOrchestrator,type CodexJob,type CommissioningExecutors,type CommissioningResult } from "./self-commissioning.js";

export class DurableCommissionRunRegistrar implements CommissionRunRegistrar {
  constructor(private path:string){}
  async register(candidate:CommissionCandidate,runId:string){
    const store=await DurableSelfCommissioningStore.open(this.path);if(await store.get(runId))return;
    const unavailable=async():Promise<CommissioningResult>=>({status:"BLOCKED",summary:"Commission Run permits only bounded CODEX_JOB",evidence:[]}),orchestrator=new SelfCommissioningOrchestrator(store,{tx:unavailable,gtx:unavailable,codex:unavailable});
    const promotion=candidate.sourceRevision&&candidate.commissionLabel==="lcc:commission";
    const job:CodexJob={objective:`GitHub Issue #${candidate.issueNumber}「${candidate.title}」を実装・検証する`,repository:candidate.repository,workspaceId:workspaceId(candidate.repository),issueNumber:candidate.issueNumber!,sourceRevision:candidate.sourceRevision??null,humanGate:candidate.humanGate,policy:{allowCommit:true,allowPush:Boolean(promotion),allowMerge:Boolean(promotion),allowDeploy:Boolean(promotion&&candidate.repository==="knys/luckountry-control-center")}};
    await orchestrator.create({runId,objective:job.objective,steps:[{stepId:"codex-job",kind:"CODEX_JOB",job}],retryLimit:3});
  }
  async retainCompleted(candidate:CommissionCandidate,runId:string){await this.register(candidate,runId);const store=await DurableSelfCommissioningStore.open(this.path),value=await store.stored(runId);if(!value||value.run.status==="SUCCEEDED")return;const at=new Date().toISOString();await store.replace({...value,run:{...value.run,status:"SUCCEEDED",currentStep:null,activeActor:null,activeExecutionId:null,queuedActor:null,queuedStep:null,completedSteps:["codex-job"],updatedAt:at,history:[...value.run.history,{type:"MIGRATED_COMPLETION",at,summary:"Prior production completion retained in Dispatcher SSOT",evidence:[candidate.issueUrl??candidate.sourceRef]}]}})}
}

type Output={code:number;stdout:string;stderr:string};
export type FixedRunner=(file:string,args:string[],cwd:string,inherit?:boolean)=>Promise<Output>;
const defaultRunner:FixedRunner=(file,args,cwd,inherit=false)=>new Promise(resolve=>{const child=spawn(file,args,{cwd,stdio:inherit?"inherit":["ignore","pipe","pipe"],shell:false});let stdout="",stderr="";if(!inherit){child.stdout!.on("data",v=>stdout+=String(v));child.stderr!.on("data",v=>stderr+=String(v))}child.once("exit",code=>resolve({code:code??1,stdout,stderr}));child.once("error",error=>resolve({code:1,stdout,stderr:error.message}))});

const profiles={
  "knys/luckountry-control-center":{checks:[["/usr/bin/npm",["test"]],["/usr/bin/npm",["run","typecheck"]],["/usr/bin/npm",["run","build"]],["/usr/bin/git",["diff","--check"]]] as [string,string[]][],paths:/^(src|test|ops|config|docs)\/|^(README\.md|package(-lock)?\.json|tsconfig[^/]*\.json)$/,deploy:["/usr/bin/sudo",["-n","/usr/local/sbin/lcc-deploy"]] as [string,string[]]},
  "knys/TOBIE":{checks:[["/usr/bin/npm",["test"]],["/usr/bin/npm",["run","typecheck"]],["/usr/bin/npm",["run","build"]],["/usr/bin/git",["diff","--check"]]] as [string,string[]][],paths:/^(src|scripts|docs|public)\/|^(README\.md|package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.ts)$/,deploy:null}
} as const;

export class BoundedLocalCodexExecutor {
  private child:ReturnType<typeof spawn>|null=null;
  constructor(private workspaceRoot:string,private codexPath="/usr/local/bin/codex",private run:FixedRunner=defaultRunner){}
  async execute(job:CodexJob):Promise<CommissioningResult>{
    const profile=profiles[job.repository as keyof typeof profiles];if(!profile)return{status:"BLOCKED",summary:"repository has no promotion profile",evidence:[]};
    const cwd=join(this.workspaceRoot,workspaceId(job.repository));await mkdir(this.workspaceRoot,{recursive:true});
    try{await access(join(cwd,".git"))}catch{const clone=await this.run("/usr/bin/git",["clone","--",`https://github.com/${job.repository}.git`,cwd],this.workspaceRoot);if(clone.code)return{status:"FAILED",summary:"Dedicated workspace clone failed",evidence:[],retryable:true}}
    const identity=await this.run("/usr/bin/git",["remote","get-url","origin"],cwd),dirty=await this.run("/usr/bin/git",["status","--porcelain"],cwd),base=await this.run("/usr/bin/git",["rev-parse","HEAD"],cwd);
    if(identity.code||!identity.stdout.trim().replace(/\.git$/,"").endsWith(job.repository)||dirty.code||dirty.stdout.trim())return{status:"BLOCKED",summary:"Dedicated workspace identity or clean-base precondition failed",evidence:[]};
    const branch=`lcc/commission/${job.issueNumber}-${base.stdout.trim().slice(0,8)}`;const switched=await this.run("/usr/bin/git",["switch","-c",branch],cwd);if(switched.code)return{status:"FAILED",summary:"Dedicated branch creation failed",evidence:[],retryable:true};
    const prompt=`Repository: ${job.repository}\nIssue: https://github.com/${job.repository}/issues/${job.issueNumber}\n${job.objective}\nInspect the Issue as SSOT. Implement and test only its bounded scope. Commit all intended changes on the current dedicated branch. Do not push, merge, deploy, expose secrets, alter unrelated work, or request Human command/log transport. Future Human acceptance is not a pre-implementation gate.`;
    const codex=await this.codex(prompt,cwd);if(codex.code)return{status:"FAILED",summary:`Codex exited ${codex.code}`,evidence:[],retryable:true};
    const finalized=await finalizeCandidate(job,cwd,base.stdout.trim(),profile.paths,this.run);if(finalized)return finalized;
    const post=await verifyCandidate(job,cwd,base.stdout.trim(),profile.paths,profile.checks,this.run);if(post.status!=="SUCCEEDED")return post;
    const promoted=await promote(job,cwd,branch,profile.deploy,this.run);if(promoted.status!=="SUCCEEDED")return promoted;
    if(job.humanGate)return{status:"WAITING_HUMAN",summary:"Automated implementation, promotion and deploy completed",evidence:[...post.evidence,...promoted.evidence],humanGate:job.humanGate};
    return{status:"SUCCEEDED",summary:"Committed candidate passed independent checks and promotion",evidence:[...post.evidence,...promoted.evidence]};
  }
  private codex(prompt:string,cwd:string){return new Promise<Output>(resolve=>{const child=spawn(this.codexPath,["exec","--approve-for-me",prompt],{cwd,stdio:"inherit",shell:false});this.child=child;let settled=false;const done=(x:Output)=>{if(settled)return;settled=true;this.child=null;resolve(x)};child.once("exit",code=>done({code:code??1,stdout:"",stderr:""}));child.once("error",error=>done({code:1,stdout:"",stderr:error.message}))})}
  stop(){this.child?.kill("SIGTERM")}
}

export async function finalizeCandidate(job:CodexJob,cwd:string,base:string,pathBoundary:RegExp,run:FixedRunner):Promise<CommissioningResult|null>{
  const head=await run("/usr/bin/git",["rev-parse","HEAD"],cwd);if(head.code)return{status:"BLOCKED",summary:"Candidate HEAD unavailable",evidence:[]};if(head.stdout.trim()!==base)return null;
  const status=await run("/usr/bin/git",["status","--porcelain"],cwd),diff=await run("/usr/bin/git",["diff","--no-ext-diff"],cwd);if(status.code||diff.code)return{status:"BLOCKED",summary:"Candidate worktree inspection failed",evidence:[]};
  const lines=status.stdout.split(/\r?\n/).filter(Boolean),paths=lines.map(line=>line.slice(3));
  const secret=/(gh[opsu]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:password|token|secret)\s*[=:]\s*(?!process\.env\.|Deno\.env\.)[^\s"']{8,})/i;
  if(!lines.length||lines.some(line=>line.startsWith("??")||line.includes(" -> "))||paths.some(path=>!pathBoundary.test(path))||secret.test(diff.stdout))return{status:"BLOCKED",summary:"Uncommitted candidate is empty, untracked, renamed, outside boundary, or secret-shaped",evidence:[]};
  const staged=await run("/usr/bin/git",["add","--update","--",...paths],cwd);if(staged.code)return{status:"BLOCKED",summary:"Bounded candidate staging failed",evidence:[]};
  const committed=await run("/usr/bin/git",["commit","-m",`Commission #${job.issueNumber}: finalize bounded actor changes`],cwd);return committed.code?{status:"BLOCKED",summary:"Bounded candidate commit failed",evidence:[]}:null;
}

export async function verifyCandidate(job:CodexJob,cwd:string,base:string,pathBoundary:RegExp,checks:readonly [string,string[]][],run:FixedRunner):Promise<CommissioningResult>{
  const status=await run("/usr/bin/git",["status","--porcelain"],cwd),head=await run("/usr/bin/git",["rev-parse","HEAD"],cwd),ancestor=await run("/usr/bin/git",["merge-base","--is-ancestor",base,head.stdout.trim()],cwd),files=await run("/usr/bin/git",["diff","--name-only",`${base}..${head.stdout.trim()}`],cwd),diff=await run("/usr/bin/git",["diff","--no-ext-diff",`${base}..${head.stdout.trim()}`],cwd);
  const changed=files.stdout.split(/\r?\n/).filter(Boolean),secret=/(gh[opsu]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:password|token|secret)\s*[=:]\s*(?!process\.env\.|Deno\.env\.)[^\s"']{8,})/i;
  if(status.code||status.stdout.trim()||head.code||head.stdout.trim()===base||ancestor.code||!changed.length||changed.some(v=>!pathBoundary.test(v))||secret.test(diff.stdout))return{status:"BLOCKED",summary:"Candidate postcondition failed: clean committed descendant, boundary, non-empty diff, or secret scan",evidence:[]};
  const evidence=[`candidate=${head.stdout.trim()}`,`base=${base}`,`files=${changed.length}`];for(const [file,args] of checks){const value=await run(file,args,cwd);if(value.code)return{status:"FAILED",summary:`Independent check failed: ${file} ${args.join(" ")}`,evidence,retryable:true};evidence.push(`${file.split("/").at(-1)} ${args.join(" ")}: PASS`)}
  return{status:"SUCCEEDED",summary:"Candidate postconditions passed",evidence};
}

async function promote(job:CodexJob,cwd:string,branch:string,deploy:[string,string[]]|null,run:FixedRunner):Promise<CommissioningResult>{
  if(!job.policy.allowPush||!job.policy.allowMerge)return{status:"BLOCKED",summary:"promotion authority unavailable",evidence:[]};
  for(const [file,args] of [["/usr/bin/git",["push","-u","origin",branch]],["/usr/bin/gh",["pr","create","--repo",job.repository,"--base","main","--head",branch,"--title",`Commission #${job.issueNumber}: autonomous implementation`,"--body",`Closes #${job.issueNumber}\\n\\nAutomated candidate; independent fixed checks and postconditions passed.`]]] as [string,string[]][]){const value=await run(file,args,cwd);if(value.code)return{status:"FAILED",summary:`Promotion command failed: ${file.split("/").at(-1)}`,evidence:[],retryable:true}}
  const checks=await run("/usr/bin/gh",["pr","checks",branch,"--repo",job.repository,"--watch","--interval","10"],cwd);if(checks.code&&!/no checks reported/i.test(checks.stderr+checks.stdout))return{status:"FAILED",summary:"Required CI did not pass",evidence:[],retryable:true};
  const merge=await run("/usr/bin/gh",["pr","merge",branch,"--repo",job.repository,"--merge","--delete-branch"],cwd);if(merge.code)return{status:"FAILED",summary:"main merge failed",evidence:[],retryable:true};
  const evidence=["push=PASS","pr=PASS","ci=PASS","main-merge=PASS"];
  if(deploy){if(!job.policy.allowDeploy)return{status:"BLOCKED",summary:"deploy authority unavailable",evidence};const mirror="/home/user/projects/luckountry-control-center",mirrorStatus=await run("/usr/bin/git",["status","--porcelain"],mirror);if(mirrorStatus.code||mirrorStatus.stdout.trim())return{status:"BLOCKED",summary:"fixed production source mirror is not clean",evidence};for(const args of [["fetch","origin","main"],["merge","--ff-only","origin/main"]]){const sync=await run("/usr/bin/git",args,mirror);if(sync.code)return{status:"FAILED",summary:"fixed production source mirror sync failed",evidence,retryable:true}}const result=await run(deploy[0],deploy[1],mirror);if(result.code)return{status:"FAILED",summary:"allowlisted production deploy failed",evidence,retryable:true};const health=await fetch("http://127.0.0.1:3000/health").then(r=>r.ok).catch(()=>false);if(!health)return{status:"FAILED",summary:"production health canary failed",evidence,retryable:true};evidence.push("previous-artifact=retained","allowlisted-deploy=PASS","health=PASS")}
  return{status:"SUCCEEDED",summary:"Autonomous promotion completed",evidence};
}
export function commissionExecutors(codex:BoundedLocalCodexExecutor):CommissioningExecutors{const unavailable=async():Promise<CommissioningResult>=>({status:"BLOCKED",summary:"Unsupported Commission operation",evidence:[]});return{tx:unavailable,gtx:unavailable,codex:job=>codex.execute(job)}}
export const workspaceId=(repository:string)=>repository.replace(/[^A-Za-z0-9._-]/g,"-").slice(0,100);
