import type { CommandRunner, WorkspaceConfig } from "./workspace.js";
import { deterministicCandidateBranch } from "../domain/pilot.js";
import { sanitizeDiagnostic } from "./codex-cli.js";

export interface PilotBranchRequest { externalId:string;executionId:string;baseBranch:string;candidateBranch:string }
export interface PilotBranchEvidence { baseHead:string;candidateBranch:string;candidateHead:string }
export class PilotBranchPostconditionError extends Error{constructor(readonly evidence:string[],reason:string){super(`pilot candidate branch postconditions failed: ${reason}`);this.name="PilotBranchPostconditionError";}}

export async function preparePilotBranch(request:PilotBranchRequest,workspace:WorkspaceConfig,run:CommandRunner):Promise<{baseHead:string;candidateBranch:string}>{
  if(workspace.promotionDisabled!==true||workspace.pilotBaseBranch!==request.baseBranch)throw new Error("workspace is not allowlisted for pilot no-promotion execution");
  const expected=deterministicCandidateBranch(request.externalId,request.executionId);
  if(request.candidateBranch!==expected||request.candidateBranch===request.baseBranch)throw new Error("pilot candidate branch mismatch");
  const branch=await run("git",["branch","--show-current"],workspace.path),base=await run("git",["rev-parse",`refs/heads/${request.baseBranch}`],workspace.path),push=await run("git",["remote","get-url","--push","origin"],workspace.path),exists=await run("git",["show-ref","--verify",`refs/heads/${expected}`],workspace.path);
  if(branch.code||base.code||!safeSha(base.stdout.trim()))throw new Error("pilot must start on valid base branch");
  if(branch.stdout.trim()!==request.baseBranch){const prior=new RegExp(`^lcc/pilot/${escapeRegex(request.externalId)}-[A-Za-z0-9._-]{1,180}$`),head=await run("git",["rev-parse","HEAD"],workspace.path);if(!prior.test(branch.stdout.trim())||head.code||head.stdout.trim()!==base.stdout.trim())throw new Error("pilot previous candidate cannot be safely resumed");const restored=await run("git",["switch",request.baseBranch],workspace.path);if(restored.code)throw new Error("pilot base branch restore failed");}
  if(push.code===0&&push.stdout.trim()!=="DISABLED")throw new Error("pilot workspace promotion is not disabled");
  if(exists.code===0)throw new Error("pilot candidate branch already exists");
  const created=await run("git",["switch","-c",expected,base.stdout.trim()],workspace.path);
  if(created.code)throw new Error("pilot candidate branch creation failed");
  return{baseHead:base.stdout.trim(),candidateBranch:expected};
}

export async function validatePilotBranch(request:PilotBranchRequest,prepared:{baseHead:string;candidateBranch:string},workspace:WorkspaceConfig,run:CommandRunner):Promise<PilotBranchEvidence>{
  const branch=await run("git",["branch","--show-current"],workspace.path),head=await run("git",["rev-parse","HEAD"],workspace.path),dirty=await run("git",["status","--porcelain"],workspace.path),base=await run("git",["rev-parse",`refs/heads/${request.baseBranch}`],workspace.path),ancestor=await run("git",["merge-base","--is-ancestor",prepared.baseHead,head.stdout.trim()],workspace.path);
  const observedBranch=branch.stdout.trim(),observedHead=head.stdout.trim(),observedBase=base.stdout.trim(),status=dirty.stdout.trim(),reason=branch.code?"candidate branch unavailable":observedBranch!==prepared.candidateBranch?"unexpected candidate branch":head.code||!safeSha(observedHead)?"candidate HEAD unavailable":observedHead===prepared.baseHead?"candidate HEAD did not advance from base":dirty.code?"git status unavailable":status?"candidate worktree is not clean":base.code||observedBase!==prepared.baseHead?"base branch moved":ancestor.code?"candidate is not descended from base":null;
  if(reason)throw new PilotBranchPostconditionError([`pilot.branch=${sanitizeDiagnostic(observedBranch||"unavailable",200)}`,`pilot.baseHead=${safeSha(prepared.baseHead)?prepared.baseHead:"unavailable"}`,`pilot.observedCandidateHead=${safeSha(observedHead)?observedHead:"unavailable"}`,`pilot.gitStatus=${status?sanitizeDiagnostic(status,300):dirty.code?"unavailable":"clean"}`,`pilot.postcondition=${reason}`],reason);
  return{baseHead:prepared.baseHead,candidateBranch:prepared.candidateBranch,candidateHead:head.stdout.trim()};
}
function safeSha(value:string){return/^[0-9a-f]{7,64}$/i.test(value);}
function escapeRegex(value:string){return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
