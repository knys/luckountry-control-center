import type { CommandRunner, WorkspaceConfig } from "./workspace.js";
import { deterministicCandidateBranch } from "../domain/pilot.js";

export interface PilotBranchRequest { externalId:string;executionId:string;baseBranch:string;candidateBranch:string }
export interface PilotBranchEvidence { baseHead:string;candidateBranch:string;candidateHead:string }

export async function preparePilotBranch(request:PilotBranchRequest,workspace:WorkspaceConfig,run:CommandRunner):Promise<{baseHead:string;candidateBranch:string}>{
  if(workspace.promotionDisabled!==true||workspace.pilotBaseBranch!==request.baseBranch)throw new Error("workspace is not allowlisted for pilot no-promotion execution");
  const expected=deterministicCandidateBranch(request.externalId,request.executionId);
  if(request.candidateBranch!==expected||request.candidateBranch===request.baseBranch)throw new Error("pilot candidate branch mismatch");
  const branch=await run("git",["branch","--show-current"],workspace.path),base=await run("git",["rev-parse",`refs/heads/${request.baseBranch}`],workspace.path),push=await run("git",["remote","get-url","--push","origin"],workspace.path),exists=await run("git",["show-ref","--verify",`refs/heads/${expected}`],workspace.path);
  if(branch.code||branch.stdout.trim()!==request.baseBranch||base.code||!safeSha(base.stdout.trim()))throw new Error("pilot must start on valid base branch");
  if(push.code===0&&push.stdout.trim()!=="DISABLED")throw new Error("pilot workspace promotion is not disabled");
  if(exists.code===0)throw new Error("pilot candidate branch already exists");
  const created=await run("git",["switch","-c",expected,base.stdout.trim()],workspace.path);
  if(created.code)throw new Error("pilot candidate branch creation failed");
  return{baseHead:base.stdout.trim(),candidateBranch:expected};
}

export async function validatePilotBranch(request:PilotBranchRequest,prepared:{baseHead:string;candidateBranch:string},workspace:WorkspaceConfig,run:CommandRunner):Promise<PilotBranchEvidence>{
  const branch=await run("git",["branch","--show-current"],workspace.path),head=await run("git",["rev-parse","HEAD"],workspace.path),dirty=await run("git",["status","--porcelain"],workspace.path),base=await run("git",["rev-parse",`refs/heads/${request.baseBranch}`],workspace.path),ancestor=await run("git",["merge-base","--is-ancestor",prepared.baseHead,head.stdout.trim()],workspace.path);
  if(branch.code||branch.stdout.trim()!==prepared.candidateBranch||head.code||!safeSha(head.stdout.trim())||head.stdout.trim()===prepared.baseHead||dirty.code||dirty.stdout.trim()||base.code||base.stdout.trim()!==prepared.baseHead||ancestor.code)throw new Error("pilot candidate branch postconditions failed");
  return{baseHead:prepared.baseHead,candidateBranch:prepared.candidateBranch,candidateHead:head.stdout.trim()};
}
function safeSha(value:string){return/^[0-9a-f]{7,64}$/i.test(value);}
