import { readFile } from "node:fs/promises";
import { HmacVerifier } from "../infrastructure/hmac-auth.js";
import { createWorkerDescriptor, WorkerExecutionAgent } from "./execution-agent.js";
import { WorkerExecutionStore } from "./execution-store.js";
import { startWorkerServer } from "./http-server.js";
import { parseWorkspaceManifest } from "./workspace.js";
import { resolveVerificationProfiles } from "./verifier.js";
import { WorkerVerificationStore } from "./verification-store.js";
import { WorkerVerificationAgent } from "./verification-agent.js";

const configPath=required("WORKER_WORKSPACES_CONFIG"),secret=required("WORKER_HMAC_SECRET"),keyId=required("WORKER_HMAC_KEY_ID"),workerId=required("WORKER_ID"),statePath=required("WORKER_STATE_PATH");
const manifest=parseWorkspaceManifest(JSON.parse(await readFile(configPath,"utf8"))),profilePath=process.env.WORKER_VERIFICATION_PROFILES_CONFIG?.trim(),profiles=profilePath?await resolveVerificationProfiles(JSON.parse(await readFile(profilePath,"utf8"))):[],store=await WorkerExecutionStore.open(statePath),profileIndex=Object.fromEntries(profiles.map(profile=>[profile.profileId,Object.keys(profile.checks)]));const runtime=await createWorkerDescriptor(workerId,manifest,undefined,profileIndex);let verification:WorkerVerificationAgent|undefined;const agent=new WorkerExecutionAgent(runtime.descriptor,manifest,store,runtime.probe,undefined,workspaceId=>verification?.active(workspaceId)??Promise.resolve(false));if(profiles.length){const verificationState=required("WORKER_VERIFICATION_STATE_PATH"),verificationStore=await WorkerVerificationStore.open(verificationState);verification=new WorkerVerificationAgent(manifest,profiles,verificationStore,undefined,workspaceId=>store.active(workspaceId));}const server=startWorkerServer(agent,new HmacVerifier({keyId,secret}),process.env,verification);
function required(name:string):string{const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
