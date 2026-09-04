import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SelfCommissioningRun } from "../domain/self-commissioning-run.js";
import { failureRevision } from "./self-commissioning.js";
import { redact } from "./verification.js";

export const watchdogPolicy = { staleMs: 15 * 60_000, restartLimit: 3, cooldownMs: 30 * 60_000, dailyCodexLimit: 3 } as const;
export const normalWatchdogStates = ["IDLE", "WATCHING", "RUNNING_WITH_ACTOR", "WAITING_HUMAN"] as const;
export type WatchdogNormalState = typeof normalWatchdogStates[number];
export type WatchdogFailure = "HEALTH_OR_SERVICE_DOWN"|"WATCHER_DOWN"|"READINESS_STALE_BLOCKED"|"RUN_STALE"|"ACTOR_LOST"|"DISPATCH_FAILURE"|"CODEX_FAILURE"|"REVISION_MISMATCH"|"STATE_CORRUPTION"|"RESTORE_FAILURE"|"UNKNOWN"|"CODE_FIX_REQUIRED";
export type WatchdogClassification = WatchdogNormalState|WatchdogFailure;

export interface WatchdogObservation {
  observedAt: string;
  lccServiceActive: boolean;
  watcherServiceActive: boolean;
  healthReady: boolean;
  watcherState: string|null;
  watcherUpdatedAt?: string|null;
  productionRevision: string|null;
  expectedRevision: string|null;
  stateReadable: boolean;
  restoreFailed?: boolean;
  codeFixRequired?: boolean;
  unknownFailure?: boolean;
  runs: SelfCommissioningRun[];
}
export interface WatchdogActionResult { ok:boolean; summary:string; evidence?:readonly string[] }
export interface WatchdogPorts {
  inspect():Promise<WatchdogObservation>;
  restart(service:"luckountry-control-center.service"|"luckountry-commission-watcher.service",idempotencyKey:string):Promise<WatchdogActionResult>;
  recover(input:{runId:string;expectedFailure:string;idempotencyKey:string}):Promise<WatchdogActionResult>;
  codex(input:{fingerprint:string;repository:"knys/luckountry-control-center";workspaceId:"lcc-watchdog-recovery";timeoutMs:900_000}):Promise<WatchdogActionResult>;
  report(evidence:WatchdogEvidence):Promise<{commentId:string}>;
}
export interface WatchdogEvidence { fingerprint:string; classification:WatchdogFailure; state:"BLOCKED_WITH_EVIDENCE"; summary:string; actions:readonly string[] }
interface Incident { fingerprint:string; classification:WatchdogFailure; firstSeenAt:string; lastSeenAt:string; restartAttempts:number; formalRecoveryAttempted:boolean; codexAttempted:boolean; blocked:boolean; actions:string[] }
interface Delivery { fingerprint:string; commentId:string|null }
interface WatchdogSnapshot { version:1; incidents:Incident[]; codexAttempts:string[]; deliveries:Delivery[]; lastDecision:{at:string;classification:WatchdogClassification;fingerprint:string|null}|null }

export class DurableWatchdogStore {
  private pending=Promise.resolve();
  private constructor(private path:string,private value:WatchdogSnapshot){}
  static async open(path:string){let value:WatchdogSnapshot;try{value=JSON.parse(await readFile(path,"utf8")) as WatchdogSnapshot;if(value.version!==1||!Array.isArray(value.incidents)||!Array.isArray(value.codexAttempts)||!Array.isArray(value.deliveries))throw Error("invalid watchdog state")}catch(e){if(!(e instanceof Error&&"code" in e&&(e as NodeJS.ErrnoException).code==="ENOENT"))throw e;value={version:1,incidents:[],codexAttempts:[],deliveries:[],lastDecision:null};await persist(path,value)}if(((await stat(path)).mode&0o777)!==0o600)await chmod(path,0o600);return new DurableWatchdogStore(path,value)}
  async snapshot(){await this.pending;return structuredClone(this.value)}
  async update<T>(fn:(value:WatchdogSnapshot)=>T){const op=this.pending.then(async()=>{const next=structuredClone(this.value),result=fn(next);await persist(this.path,next);this.value=next;return structuredClone(result)});this.pending=op.then(()=>undefined,()=>undefined);return op}
}

export function classifyWatchdog(observation:WatchdogObservation,now=Date.parse(observation.observedAt)):WatchdogClassification {
  if(!observation.stateReadable)return "STATE_CORRUPTION";
  if(observation.restoreFailed)return "RESTORE_FAILURE";
  if(!observation.lccServiceActive||!observation.healthReady)return "HEALTH_OR_SERVICE_DOWN";
  if(!observation.watcherServiceActive)return "WATCHER_DOWN";
  if(observation.watcherUpdatedAt&&now-Date.parse(observation.watcherUpdatedAt)>=watchdogPolicy.staleMs)return "WATCHER_DOWN";
  if(observation.watcherState==="DEGRADED")return "DISPATCH_FAILURE";
  if(observation.expectedRevision&&observation.productionRevision!==observation.expectedRevision)return "REVISION_MISMATCH";
  if(observation.codeFixRequired)return "CODE_FIX_REQUIRED";
  if(observation.unknownFailure)return "UNKNOWN";
  const active=observation.runs.filter(run=>["QUEUED","RUNNING"].includes(run.status));
  const waiting=observation.runs.some(run=>run.status==="WAITING_HUMAN");
  const blocked=observation.runs.filter(run=>run.status==="BLOCKED"&&now-Date.parse(run.updatedAt)>=watchdogPolicy.staleMs);
  const actorLost=active.find(run=>run.status==="RUNNING"&&(!run.activeActor||!run.activeExecutionId));
  if(actorLost)return "ACTOR_LOST";
  if(active.some(run=>run.status==="RUNNING"&&now-Date.parse(run.updatedAt)>=watchdogPolicy.staleMs))return "RUN_STALE";
  if(blocked.some(run=>/codex/i.test(run.blocker??"")))return "CODEX_FAILURE";
  if(blocked.some(run=>/dispatch/i.test(run.blocker??"")))return "DISPATCH_FAILURE";
  if(blocked.length)return "READINESS_STALE_BLOCKED";
  if(active.some(run=>run.status==="RUNNING"))return "RUNNING_WITH_ACTOR";
  if(waiting)return "WAITING_HUMAN";
  if(observation.watcherState==="WATCHING")return "WATCHING";
  return "IDLE";
}

export class SelfCommissioningWatchdog {
  constructor(private store:DurableWatchdogStore,private ports:WatchdogPorts,private clock:()=>number=Date.now){}
  async runOnce(){
    const first=await this.ports.inspect(); // Level 1 integrity/readiness always precedes mutation.
    const classification=classifyWatchdog(first,this.clock());
    if((normalWatchdogStates as readonly string[]).includes(classification)){await this.store.update(s=>{s.lastDecision={at:new Date(this.clock()).toISOString(),classification,fingerprint:null};return s.lastDecision});return {classification,action:"NONE" as const}}
    const failure=classification as WatchdogFailure,fingerprint=incidentFingerprint(failure,first),now=new Date(this.clock()).toISOString();
    let incident=await this.store.update(s=>{let i=s.incidents.find(v=>v.fingerprint===fingerprint);if(!i){i={fingerprint,classification:failure,firstSeenAt:now,lastSeenAt:now,restartAttempts:0,formalRecoveryAttempted:false,codexAttempted:false,blocked:false,actions:[]};s.incidents.push(i)}else i.lastSeenAt=now;s.lastDecision={at:now,classification,fingerprint};return i});
    if(incident.blocked)return {classification:failure,action:"BLOCKED_WITH_EVIDENCE" as const,fingerprint};
    if(["HEALTH_OR_SERVICE_DOWN","WATCHER_DOWN","RESTORE_FAILURE"].includes(failure)&&incident.restartAttempts<watchdogPolicy.restartLimit){
      const service=failure==="WATCHER_DOWN"?"luckountry-commission-watcher.service" as const:"luckountry-control-center.service" as const;
      const result=await this.ports.restart(service,`${fingerprint}:restart:${incident.restartAttempts+1}`);incident=await this.record(fingerprint,`L2 restart ${service}: ${safe(result.summary)}`,i=>i.restartAttempts++);
      const restored=classifyWatchdog(await this.ports.inspect(),this.clock());
      if((normalWatchdogStates as readonly string[]).includes(restored))return {classification:restored,action:"RESTART_RESTORED" as const,fingerprint};
      if(incident.restartAttempts<watchdogPolicy.restartLimit)return {classification:failure,action:"RESTART_ATTEMPTED" as const,fingerprint};
    }
    const run=recoverableRun(first.runs);
    if(!incident.formalRecoveryAttempted&&run&&!["UNKNOWN","CODE_FIX_REQUIRED","STATE_CORRUPTION","REVISION_MISMATCH"].includes(failure)){
      const result=await this.ports.recover({runId:run.runId,expectedFailure:failureRevision(run),idempotencyKey:`${fingerprint}:formal-recovery`});
      await this.record(fingerprint,`L3 formal recovery: ${safe(result.summary)}`,i=>{i.formalRecoveryAttempted=true});
      if(result.ok)return {classification:failure,action:"FORMAL_RECOVERY" as const,fingerprint};
    }
    incident=(await this.store.snapshot()).incidents.find(v=>v.fingerprint===fingerprint)!;
    if(["UNKNOWN","CODE_FIX_REQUIRED"].includes(failure)&&!incident.codexAttempted){
      const snapshot=await this.store.snapshot(),recent=snapshot.codexAttempts.filter(at=>this.clock()-Date.parse(at)<86_400_000),last=recent.at(-1);
      if(recent.length<watchdogPolicy.dailyCodexLimit&&last&&this.clock()-Date.parse(last)<watchdogPolicy.cooldownMs)return {classification:failure,action:"CODEX_COOLDOWN" as const,fingerprint};
      if(recent.length<watchdogPolicy.dailyCodexLimit){
        const result=await this.ports.codex({fingerprint,repository:"knys/luckountry-control-center",workspaceId:"lcc-watchdog-recovery",timeoutMs:900_000});
        await this.store.update(s=>{s.codexAttempts=s.codexAttempts.filter(at=>this.clock()-Date.parse(at)<86_400_000);s.codexAttempts.push(now);const i=s.incidents.find(v=>v.fingerprint===fingerprint)!;i.codexAttempted=true;i.actions.push(`L4 Codex recovery: ${safe(result.summary)}`)});
        if(result.ok)return {classification:failure,action:"CODEX_RECOVERY" as const,fingerprint};
      }
    }
    incident=(await this.store.snapshot()).incidents.find(v=>v.fingerprint===fingerprint)!;
    await this.blockAndReport(incident);
    return {classification:failure,action:"BLOCKED_WITH_EVIDENCE" as const,fingerprint};
  }
  private async record(fingerprint:string,action:string,mutate:(incident:Incident)=>void){return this.store.update(s=>{const i=s.incidents.find(v=>v.fingerprint===fingerprint)!;mutate(i);i.actions.push(action);return i})}
  private async blockAndReport(incident:Incident){const snapshot=await this.store.snapshot();if(snapshot.deliveries.some(v=>v.fingerprint===incident.fingerprint&&v.commentId))return;const evidence:WatchdogEvidence={fingerprint:incident.fingerprint,classification:incident.classification,state:"BLOCKED_WITH_EVIDENCE",summary:"Target Issue isolated after bounded recovery; portfolio remains WATCHING and will re-evaluate after cooldown or revision change",actions:incident.actions.slice(-10).map(safe)};const posted=await this.ports.report(evidence);await this.store.update(s=>{const i=s.incidents.find(v=>v.fingerprint===incident.fingerprint)!;i.blocked=true;s.deliveries.push({fingerprint:incident.fingerprint,commentId:safe(posted.commentId)})})}
}

function recoverableRun(runs:SelfCommissioningRun[]){return [...runs].filter(run=>run.status==="BLOCKED"&&run.failedStep&&run.blocker).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]}
function incidentFingerprint(classification:WatchdogFailure,o:WatchdogObservation){const run=recoverableRun(o.runs);return createHash("sha256").update([classification,run?.runId??"",run?failureRevision(run):"",o.productionRevision??"",o.expectedRevision??""].join("\0")).digest("hex").slice(0,32)}
function safe(value:string){return redact(value,500)}
async function persist(path:string,value:WatchdogSnapshot){await mkdir(dirname(path),{recursive:true,mode:0o750});const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(value,null,2)+"\n",{encoding:"utf8",mode:0o600});await rename(temporary,path)}
