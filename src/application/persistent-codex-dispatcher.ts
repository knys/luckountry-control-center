import type{SelfCommissioningRun}from"../domain/self-commissioning-run.js";
import{DurableSelfCommissioningStore,SelfCommissioningOrchestrator}from"./self-commissioning.js";

export interface DispatcherEvidenceSink{report(run:SelfCommissioningRun):Promise<void>}
export interface PersistentDispatcherOptions{afterTick?(run:SelfCommissioningRun):Promise<SelfCommissioningRun>}

export class PersistentCodexDispatcher{
  private active=new Map<string,Promise<void>>();
  constructor(private store:DurableSelfCommissioningStore,private orchestrator:SelfCommissioningOrchestrator,private evidence:DispatcherEvidenceSink,private options:PersistentDispatcherOptions={}){}
  start(runId:string){if(this.active.has(runId))return;const work=this.drive(runId).finally(()=>this.active.delete(runId));this.active.set(runId,work)}
  async resume(){for(const run of await this.store.list())if(run.status==="QUEUED")this.start(run.runId)}
  async drain(){await Promise.allSettled([...this.active.values()])}
  isActive(runId:string){return this.active.has(runId)}
  private async drive(runId:string){for(;;){const before=await this.store.get(runId);if(!before||before.status!=="QUEUED")return;let after=await this.orchestrator.tick(runId);if(this.options.afterTick)after=await this.options.afterTick(after);await this.evidence.report(after);if(after.status!=="QUEUED")return}}
}
