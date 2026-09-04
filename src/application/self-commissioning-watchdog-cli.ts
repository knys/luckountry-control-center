import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BoundedLocalCodexExecutor } from "./commission-runs.js";
import { GitHubCommentTransport } from "./evidence-reporting.js";
import { DurableWatchdogStore, SelfCommissioningWatchdog, type WatchdogActionResult, type WatchdogEvidence, type WatchdogObservation, type WatchdogPorts } from "./self-commissioning-watchdog.js";
import type { SelfCommissioningRun } from "../domain/self-commissioning-run.js";

const data="/var/lib/luckountry-control-center",statePath=join(data,"self-commissioning-watchdog.json"),runsPath=join(data,"commission-runs.json"),watcherPath=join(data,"watcher.json"),allowedServices=new Set(["luckountry-control-center.service","luckountry-commission-watcher.service"]);

async function command(file:string,args:string[]):Promise<WatchdogActionResult>{return new Promise(resolve=>{const child=spawn(file,args,{stdio:["ignore","pipe","pipe"],shell:false,env:{PATH:"/usr/local/bin:/usr/bin:/bin"}});let output="";child.stdout.on("data",v=>output=(output+String(v)).slice(-500));child.stderr.on("data",v=>output=(output+String(v)).slice(-500));child.once("error",e=>resolve({ok:false,summary:e.message}));child.once("exit",code=>resolve({ok:code===0,summary:code===0?"fixed operation succeeded":`fixed operation failed (${code??1}): ${output}`}))})}
async function serviceActive(service:string){return (await command("/usr/bin/systemctl",["is-active","--quiet",service])).ok}
async function optional(path:string){try{return (await readFile(path,"utf8")).trim()}catch{return null}}
async function inspect():Promise<WatchdogObservation>{
  let runs:SelfCommissioningRun[]=[],stateReadable=true;try{const raw=JSON.parse(await readFile(runsPath,"utf8")) as {version?:unknown;runs?:{run?:SelfCommissioningRun}[]};if(raw.version!==1||!Array.isArray(raw.runs))throw Error("invalid run store");runs=raw.runs.flatMap(v=>v.run?[v.run]:[])}catch(e){if(!(e instanceof Error&&"code" in e&&(e as NodeJS.ErrnoException).code==="ENOENT"))stateReadable=false}
  let watcherState:string|null=null,watcherUpdatedAt:string|null=null;try{const raw=JSON.parse(await readFile(watcherPath,"utf8")) as {state?:unknown;lastScan?:unknown};if(typeof raw.state!=="string"||typeof raw.lastScan!=="string")throw Error("invalid watcher state");watcherState=raw.state;watcherUpdatedAt=raw.lastScan}catch(e){if(!(e instanceof Error&&"code" in e&&(e as NodeJS.ErrnoException).code==="ENOENT"))stateReadable=false}
  const healthReady=await fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(5000)}).then(r=>r.ok).catch(()=>false);
  return {observedAt:new Date().toISOString(),lccServiceActive:await serviceActive("luckountry-control-center.service"),watcherServiceActive:await serviceActive("luckountry-commission-watcher.service"),healthReady,watcherState,watcherUpdatedAt,productionRevision:await optional("/opt/luckountry-control-center/REVISION"),expectedRevision:await optional("/var/lib/luckountry-control-center/expected-revision"),stateReadable,runs};
}
function controlToken(){const value=process.env.SELF_COMMISSIONING_CONTROL_TOKEN??"";if(!value)throw Error("control token unavailable");return value}
const ports:WatchdogPorts={
  inspect,
  restart:async(service,key)=>{if(!allowedServices.has(service)||!/^[0-9a-f]{32}:restart:[1-3]$/.test(key))return{ok:false,summary:"restart policy rejected"};return command("/usr/bin/sudo",["/usr/local/libexec/lcc-watchdog-recovery","restart",service,key])},
  recover:async input=>{if(!/^[\w.-]{1,100}$/.test(input.runId)||!/^[0-9a-f]{24}$/.test(input.expectedFailure)||!/^[0-9a-f]{32}:formal-recovery$/.test(input.idempotencyKey))return{ok:false,summary:"recovery binding rejected"};try{const response=await fetch(`http://127.0.0.1:3000/api/commission-runs/${input.runId}/recover`,{method:"POST",headers:{authorization:`Bearer ${controlToken()}`,"content-type":"application/json","idempotency-key":input.idempotencyKey},body:JSON.stringify({actor:"lcc-watchdog",reason:`bounded watchdog recovery ${input.idempotencyKey}`,expectedFailure:input.expectedFailure}),signal:AbortSignal.timeout(10_000)});return{ok:response.ok,summary:`formal Recovery API status ${response.status}`}}catch(e){return{ok:false,summary:e instanceof Error?e.message:"formal Recovery API failed"}}},
  codex:async input=>{if(input.repository!=="knys/luckountry-control-center"||input.workspaceId!=="lcc-watchdog-recovery"||input.timeoutMs!==900_000)return{ok:false,summary:"Codex recovery policy rejected"};const executor=new BoundedLocalCodexExecutor(join(data,"watchdog-workspaces"),"/usr/local/bin/codex",undefined,undefined,input.timeoutMs),result=await executor.execute({objective:`Recover Issue #65 watchdog failure fingerprint ${input.fingerprint}. Inspect durable redacted state; do not expand scope.`,repository:input.repository,workspaceId:input.workspaceId,issueNumber:65,sourceRevision:input.fingerprint,policy:{allowCommit:true,allowPush:false,allowMerge:false,allowDeploy:false}});return{ok:result.status==="SUCCEEDED",summary:result.summary,evidence:result.evidence}},
  report:async(evidence:WatchdogEvidence)=>{const body=["LCC Self-Commissioning Watchdog",`state: ${evidence.state}`,`fingerprint: ${evidence.fingerprint}`,`classification: ${evidence.classification}`,`summary: ${evidence.summary}`,...evidence.actions.map(v=>`recovery: ${v}`),"next: bounded policy decision required"].join("\n").slice(0,8000);return new GitHubCommentTransport(process.env.GITHUB_TOKEN??"").postComment("knys/luckountry-control-center",65,body)}
};

const watchdog=new SelfCommissioningWatchdog(await DurableWatchdogStore.open(statePath),ports),result=await watchdog.runOnce();process.stdout.write(JSON.stringify(result)+"\n");
