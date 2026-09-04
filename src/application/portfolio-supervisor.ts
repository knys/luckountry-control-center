import type{CommissionCandidate,CommissionRunRegistrar}from"./commission-inbox.js";
import{DurableSelfCommissioningStore,failureRevision}from"./self-commissioning.js";
import type{SelfCommissioningRun}from"../domain/self-commissioning-run.js";

export const portfolioPolicy={reconcileIntervalMs:5*60_000,staleMs:15*60_000,retryLimit:3,cooldownMs:30*60_000,dailyLimit:3}as const;
export const portfolioFailureTypes=["TRANSIENT_EXTERNAL","SERVICE_DOWN","WATCHER_DOWN","ACTOR_LOST","RUN_STALE","DISPATCH_FAILURE","CODEX_FAILURE","TEST_FAILURE","CI_FAILURE","MERGE_CONFLICT","DEPLOY_FAILURE","REVISION_MISMATCH","STATE_CORRUPTION","AUTH_EXPIRED","CODE_FIX_REQUIRED","GENUINE_HUMAN_GATE"]as const;
export type PortfolioFailure=typeof portfolioFailureTypes[number];
export interface PortfolioReconcileResult{repairedMissing:string[];recovered:string[];isolated:string[];runnable:string[]}

export function classifyPortfolioFailure(run:SelfCommissioningRun):PortfolioFailure{
  if(run.status==="WAITING_HUMAN")return"GENUINE_HUMAN_GATE";
  const value=`${run.blocker??""} ${JSON.stringify(run.history.slice(-3))}`.toLowerCase();
  if(/auth|credential|401|403/.test(value))return"AUTH_EXPIRED";
  if(/merge conflict|non-fast-forward/.test(value))return"MERGE_CONFLICT";
  if(/deploy|health canary/.test(value))return"DEPLOY_FAILURE";
  if(/\bci\b|required checks/.test(value))return"CI_FAILURE";
  if(/test|typecheck|build|independent check/.test(value))return"TEST_FAILURE";
  if(/codex/.test(value))return"CODEX_FAILURE";
  if(/dispatch|queue/.test(value))return"DISPATCH_FAILURE";
  if(/revision|candidate head|base head/.test(value))return"REVISION_MISMATCH";
  if(/state|checkpoint|corrupt/.test(value))return"STATE_CORRUPTION";
  if(/timeout|rate.limit|network|temporary/.test(value))return"TRANSIENT_EXTERNAL";
  return"CODE_FIX_REQUIRED";
}

const recoverable=new Set<PortfolioFailure>(["TRANSIENT_EXTERNAL","ACTOR_LOST","RUN_STALE","DISPATCH_FAILURE","CODEX_FAILURE","TEST_FAILURE","CI_FAILURE","MERGE_CONFLICT","DEPLOY_FAILURE","CODE_FIX_REQUIRED"]);
export class PortfolioSupervisor{
  constructor(private store:DurableSelfCommissioningStore,private registrar:CommissionRunRegistrar,private now:()=>number=Date.now){}
  async reconcile(items:readonly CommissionCandidate[]):Promise<PortfolioReconcileResult>{
    const repairedMissing:string[]=[],recovered:string[]=[],isolated:string[]=[];
    const commissioned=items.filter(v=>v.commissionState==="COMMISSIONED"&&v.runId);
    for(const item of commissioned)if(!await this.store.get(item.runId!)){await this.registrar.register(item,item.runId!);repairedMissing.push(item.runId!)}
    // A registrar may use another process-safe store instance. The caller must
    // reopen the SSOT before applying recovery mutations, avoiding stale writes.
    if(repairedMissing.length)return{repairedMissing,recovered,isolated,runnable:[]};
    for(const item of commissioned){
      const run=await this.store.get(item.runId!);
      if(!run)continue;
      if(run.status==="RUNNING"&&this.now()-Date.parse(run.updatedAt)>=portfolioPolicy.staleMs){
        try{await this.store.recoverInterrupted(run.runId,{reason:"RUN_STALE/ACTOR_LOST: durable checkpoint resume",staleBefore:new Date(this.now()-portfolioPolicy.staleMs).toISOString()});recovered.push(run.runId)}catch{isolated.push(run.runId)}
      }else if(run.status==="BLOCKED"){
        const failure=classifyPortfolioFailure(run);
        if(recoverable.has(failure)&&run.recoveryBudget.consumed<run.recoveryBudget.limit){
          try{await this.store.recover(run.runId,{actor:"LCC",reason:`${failure}: policy recovery`,expectedFailure:failureRevision(run)});recovered.push(run.runId)}catch{isolated.push(run.runId)}
        }else isolated.push(run.runId);
      }else if(run.status==="WAITING_HUMAN")isolated.push(run.runId);
    }
    const runs=await this.store.list(),completed=new Set(items.filter(v=>v.commissionState==="COMPLETED").map(v=>v.id));
    const runnable=items.filter(v=>v.commissionState==="COMMISSIONED"&&v.runId&&v.dependsOn.every(id=>completed.has(id))&&runs.some(r=>r.runId===v.runId&&r.status==="QUEUED")).sort((a,b)=>b.priority-a.priority||a.detectedAt.localeCompare(b.detectedAt)).map(v=>v.runId!);
    return{repairedMissing,recovered,isolated:[...new Set(isolated)],runnable};
  }
}
