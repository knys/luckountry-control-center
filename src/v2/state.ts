import { randomUUID } from "node:crypto";

export const jobStates=["DISCOVERED","ELIGIBLE","QUEUED","LEASED","ACTIVE","VERIFYING","MERGING","DEPLOYING","COMPLETED","WAITING_HUMAN","BLOCKED","FAILED_RETRYABLE","FAILED_FINAL"] as const;
export type JobState=typeof jobStates[number];
export interface HumanGate{question:string;reason:string;releaseCondition:string}
export interface V2Job{
  jobId:string;issueId:string;repository:string;product:string;issueNumber:number;issueUrl:string;title:string;sourceRevision:string;
  state:JobState;leaseId:string|null;leaseExpiresAt:string|null;pid:number|null;processStartedAt:string|null;heartbeatAt:string|null;
  currentAction:string;nextAction:string|null;retryCount:number;retryLimit:number;branch:string|null;commitSha:string|null;prNumber:number|null;
  prUrl:string|null;ciStatus:"PENDING"|"PASS"|"FAIL"|null;mainSha:string|null;deployedSha:string|null;healthStatus:"PENDING"|"PASS"|"FAIL"|null;deploymentEvidence:string|null;humanGate:HumanGate|null;failure:string|null;
  discoveredAt:string;updatedAt:string;history:{at:string;from:JobState|null;to:JobState;summary:string}[];
}
export interface V2Snapshot{version:2;automationEnabled:boolean;stopReason:string|null;supervisorId:string;heartbeatAt:string|null;jobs:V2Job[]}
export function newSnapshot():V2Snapshot{return{version:2,automationEnabled:true,stopReason:null,supervisorId:`supervisor-${randomUUID()}`,heartbeatAt:null,jobs:[]}}
export function newJob(input:Pick<V2Job,"issueId"|"repository"|"issueNumber"|"issueUrl"|"title"|"sourceRevision">&{product?:string|undefined},now=new Date().toISOString()):V2Job{return{...input,product:input.product??input.repository,jobId:`job-${randomUUID()}`,state:"DISCOVERED",leaseId:null,leaseExpiresAt:null,pid:null,processStartedAt:null,heartbeatAt:null,currentAction:"Issue discovered",nextAction:"Check eligibility",retryCount:0,retryLimit:3,branch:null,commitSha:null,prNumber:null,prUrl:null,ciStatus:null,mainSha:null,deployedSha:null,healthStatus:null,deploymentEvidence:null,humanGate:null,failure:null,discoveredAt:now,updatedAt:now,history:[{at:now,from:null,to:"DISCOVERED",summary:"GitHub Issue discovered"}]}}
export function transition(job:V2Job,to:JobState,summary:string,patch:Partial<V2Job>={},now=new Date().toISOString()):V2Job{
  const allowed:Record<JobState,JobState[]>={DISCOVERED:["ELIGIBLE","BLOCKED"],ELIGIBLE:["QUEUED","BLOCKED"],QUEUED:["LEASED"],LEASED:["ACTIVE","DEPLOYING","FAILED_RETRYABLE","FAILED_FINAL"],ACTIVE:["VERIFYING","FAILED_RETRYABLE","FAILED_FINAL","WAITING_HUMAN"],VERIFYING:["MERGING","FAILED_RETRYABLE","FAILED_FINAL"],MERGING:["DEPLOYING","COMPLETED","FAILED_RETRYABLE","FAILED_FINAL"],DEPLOYING:["COMPLETED","FAILED_RETRYABLE","FAILED_FINAL"],COMPLETED:[],WAITING_HUMAN:["QUEUED","FAILED_FINAL"],BLOCKED:["QUEUED","FAILED_FINAL"],FAILED_RETRYABLE:["QUEUED","FAILED_FINAL"],FAILED_FINAL:[]};
  if(!allowed[job.state].includes(to))throw new Error(`invalid v2 transition ${job.state}->${to}`);
  const value={...job,...patch,state:to,updatedAt:now,history:[...job.history,{at:now,from:job.state,to,summary}]};assertJob(value);return value;
}
export function assertJob(job:V2Job){
  if(!jobStates.includes(job.state)||!job.jobId||!job.issueId||job.retryCount<0||job.retryCount>job.retryLimit)throw new Error("invalid v2 job");
  if(["LEASED","ACTIVE","VERIFYING","MERGING","DEPLOYING"].includes(job.state)&&(!job.leaseId||!job.leaseExpiresAt))throw new Error("live state requires lease");
  if(job.state==="ACTIVE"&&(!job.pid||!job.heartbeatAt))throw new Error("ACTIVE requires process pid and heartbeat");
  if(job.state==="WAITING_HUMAN"&&(!job.humanGate?.question||!job.humanGate.reason||!job.humanGate.releaseCondition))throw new Error("Human Gate requires question, reason, and release condition");
  if(job.state!=="WAITING_HUMAN"&&job.humanGate)throw new Error("Human Gate only valid while waiting");
  if(job.state==="COMPLETED"&&(!job.mainSha||!job.prNumber||job.ciStatus!=="PASS"))throw new Error("COMPLETED requires PR, CI PASS, and main SHA");
  if(job.state==="COMPLETED"&&job.repository==="knys/luckountry-control-center"&&(job.healthStatus!=="PASS"||job.deployedSha!==job.mainSha))throw new Error("LCC COMPLETED requires healthy deployed main SHA");
}
export function dashboard(snapshot:V2Snapshot,processAlive:(pid:number)=>boolean=defaultAlive,now=Date.now()){
  const jobs=snapshot.jobs.map(job=>{const leaseValid=!!job.leaseExpiresAt&&Date.parse(job.leaseExpiresAt)>now,alive=!!job.pid&&processAlive(job.pid),heartbeatFresh=!!job.heartbeatAt&&now-Date.parse(job.heartbeatAt)<90_000;const active=job.state==="ACTIVE"&&leaseValid&&alive&&heartbeatFresh,updatePending=job.repository==="knys/luckountry-control-center"&&!!job.mainSha&&job.deployedSha!==job.mainSha;return{...job,displayState:updatePending?"UPDATE_PENDING":job.state,updatePending,active,ballHolder:active||(["LEASED","VERIFYING","MERGING","DEPLOYING"].includes(job.state)&&leaseValid&&!!job.nextAction)?"LCC":"NONE"}});
  const completed=jobs.filter(j=>j.state==="COMPLETED").sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),operational=jobs.filter(j=>j.state!=="COMPLETED");const today=new Date(now).toISOString().slice(0,10);
  return{automation:{enabled:snapshot.automationEnabled,reason:snapshot.automationEnabled?null:snapshot.stopReason},supervisorId:snapshot.supervisorId,lastUpdated:snapshot.heartbeatAt,queueDepth:jobs.filter(j=>j.state==="QUEUED").length,activeJobs:jobs.filter(j=>j.active).length,completedToday:completed.filter(j=>j.updatedAt.slice(0,10)===today).length,completedTotal:completed.length,jobs:[...operational,...completed.slice(0,3)]};
}
export interface HistoryQuery{product?:string|undefined;repository?:string|undefined;state?:JobState|undefined;issueNumber?:number|undefined;from?:string|undefined;to?:string|undefined;page?:number|undefined;pageSize?:number|undefined}
export function history(snapshot:V2Snapshot,query:HistoryQuery={}){const page=Math.max(1,query.page??1),pageSize=Math.min(100,Math.max(1,query.pageSize??25));const jobs=snapshot.jobs.filter(j=>(!query.product||j.product===query.product)&&(!query.repository||j.repository===query.repository)&&(!query.state||j.state===query.state)&&(!query.issueNumber||j.issueNumber===query.issueNumber)&&(!query.from||j.updatedAt>=query.from)&&(!query.to||j.updatedAt<=query.to)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));return{page,pageSize,total:jobs.length,jobs:jobs.slice((page-1)*pageSize,page*pageSize)}}
function defaultAlive(pid:number){try{process.kill(pid,0);return true}catch{return false}}
