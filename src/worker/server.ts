import { readFile } from "node:fs/promises";
import { HmacVerifier } from "../infrastructure/hmac-auth.js";
import { createWorkerDescriptor, WorkerExecutionAgent } from "./execution-agent.js";
import { WorkerExecutionStore } from "./execution-store.js";
import { startWorkerServer } from "./http-server.js";
import { parseWorkspaceManifest } from "./workspace.js";

const configPath=required("WORKER_WORKSPACES_CONFIG"),secret=required("WORKER_HMAC_SECRET"),keyId=required("WORKER_HMAC_KEY_ID"),workerId=required("WORKER_ID"),statePath=required("WORKER_STATE_PATH");
const manifest=parseWorkspaceManifest(JSON.parse(await readFile(configPath,"utf8")));const store=await WorkerExecutionStore.open(statePath);const runtime=await createWorkerDescriptor(workerId,manifest);const agent=new WorkerExecutionAgent(runtime.descriptor,manifest,store,runtime.probe);const server=startWorkerServer(agent,new HmacVerifier({keyId,secret}));
function required(name:string):string{const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
