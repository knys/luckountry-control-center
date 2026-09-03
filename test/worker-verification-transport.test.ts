import test from"node:test";
import assert from"node:assert/strict";
import{Readable}from"node:stream";
import type{IncomingMessage,ServerResponse}from"node:http";
import{mkdtemp,rm}from"node:fs/promises";
import{join}from"node:path";
import{tmpdir}from"node:os";
import{HmacVerifier,signRequest}from"../src/infrastructure/hmac-auth.js";
import{createWorkerHandler}from"../src/worker/http-server.js";
import{WorkerVerificationAgent}from"../src/worker/verification-agent.js";
import{WorkerVerificationStore}from"../src/worker/verification-store.js";
import{parseWorkspaceManifest}from"../src/worker/workspace.js";
import type{VerificationRequest}from"../src/domain/verification.js";
import{runVerification}from"../src/worker/verifier.js";

const credentials={keyId:"lcc",secret:"verification-secret"},request:VerificationRequest={verificationId:"v1",workItemId:"w",sourceExecutionId:"e",repository:"knys/repo",workspaceId:"repo",profileId:"node",checkIds:["test"]};
async function invoke(handler:ReturnType<typeof createWorkerHandler>,method:string,path:string,body:string,headers:object){const req=Object.assign(Readable.from(body?[body]:[]),{method,url:path,headers})as unknown as IncomingMessage;let code=0,text="";await handler(req,{writeHead:(value:number)=>{code=value;},end:(value?:string)=>{text=value??"";}}as unknown as ServerResponse);return{code,body:text};}
test("V11 verification endpoints reuse HMAC and replay protection",async()=>{let submits=0;const execution={descriptor:{workerId:"gtx",status:"ONLINE",capabilities:[],workspaceIds:[],executorKinds:[]}}as never,verification={submit:async()=>{submits++;return{statusCode:202,record:{status:"QUEUED"}}},status:async()=>null,cancel:async()=>null}as never,verifier=new HmacVerifier(credentials,60,()=>1000),handler=createWorkerHandler(execution,verifier,verification),body=JSON.stringify(request),headers=signRequest(credentials,"POST","/v1/verifications",body,1000,"nonce");assert.equal((await invoke(handler,"POST","/v1/verifications",body,headers)).code,202);assert.equal((await invoke(handler,"POST","/v1/verifications",body,headers)).code,401);assert.equal(submits,1);});
test("V09/V26 request injection and active execution are rejected before process spawn",async t=>{const directory=await mkdtemp(join(tmpdir(),"lcc-va-"));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await WorkerVerificationStore.open(join(directory,"state.json")),manifest=parseWorkspaceManifest({version:1,workspaces:[{workspaceId:"repo",repository:"knys/repo",path:directory,capabilities:["TEST"]}]}),profiles=[{profileId:"node",checks:{test:{executable:process.execPath,args:[],timeoutMs:1000}}}],agent=new WorkerVerificationAgent(manifest,profiles,store,undefined,async()=>true);await assert.rejects(agent.submit({...request,executable:"evil"}as VerificationRequest),/invalid/);await assert.rejects(agent.submit(request),/execution is active/);assert.deepEqual(await store.list(),[]);});
test("V27 cancellation is verificationId scoped",async t=>{const directory=await mkdtemp(join(tmpdir(),"lcc-vc-"));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await WorkerVerificationStore.open(join(directory,"state.json"));await store.create(request);await store.create({...request,verificationId:"v2",workspaceId:"repo2"});const agent=new WorkerVerificationAgent({version:1,workspaces:[]},[],store);await agent.cancel("v1");assert.equal((await store.get("v1"))?.status,"CANCELLED");assert.equal((await store.get("v2"))?.status,"QUEUED");});
test("V10 fixed verification timeout produces TIMED_OUT evidence",async()=>{const result=await runVerification(request,{workspaceId:"repo",repository:"knys/repo",path:".",capabilities:[]},{profileId:"node",checks:{test:{executable:process.execPath,args:[],timeoutMs:5}}},async(executable,_args,_cwd,_stdin,_environment,signal)=>{if(executable==="git")return{code:0,stdout:"abc",stderr:""};return new Promise(resolve=>signal?.addEventListener("abort",()=>resolve({code:-1,stdout:"",stderr:"timeout"}),{once:true}));});assert.equal(result.checks[0]?.status,"TIMED_OUT");assert.match(result.checks[0]?.evidence[0]??"",/TIMED_OUT/);});
