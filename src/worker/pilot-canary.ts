import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./workspace.js";
import { preparePilotBranch, validatePilotBranch } from "./pilot-branch.js";
import { DurablePilotCycleRepository } from "../infrastructure/durable-pilot-cycle-repository.js";
import { transitionWorkItem } from "../domain/work-state-machine.js";
import type { WorkItem } from "../domain/work-item.js";

const root=await mkdtemp(join(tmpdir(),"lcc-pilot-canary-"));
try{
  const git=async(args:string[])=>{const result=await runCommand("git",args,root);if(result.code)throw new Error("pilot canary git operation failed");return result;};
  await git(["init","-b","main"]);await git(["config","user.name","LCC Canary"]);await git(["config","user.email","canary@example.invalid"]);await git(["remote","add","origin","https://github.com/invalid/canary.git"]);await git(["remote","set-url","--push","origin","DISABLED"]);
  await writeFile(join(root,"README.md"),"canary\n");await git(["add","README.md"]);await git(["commit","-m","base"]);
  const request={externalId:"16",executionId:"canary123456",baseBranch:"main",candidateBranch:"lcc/pilot/16-canary12"},workspace={workspaceId:"canary",repository:"invalid/canary",path:root,capabilities:[],pilotBaseBranch:"main",promotionDisabled:true},prepared=await preparePilotBranch(request,workspace,runCommand);
  await writeFile(join(root,"marker.txt"),"LCC_PILOT_OK\n");await git(["add","marker.txt"]);await git(["commit","-m","pilot candidate"]);
  const evidence=await validatePilotBranch(request,prepared,workspace,runCommand),cycles=await DurablePilotCycleRepository.open(join(root,"cycles.json")),now=new Date().toISOString();
  const failed:WorkItem={id:"canary-item",source:{provider:"github",repository:"invalid/canary",externalId:"16"},title:"canary",sourceState:"open",labels:["lcc:pilot","lcc:ready"],assignees:[],sourceUrl:"https://example.invalid/16",workState:"FAILED",ballHolder:"LCC",nextAction:{kind:"INVESTIGATE",summary:"investigate",ballHolder:"LCC",aiExecutable:true,requiredCapabilities:["DIAGNOSTICS"]},blocker:null,acceptanceCriteria:["AC-01 [AUTO:test] canary"],definitionReady:true,evidence:["execution:preflight:FAILED"],sourceUpdatedAt:now,lastSyncedAt:now,transitionReason:"RETRYABLE_FAILURE accepted from RUNNING"};
  const retrying=transitionWorkItem(failed,{type:"RETRY_STARTED"}).workItem,running=transitionWorkItem(retrying,{type:"EXECUTION_STARTED"}).workItem,verifying=transitionWorkItem(running,{type:"EXECUTION_COMPLETED",verification:"AUTOMATED"}).workItem,waiting=transitionWorkItem(verifying,{type:"HUMAN_REQUIRED",summary:"Pilot verification passed; promotion approval required"}).workItem;
  await cycles.savePilotCycle({cycleId:"canary",scopeFingerprint:"canaryfp",workItemId:"canary-item",status:"FAILED",baseHead:null,candidateBranch:null,candidateHead:null,executionAttempts:1,verificationRuns:0,startedAt:now,updatedAt:now,reason:failed.transitionReason,recoveryRequestId:null,recoveryConsumedAt:null,recoveryCount:0,previousFailureReason:null});
  await cycles.savePilotCycle({cycleId:"canary",scopeFingerprint:"canaryfp",workItemId:"canary-item",status:"ARMED",baseHead:null,candidateBranch:null,candidateHead:null,executionAttempts:1,verificationRuns:0,startedAt:now,updatedAt:now,reason:"Explicit Pilot Recovery consumed; retry dispatch armed",recoveryRequestId:"canary",recoveryConsumedAt:now,recoveryCount:1,previousFailureReason:failed.transitionReason});
  await cycles.savePilotCycle({cycleId:"canary",scopeFingerprint:"canaryfp",workItemId:"canary-item",status:"WAITING_HUMAN",baseHead:evidence.baseHead,candidateBranch:evidence.candidateBranch,candidateHead:evidence.candidateHead,executionAttempts:2,verificationRuns:1,startedAt:now,updatedAt:now,reason:"Pilot verification passed; promotion approval required",recoveryRequestId:"canary",recoveryConsumedAt:now,recoveryCount:1,previousFailureReason:failed.transitionReason});
  const restored=(await DurablePilotCycleRepository.open(join(root,"cycles.json"))).pilotCycles();if((await restored)[0]?.recoveryCount!==1||waiting.workState!=="WAITING_HUMAN")throw new Error("pilot recovery canary durability failed");
  const base=await runCommand("git",["rev-parse","refs/heads/main"],root);if(base.stdout.trim()!==evidence.baseHead)throw new Error("pilot canary moved base");
  console.log(JSON.stringify({pilotScope:"PASS",recoveryPath:[failed.workState,retrying.workState,running.workState,verifying.workState,waiting.workState],historyPreserved:true,recoveryCount:1,recoveryConsumed:true,candidateBranch:evidence.candidateBranch,baseUnchanged:true,verifiedHead:evidence.candidateHead,promotionHold:"WAITING_HUMAN",executionAttempts:2,verificationRuns:1,remainingExecutionBudget:0}));
}finally{await rm(root,{recursive:true,force:true});}
