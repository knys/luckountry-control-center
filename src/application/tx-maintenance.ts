import type { ExecutionState } from "./execution.js";
import type { VerificationState } from "../domain/verification.js";
import type { PilotCycle } from "../domain/pilot.js";
import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {redact} from "./verification.js";

export const txOperationKinds = ["TX_LCC_STATUS","TX_LCC_UPDATE_EXACT_REF","TX_LCC_BUILD_TEST","TX_LCC_DEPLOY_DISABLED","TX_LCC_RESTART","TX_LCC_MIGRATE_PILOT_STORE","TX_LCC_RECONCILE"] as const;
export type TxOperationKind=typeof txOperationKinds[number];
export type TxMaintenanceRequest={operation:TxOperationKind;idempotencyKey:string;exactRef?:string};
export interface TxCommand{executable:string;args:readonly string[];cwd:string;timeoutMs:number}
export interface TxCommandOutput{code:number;stdout:string;stderr:string}
export interface TxCommandRunner{run(command:TxCommand):Promise<TxCommandOutput>}
export interface TxMaintenanceResult{idempotencyKey:string;operation:TxOperationKind;status:"RUNNING"|"SUCCEEDED"|"FAILED"|"TIMED_OUT";startedAt:string;finishedAt:string|null;summary:string;evidence:string[]}
export interface TxMaintenanceContext{repositoryPath:string;allowedRepository:string;allowedRefs:readonly string[];storePath:string;runner:TxCommandRunner;status():Promise<string[]>;migrate():Promise<string[]>;reconcile():Promise<string[]>;now?:()=>number}
export interface TxPilotCycleStore{pilotCycles():Promise<PilotCycle[]>;savePilotCycle(cycle:PilotCycle):Promise<void>}
interface Store{version:1;results:TxMaintenanceResult[]}
const maxOutput=500,maxEvidence=20,maxTimeout=20*60_000;

export class TxMaintenanceService{
  private readonly inflight=new Map<string,Promise<TxMaintenanceResult>>();
  constructor(private readonly context:TxMaintenanceContext){}
  async execute(value:unknown):Promise<TxMaintenanceResult>{
    const request=parseRequest(value,this.context.allowedRefs),key=request.idempotencyKey;
    const active=this.inflight.get(key);if(active)return active;
    const operation=this.executeOnce(request);this.inflight.set(key,operation);
    try{return await operation;}finally{this.inflight.delete(key);}
  }
  private async executeOnce(request:TxMaintenanceRequest):Promise<TxMaintenanceResult>{
    const store=await loadStore(this.context.storePath),existing=store.results.find(item=>item.idempotencyKey===request.idempotencyKey);
    if(existing&&existing.operation!==request.operation)throw new Error("idempotency key operation mismatch rejected");
    if(existing&&existing.status!=="RUNNING")return structuredClone(existing);
    const now=this.context.now??Date.now,startedAt=existing?.startedAt??new Date(now()).toISOString(),running:TxMaintenanceResult={idempotencyKey:request.idempotencyKey,operation:request.operation,status:"RUNNING",startedAt,finishedAt:null,summary:"Fixed TX maintenance operation is executing",evidence:[]};
    await saveResult(this.context.storePath,store,running);
    let result:TxMaintenanceResult;
    try{
      const evidence=await this.perform(request),finishedAt=new Date(now()).toISOString();
      result={...running,status:"SUCCEEDED",finishedAt,summary:`${request.operation} completed`,evidence:sanitizeEvidence(evidence)};
    }catch(error){const timedOut=error instanceof Error&&error.message==="bounded operation timeout";result={...running,status:timedOut?"TIMED_OUT":"FAILED",finishedAt:new Date(now()).toISOString(),summary:safe(error instanceof Error?error.message:"fixed operation failed"),evidence:[]};}
    await saveResult(this.context.storePath,await loadStore(this.context.storePath),result);return structuredClone(result);
  }
  private async perform(request:TxMaintenanceRequest):Promise<string[]>{
    if(request.operation==="TX_LCC_STATUS")return sanitizeEvidence(await bounded(this.context.status(),10_000));
    if(request.operation==="TX_LCC_MIGRATE_PILOT_STORE")return sanitizeEvidence(await bounded(this.context.migrate(),30_000));
    if(request.operation==="TX_LCC_RECONCILE")return sanitizeEvidence(await bounded(this.context.reconcile(),30_000));
    const evidence:string[]=[];for(const command of commandPlan(request,this.context)){const output=await bounded(this.context.runner.run(command),command.timeoutMs);evidence.push(`${command.executable} ${command.args.join(" ")}: exit=${output.code}`,output.stdout,output.stderr);if(output.code!==0)throw new Error(`${request.operation} fixed command failed with exit ${output.code}`);}return sanitizeEvidence(evidence);
  }
}

export function reconcilePilotCycle(cycle:PilotCycle,execution:ExecutionState,verification:VerificationState,workState:string,now:string):PilotCycle{
  const records=execution.records.filter(item=>item.workItemId===cycle.workItemId),checks=verification.records.filter(item=>item.workItemId===cycle.workItemId),latest=[...records].sort((a,b)=>a.attempt-b.attempt).at(-1),verified=[...checks].at(-1);
  const status=workState==="FAILED"?"FAILED":workState==="WAITING_HUMAN"?"WAITING_HUMAN":workState==="VERIFYING"?"VERIFYING":workState==="RUNNING"?"EXECUTING":workState==="RETRYING"?"ARMED":verified?.status==="PASSED"?"WAITING_HUMAN":cycle.status;
  return{...cycle,status,executionAttempts:records.length,verificationRuns:checks.length,baseHead:latest?.baseHead??cycle.baseHead,candidateBranch:latest?.candidateBranch??cycle.candidateBranch,candidateHead:latest?.candidateHead??cycle.candidateHead,updatedAt:now,reason:`Reconciled from durable execution (${records.length}) and verification (${checks.length}) history`};
}
export async function reconcilePilotStore(cycles:TxPilotCycleStore,execution:ExecutionState,verification:VerificationState,workState:(workItemId:string)=>Promise<string|null>,now:string):Promise<string[]>{const evidence:string[]=[];for(const cycle of await cycles.pilotCycles()){const state=await workState(cycle.workItemId);if(!state){evidence.push(`${cycle.cycleId}: WorkItem unavailable; unchanged`);continue;}const next=reconcilePilotCycle(cycle,execution,verification,state,now);await cycles.savePilotCycle(next);evidence.push(`${cycle.cycleId}: status=${next.status} executionAttempts=${next.executionAttempts} verificationRuns=${next.verificationRuns}`);}return sanitizeEvidence(evidence);}

function parseRequest(value:unknown,allowedRefs:readonly string[]):TxMaintenanceRequest{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("unknown TX maintenance request rejected");const raw=value as Record<string,unknown>,operation=raw.operation;if(typeof operation!=="string"||!txOperationKinds.includes(operation as TxOperationKind))throw new Error("unknown operation rejected");const allowedKeys=operation==="TX_LCC_UPDATE_EXACT_REF"?["operation","idempotencyKey","exactRef"]:["operation","idempotencyKey"];if(Object.keys(raw).some(key=>!allowedKeys.includes(key)))throw new Error("arbitrary command, cwd, or environment rejected");if(typeof raw.idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{1,200}$/.test(raw.idempotencyKey))throw new Error("invalid idempotency key rejected");if(operation==="TX_LCC_UPDATE_EXACT_REF"){if(typeof raw.exactRef!=="string"||!/^[0-9a-f]{40}$/i.test(raw.exactRef)||!allowedRefs.includes(raw.exactRef))throw new Error("exact ref is not allowlisted");return{operation,idempotencyKey:raw.idempotencyKey,exactRef:raw.exactRef};}if(raw.exactRef!==undefined)throw new Error("exact ref rejected for this operation");return{operation:operation as TxOperationKind,idempotencyKey:raw.idempotencyKey};}
function commandPlan(request:TxMaintenanceRequest,context:TxMaintenanceContext):TxCommand[]{const cwd=resolve(context.repositoryPath),fixed=(executable:string,args:string[],timeoutMs:number):TxCommand=>({executable,args,cwd,timeoutMs:Math.min(timeoutMs,maxTimeout)});switch(request.operation){case"TX_LCC_UPDATE_EXACT_REF":return[fixed("/usr/bin/git",["fetch","--no-tags","origin",request.exactRef!],120_000),fixed("/usr/bin/git",["checkout","--detach",request.exactRef!],30_000)];case"TX_LCC_BUILD_TEST":return[["ci"],["run","clean"],["run","build:test"],["test"],["run","typecheck"],["run","build"]].map(args=>fixed("/usr/bin/npm",args,20*60_000)).concat(fixed("/usr/bin/git",["diff","--check"],30_000));case"TX_LCC_DEPLOY_DISABLED":return[fixed("/usr/bin/systemctl",["set-environment","WORK_AUTOMATION_MODE=disabled","WORK_EXECUTION_ENABLED=false","WORK_VERIFICATION_ENABLED=false"],10_000),fixed("/usr/bin/sudo",["-n","/usr/local/libexec/lcc-tx-maintenance","TX_LCC_DEPLOY_DISABLED",context.allowedRepository],120_000)];case"TX_LCC_RESTART":return[fixed("/usr/bin/sudo",["-n","/usr/local/libexec/lcc-tx-maintenance","TX_LCC_RESTART",context.allowedRepository],30_000)];default:return[];}}
async function loadStore(path:string):Promise<Store>{try{const value=JSON.parse(await readFile(path,"utf8")) as Store;if(value.version!==1||!Array.isArray(value.results))throw new Error("invalid TX maintenance store");return value;}catch(error){if(error instanceof Error&&"code"in error&&(error as NodeJS.ErrnoException).code==="ENOENT")return{version:1,results:[]};throw error;}}
async function saveResult(path:string,store:Store,result:TxMaintenanceResult){const next:Store={version:1,results:[...store.results.filter(item=>item.idempotencyKey!==result.idempotencyKey),structuredClone(result)]};await mkdir(dirname(path),{recursive:true,mode:0o750});const temporary=`${path}.${randomUUID()}.tmp`;await writeFile(temporary,`${JSON.stringify(next,null,2)}\n`,{encoding:"utf8",mode:0o600});await rename(temporary,path);}
function safe(value:string){return redact(value,maxOutput).replace(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g,"[PATH]");}
function sanitizeEvidence(values:readonly string[]){return values.flatMap(value=>value.split(/\r?\n/)).filter(Boolean).slice(-maxEvidence).map(safe);}
async function bounded<T>(promise:Promise<T>,timeoutMs:number):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("bounded operation timeout")),Math.min(timeoutMs,maxTimeout));})]);}finally{if(timer)clearTimeout(timer);}}
