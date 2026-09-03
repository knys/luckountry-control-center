import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./workspace.js";
import { preparePilotBranch, validatePilotBranch } from "./pilot-branch.js";
import { DurablePilotCycleRepository } from "../infrastructure/durable-pilot-cycle-repository.js";

const root=await mkdtemp(join(tmpdir(),"lcc-pilot-canary-"));
try{
  const git=async(args:string[])=>{const result=await runCommand("git",args,root);if(result.code)throw new Error("pilot canary git operation failed");return result;};
  await git(["init","-b","main"]);await git(["config","user.name","LCC Canary"]);await git(["config","user.email","canary@example.invalid"]);await git(["remote","add","origin","https://github.com/invalid/canary.git"]);await git(["remote","set-url","--push","origin","DISABLED"]);
  await writeFile(join(root,"README.md"),"canary\n");await git(["add","README.md"]);await git(["commit","-m","base"]);
  const request={externalId:"16",executionId:"canary123456",baseBranch:"main",candidateBranch:"lcc/pilot/16-canary12"},workspace={workspaceId:"canary",repository:"invalid/canary",path:root,capabilities:[],pilotBaseBranch:"main",promotionDisabled:true},prepared=await preparePilotBranch(request,workspace,runCommand);
  await writeFile(join(root,"marker.txt"),"LCC_PILOT_OK\n");await git(["add","marker.txt"]);await git(["commit","-m","pilot candidate"]);
  const evidence=await validatePilotBranch(request,prepared,workspace,runCommand),cycles=await DurablePilotCycleRepository.open(join(root,"cycles.json")),now=new Date().toISOString();
  await cycles.savePilotCycle({cycleId:"canary",scopeFingerprint:"canaryfp",workItemId:"canary-item",status:"WAITING_HUMAN",baseHead:evidence.baseHead,candidateBranch:evidence.candidateBranch,candidateHead:evidence.candidateHead,executionAttempts:1,verificationRuns:1,startedAt:now,updatedAt:now,reason:"Pilot verification passed; promotion approval required"});
  const base=await runCommand("git",["rev-parse","refs/heads/main"],root);if(base.stdout.trim()!==evidence.baseHead)throw new Error("pilot canary moved base");
  console.log(JSON.stringify({pilotScope:"PASS",candidateBranch:evidence.candidateBranch,baseUnchanged:true,verifiedHead:evidence.candidateHead,promotionHold:"WAITING_HUMAN",executionAttempts:1,verificationRuns:1}));
}finally{await rm(root,{recursive:true,force:true});}
