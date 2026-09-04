import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DurableSelfCommissioningStore, SelfCommissioningOrchestrator, type CodexJob, type SelfCommissioningStep, type SupervisorJob, type SupervisorOperation } from "./self-commissioning.js";
import { summarizeRun, type SelfCommissioningRun } from "../domain/self-commissioning-run.js";
import { PersistentCodexDispatcher } from "./persistent-codex-dispatcher.js";

export const productionProfile="LCC008_REAL_ACCEPTANCE" as const;
export interface ProductionEvidenceSink { report(run:SelfCommissioningRun):Promise<void> }
export interface ProductionControlView { profile:typeof productionProfile;runId:string;objective:string;status:SelfCommissioningRun["status"];currentStep:string|null;activeActor:SelfCommissioningRun["activeActor"];activeExecutionId:string|null;completedSteps:string[];retryUsage:{limit:number;consumed:number};blocker:string|null;humanGate:string|null;updatedAt:string;ballHolder:string;ongoing:boolean }

export class ProductionSelfCommissioningControl {
  private cancelled=new Set<string>();
  private dispatcher:PersistentCodexDispatcher;
  constructor(private store:DurableSelfCommissioningStore,private orchestrator:SelfCommissioningOrchestrator,private evidence:ProductionEvidenceSink,private readiness:()=>Promise<boolean|string>,private enabled:boolean,private id:()=>string=randomUUID){this.dispatcher=new PersistentCodexDispatcher(store,orchestrator,evidence,{afterTick:async run=>this.cancelled.has(run.runId)?this.store.cancel(run.runId):run})}
  async readinessStatus(){const result=this.enabled?await this.readiness():"Self-Commissioning dispatch is disabled";return result===true?{status:"READY"as const,reason:null}:{status:"BLOCKED"as const,reason:String(result).slice(0,500)}}
  async create(value:unknown){
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==1||(value as{profile?:unknown}).profile!==productionProfile)throw Error("only allowlisted production profile is accepted");
    const runId="lcc008-"+this.id().replace(/[^A-Za-z0-9._-]/g,"").slice(0,64);
    const run=await this.orchestrator.create({runId,objective:"Complete LCC-008 AC-32 through AC-35 without Human transport",steps:profileSteps(runId),retryLimit:1});
    await this.evidence.report(run);return view(run);
  }
  async list(){return Promise.all((await this.store.list()).map(view))}
  async start(runId:string){
    const current=await this.store.get(runId);if(!current)throw Error("run not found");
    const readiness=this.enabled?await this.readiness():"Self-Commissioning dispatch is disabled";if(readiness!==true){await this.orchestrator.setKillSwitch(false);const stopped=await this.orchestrator.block(runId,typeof readiness==="string"?readiness:"Self-Commissioning readiness failed");await this.evidence.report(stopped);return view(stopped)}await this.orchestrator.setKillSwitch(true);
    if(current.status!=="QUEUED")return view(current);this.dispatcher.start(runId);
    for(let i=0;i<100;i++){const next=await this.store.get(runId);if(next&&next.status!=="QUEUED")return view(next);await new Promise(r=>setImmediate(r))}
    throw Error("actor dispatch did not start");
  }
  async cancel(runId:string){this.cancelled.add(runId);const run=await this.store.cancel(runId);await this.evidence.report(run);return view(run)}
  async resume(){if(!this.enabled||await this.readiness()!==true)return;await this.dispatcher.resume()}
  async drain(){await this.dispatcher.drain()}
}
function profileSteps(runId:string):SelfCommissioningStep[]{
  const key=(value:string)=>runId+":"+value;
  const job:CodexJob={objective:"Complete LCC-008 AC-32 through AC-35 from durable state. Inspect actual state, preserve all history, and do not require Human command or log transport.",repository:"knys/TOBIE",workspaceId:"tobie-pilot",policy:{allowCommit:true,allowPush:false,allowMerge:false,allowDeploy:false}};
  const op=(operation:SupervisorOperation):SupervisorJob=>({...job,objective:`LCC fixed supervisor operation: ${operation}`,operation});
  return[
    {stepId:"inspect-current-state",kind:"SUPERVISOR_OPERATION",job:op("INSPECT_CURRENT_STATE")},
    {stepId:"tx-reconcile",kind:"TX_OPERATION",request:{operation:"TX_LCC_RECONCILE",idempotencyKey:key("tx-reconcile")}},
    {stepId:"assert-remediation-eligibility",kind:"SUPERVISOR_OPERATION",job:op("ASSERT_REMEDIATION_ELIGIBILITY")},
    {stepId:"gtx-preflight",kind:"GTX_OPERATION",request:{operation:"GTX_WORKSPACE_PREFLIGHT",idempotencyKey:key("gtx-preflight"),workspaceId:"tobie-pilot"}},
    {stepId:"gtx-descriptor",kind:"GTX_OPERATION",request:{operation:"GTX_WORKER_DESCRIPTOR",idempotencyKey:key("gtx-descriptor")}},
    {stepId:"enable-bounded-pilot",kind:"SUPERVISOR_OPERATION",job:op("ENABLE_BOUNDED_PILOT")},
    {stepId:"codex-job",kind:"CODEX_JOB",job},
    {stepId:"observe-execution",kind:"SUPERVISOR_OPERATION",job:op("OBSERVE_EXECUTION")},
    {stepId:"independent-verification",kind:"SUPERVISOR_OPERATION",job:op("INDEPENDENT_VERIFICATION")},
    {stepId:"assert-promotion-hold",kind:"SUPERVISOR_OPERATION",job:op("ASSERT_PROMOTION_HOLD")},
    {stepId:"kill-switch",kind:"SUPERVISOR_OPERATION",job:op("KILL_SWITCH")},
    {stepId:"post-acceptance-observation",kind:"SUPERVISOR_OPERATION",job:op("POST_ACCEPTANCE_OBSERVATION")},
    {stepId:"human-gate",kind:"SUPERVISOR_OPERATION",job:op("HUMAN_GATE")}
  ];
}
function view(run:SelfCommissioningRun):ProductionControlView { const summary=summarizeRun(run);return{profile:productionProfile,runId:run.runId,objective:run.objective,status:run.status,currentStep:run.currentStep,activeActor:run.activeActor,activeExecutionId:run.activeExecutionId,completedSteps:[...run.completedSteps],retryUsage:{...run.retryBudget},blocker:run.blocker,humanGate:run.humanGate,updatedAt:run.updatedAt,ballHolder:summary.ballHolder,ongoing:summary.ongoing} }
export function validControlToken(request:IncomingMessage,expected:string){const supplied=request.headers.authorization?.replace(/^Bearer\s+/i,"")??"",a=Buffer.from(supplied),b=Buffer.from(expected);return!!expected&&a.length===b.length&&timingSafeEqual(a,b)}
