import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutomaticEvidenceReporter, DurableEvidenceOutbox } from "./evidence-reporting.js";
import type { SelfCommissioningRun } from "../domain/self-commissioning-run.js";

const directory=await mkdtemp(join(tmpdir(),"lcc-evidence-canary-"));
try {
  const posts:number[]=[],run:SelfCommissioningRun={runId:"synthetic-evidence",objective:"Prove automatic GitHub evidence flow",status:"BLOCKED",currentStep:"synthetic",activeActor:null,activeExecutionId:null,queuedActor:null,queuedStep:null,startedAt:"a",updatedAt:"b",completedSteps:["tx","gtx"],failedStep:"synthetic",blocker:"synthetic policy stop",humanGate:null,retryBudget:{limit:1,consumed:1},history:[]};
  const path=join(directory,"outbox.json"),transport={postComment:async(_repository:string,number:number,_body:string)=>{posts.push(number);return{commentId:String(number)}}};
  const reporter=new AutomaticEvidenceReporter(await DurableEvidenceOutbox.open(path),transport,{repository:"knys/luckountry-control-center",issueNumber:18,pullNumber:19},2);
  const source=[{kind:"CONTROLLER"as const,status:"BLOCKED",summary:"synthetic"},{kind:"CODEX"as const,status:"FAILED",summary:"bounded failure",finalAgentMessage:"synthetic final"}];
  const first=await reporter.collectAndReport(run,source),restored=new AutomaticEvidenceReporter(await DurableEvidenceOutbox.open(path),transport,{repository:"knys/luckountry-control-center",issueNumber:18,pullNumber:19},2),second=await restored.collectAndReport(run,source);
  assert.equal(first.evidenceId,second.evidenceId);assert.deepEqual(posts,[18,19]);assert.match(first.body,/ballHolder: NONE/);assert.match(first.body,/synthetic policy stop/);
  console.log(JSON.stringify({status:"PASS",evidenceId:first.evidenceId,targets:posts,restartDuplicatePrevented:true}));
} finally { await rm(directory,{recursive:true,force:true}); }
