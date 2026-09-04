import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutomaticEvidenceReporter, DurableEvidenceOutbox } from "./evidence-reporting.js";
import { DurableSelfCommissioningStore, SelfCommissioningOrchestrator, type CommissioningExecutors } from "./self-commissioning.js";
import { ProductionSelfCommissioningControl } from "./production-self-commissioning.js";

const directory=await mkdtemp(join(tmpdir(),"lcc-production-wiring-"));
try {
  const calls:string[]=[],posts:number[]=[],storePath=join(directory,"runs.json"),store=await DurableSelfCommissioningStore.open(storePath),transport={postComment:async(_repository:string,number:number,_body:string)=>{posts.push(number);return{commentId:String(number)}}},reporter=new AutomaticEvidenceReporter(await DurableEvidenceOutbox.open(join(directory,"outbox.json")),transport,{repository:"knys/luckountry-control-center",issueNumber:18,pullNumber:19},2);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),executors:CommissioningExecutors={tx:async request=>{calls.push(request.operation);return{status:"SUCCEEDED",summary:"tx",evidence:[]}},gtx:async request=>{calls.push(request.operation);return{status:"SUCCEEDED",summary:"gtx",evidence:[]}},codex:async()=>{calls.push("CODEX_JOB");await gate;return{status:"SUCCEEDED",summary:"codex",evidence:[]}}},orchestrator=new SelfCommissioningOrchestrator(store,executors),control=new ProductionSelfCommissioningControl(store,orchestrator,{report:run=>reporter.collectAndReport(run,[{kind:"CONTROLLER",status:run.status,summary:"production wiring canary"}]).then(()=>undefined)},async()=>true,true,()=>"canary");
  const created=await control.create({profile:"LCC008_REAL_ACCEPTANCE"}),started=await control.start(created.runId);assert.equal(started.status,"RUNNING");assert.ok(started.activeActor);const duplicate=await control.start(created.runId);assert.equal(duplicate.activeExecutionId,started.activeExecutionId);while(!calls.includes("CODEX_JOB"))await new Promise(resolve=>setImmediate(resolve));release();for(;;){const [run]=await control.list();if(run?.status==="SUCCEEDED")break;await new Promise(resolve=>setImmediate(resolve));}
  await reporter.flush();
  while(!posts.includes(18)||!posts.includes(19))await new Promise(resolve=>setImmediate(resolve));
  await control.drain();
  const restoredStore=await DurableSelfCommissioningStore.open(storePath);assert.equal((await restoredStore.list())[0]?.status,"SUCCEEDED");assert.deepEqual(calls.slice(0,6),["TX_LCC_STATUS","TX_LCC_MIGRATE_PILOT_STORE","TX_LCC_RECONCILE","GTX_WORKER_STATUS","GTX_WORKER_DESCRIPTOR","GTX_WORKSPACE_PREFLIGHT"]);assert.equal(calls.filter(value=>value==="TX_LCC_STATUS").length,1);
  console.log(JSON.stringify({status:"PASS",profile:"LCC008_REAL_ACCEPTANCE",actorObserved:started.activeActor,terminal:"SUCCEEDED",fixedDispatch:true,evidenceDelivery:true,restartRestored:true,duplicateStartPrevented:true}));
} finally { await rm(directory,{recursive:true,force:true}); }
