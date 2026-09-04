import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutomaticEvidenceReporter, DurableEvidenceOutbox } from "./evidence-reporting.js";
import { DurableSelfCommissioningStore, SelfCommissioningOrchestrator, type CommissioningExecutors } from "./self-commissioning.js";
import { ProductionSelfCommissioningControl } from "./production-self-commissioning.js";
import { composeProductionSelfCommissioning } from "../production-self-commissioning-composition.js";

const directory=await mkdtemp(join(tmpdir(),"lcc-production-wiring-"));
try {
  const calls:string[]=[],posts:number[]=[],storePath=join(directory,"runs.json"),store=await DurableSelfCommissioningStore.open(storePath),transport={postComment:async(_repository:string,number:number,_body:string)=>{posts.push(number);return{commentId:String(number)}}},reporter=new AutomaticEvidenceReporter(await DurableEvidenceOutbox.open(join(directory,"outbox.json")),transport,{repository:"knys/luckountry-control-center",issueNumber:18,pullNumber:19},2);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),executors:CommissioningExecutors={tx:async request=>{calls.push(request.operation);return{status:"SUCCEEDED",summary:"tx",evidence:[]}},gtx:async request=>{calls.push(request.operation);return{status:"SUCCEEDED",summary:"gtx",evidence:[]}},codex:async job=>{if("operation"in job){calls.push(job.operation);return job.operation==="HUMAN_GATE"?{status:"WAITING_HUMAN",summary:"promotion",evidence:[],humanGate:"promotion only"}:{status:"SUCCEEDED",summary:"supervisor",evidence:[]}}calls.push("CODEX_JOB");await gate;return{status:"SUCCEEDED",summary:"codex",evidence:[]}}},orchestrator=new SelfCommissioningOrchestrator(store,executors),control=new ProductionSelfCommissioningControl(store,orchestrator,{report:run=>reporter.collectAndReport(run,[{kind:"CONTROLLER",status:run.status,summary:"production wiring canary"}]).then(()=>undefined)},async()=>true,true,()=>"canary");
  const created=await control.create({profile:"LCC008_REAL_ACCEPTANCE"}),started=await control.start(created.runId);assert.equal(started.status,"RUNNING");assert.ok(started.activeActor);const duplicate=await control.start(created.runId);assert.equal(duplicate.activeExecutionId,started.activeExecutionId);while(!calls.includes("CODEX_JOB"))await new Promise(resolve=>setImmediate(resolve));release();for(;;){const [run]=await control.list();if(run?.status==="WAITING_HUMAN")break;await new Promise(resolve=>setImmediate(resolve));}
  await reporter.flush();
  while(!posts.includes(18)||!posts.includes(19))await new Promise(resolve=>setImmediate(resolve));
  await control.drain();
  const composition=await composeProductionSelfCommissioning({executionState:async()=>({leases:[],records:[]}),verificationState:async()=>({leases:[],records:[]}),findWorkItem:async()=>null} as never,{LCC_DATA_DIRECTORY:join(directory,"production"),WORK_PILOT_STATE_PATH:join(directory,"production","pilot.json"),LCC_REPOSITORY_PATH:directory,WORK_AUTOMATION_MODE:"disabled",WORK_EXECUTION_ENABLED:"false",WORK_VERIFICATION_ENABLED:"false",SELF_COMMISSIONING_ENABLED:"true"});assert.match(String(await composition.readiness()),/authentication is not configured/);
  const restoredStore=await DurableSelfCommissioningStore.open(storePath);assert.equal((await restoredStore.list())[0]?.status,"WAITING_HUMAN");assert.deepEqual(calls.slice(0,6),["INSPECT_CURRENT_STATE","TX_LCC_RECONCILE","ASSERT_REMEDIATION_ELIGIBILITY","GTX_WORKSPACE_PREFLIGHT","GTX_WORKER_DESCRIPTOR","ENABLE_BOUNDED_PILOT"]);assert.equal(calls.filter(value=>value==="INSPECT_CURRENT_STATE").length,1);
  console.log(JSON.stringify({status:"PASS",profile:"LCC008_REAL_ACCEPTANCE",actorObserved:started.activeActor,terminal:"WAITING_HUMAN",fixedDispatch:true,evidenceDelivery:true,restartRestored:true,duplicateStartPrevented:true,productionComposition:true,disabledFirst:true,readinessFailClosed:true,promotionGate:true}));
} finally { await rm(directory,{recursive:true,force:true}); }
