import type { WorkItem } from "./work-item.js";
import { createHash } from "node:crypto";

export type AutomationMode = "disabled" | "pilot" | "production";
export interface PilotScope { version:1;cycleId:string;repository:string;externalId:string;workerId:string;workspaceId:string;verificationProfileId:string;baseBranch:string;requiredLabels:string[];expiresAt:string;maxExecutionAttempts:number;maxVerificationRuns:number }
export interface PilotControl { mode:AutomationMode;executionEnabled:boolean;verificationEnabled:boolean;scope:PilotScope|null;enabled:boolean;reason:string }
export type PilotCycleStatus="ARMED"|"EXECUTING"|"VERIFYING"|"VERIFIED"|"WAITING_HUMAN"|"FAILED"|"EXPIRED"|"CANCELLED";
export interface PilotCycle{cycleId:string;scopeFingerprint:string;workItemId:string;status:PilotCycleStatus;baseHead:string|null;candidateBranch:string|null;candidateHead:string|null;executionAttempts:number;verificationRuns:number;startedAt:string;updatedAt:string;reason:string}

export function parsePilotControl(environment:NodeJS.ProcessEnv=process.env,now:number=Date.now()):PilotControl {
  const rawMode=environment.WORK_AUTOMATION_MODE?.trim().toLowerCase(),mode:AutomationMode=rawMode==="pilot"||rawMode==="production"?rawMode:"disabled",executionEnabled=flag(environment.WORK_EXECUTION_ENABLED),verificationEnabled=flag(environment.WORK_VERIFICATION_ENABLED);
  if(mode!=="pilot")return{mode,executionEnabled,verificationEnabled,scope:null,enabled:false,reason:mode==="production"?"production automation is reserved":"automation is disabled"};
  let raw:unknown;try{raw=JSON.parse(environment.WORK_PILOT_SCOPE_JSON??"");}catch{return disabled(mode,executionEnabled,verificationEnabled,"pilot scope is malformed");}
  const scope=validScope(raw)?structuredClone(raw):null;
  if(!scope)return disabled(mode,executionEnabled,verificationEnabled,"pilot scope must be one exact bounded object");
  if(Date.parse(scope.expiresAt)<=now)return{mode,executionEnabled,verificationEnabled,scope,enabled:false,reason:"pilot scope is expired"};
  if(!executionEnabled||!verificationEnabled)return{mode,executionEnabled,verificationEnabled,scope,enabled:false,reason:"both execution and verification flags are required"};
  return{mode,executionEnabled,verificationEnabled,scope,enabled:true,reason:"pilot is armed"};
}

export function matchesPilotScope(item:WorkItem,scope:PilotScope):boolean{return item.source.repository===scope.repository&&item.source.externalId===scope.externalId;}
export function hasPilotLabels(item:WorkItem,scope:PilotScope):boolean{const labels=new Set(item.labels.map(v=>v.toLowerCase()));return scope.requiredLabels.every(v=>labels.has(v.toLowerCase()));}
export function deterministicCandidateBranch(externalId:string,executionId:string):string{if(!/^\d{1,20}$/.test(externalId)||!/^[A-Za-z0-9._-]{1,200}$/.test(executionId))throw new Error("unsafe pilot branch identity");return`lcc/pilot/${externalId}-${executionId.slice(0,8)}`;}
export function scopeFingerprint(scope:PilotScope):string{const stable=[scope.version,scope.cycleId,scope.repository,scope.externalId,scope.workerId,scope.workspaceId,scope.verificationProfileId,scope.baseBranch,[...scope.requiredLabels].sort().join(","),scope.expiresAt,scope.maxExecutionAttempts,scope.maxVerificationRuns].join("\0");return createHash("sha256").update(stable).digest("hex");}
export function definitionReady(body:string|null|undefined):boolean{if(!body)return false;const headings=new Set([...body.matchAll(/^##\s+(.+?)\s*$/gim)].map(match=>match[1]!.trim().toLowerCase()));return["problem","outcome","scope","failure behavior","verification","execution environment"].every(value=>headings.has(value))&&/^\s*\*{0,2}Coding Ready:\s*YES\*{0,2}\s*$/im.test(body);}
export function safeSha(value:string|null):string|null{return value&&/^[0-9a-f]{7,64}$/i.test(value)?value.slice(0,64):null;}
function flag(value:string|undefined){return value?.trim().toLowerCase()==="true";}
function disabled(mode:AutomationMode,executionEnabled:boolean,verificationEnabled:boolean,reason:string):PilotControl{return{mode,executionEnabled,verificationEnabled,scope:null,enabled:false,reason};}
function validScope(value:unknown):value is PilotScope{if(!value||typeof value!=="object"||Array.isArray(value))return false;const item=value as Record<string,unknown>,keys=["version","cycleId","repository","externalId","workerId","workspaceId","verificationProfileId","baseBranch","requiredLabels","expiresAt","maxExecutionAttempts","maxVerificationRuns"];if(Object.keys(item).some(key=>!keys.includes(key))||item.version!==1)return false;for(const key of["cycleId","externalId","workerId","workspaceId","verificationProfileId","baseBranch"] as const)if(typeof item[key]!=="string"||!/^[A-Za-z0-9._-]+$/.test(item[key] as string))return false;if(typeof item.repository!=="string"||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository))return false;if(!Array.isArray(item.requiredLabels)||item.requiredLabels.length!==2||new Set(item.requiredLabels).size!==2||!item.requiredLabels.includes("lcc:pilot")||!item.requiredLabels.includes("lcc:ready"))return false;if(typeof item.expiresAt!=="string"||!Number.isFinite(Date.parse(item.expiresAt)))return false;return Number.isInteger(item.maxExecutionAttempts)&&Number(item.maxExecutionAttempts)>0&&Number(item.maxExecutionAttempts)<=3&&Number.isInteger(item.maxVerificationRuns)&&Number(item.maxVerificationRuns)>0&&Number(item.maxVerificationRuns)<=3;}
