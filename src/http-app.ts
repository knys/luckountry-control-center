import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSystemStatus } from "./system.js";
import { collectDeviceStatuses, type DeviceProvider } from "./devices.js";
import type { ProductService } from "./products.js";
import type { RuntimeStatus } from "./application/issue-polling-runtime.js";
import type { WorkItem } from "./domain/work-item.js";
import type { ExecutionState } from "./application/execution.js";
import type { VerificationState } from "./domain/verification.js";
import { redact } from "./application/verification.js";
import type { PilotControl,PilotCycle } from "./domain/pilot.js";
import type { PilotRecoveryStatus } from "./application/pilot-control.js";
import { validControlToken,type ProductionSelfCommissioningControl } from "./application/production-self-commissioning.js";
import type { CommissionInbox,WatcherStatus } from "./application/commission-inbox.js";
import { watcherView } from "./public/watcher-status.js";
import type { TemperatureHistory } from "./temperature-history.js";

const defaultPublicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const assets = new Map<string, readonly [string, string]>([["/", ["index.html", "text/html; charset=utf-8"]], ["/styles.css", ["styles.css", "text/css; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]], ["/watcher-status.js", ["watcher-status.js", "text/javascript; charset=utf-8"]]]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createRequestHandler(products: ProductService, devices: DeviceProvider[], publicDir = defaultPublicDir, runtimeStatus?: () => RuntimeStatus, workItems?: () => Promise<WorkItem[]>, executions?: () => Promise<ExecutionState>,verifications?:()=>Promise<VerificationState>,automationControl?:()=>Promise<{control:PilotControl;cycles:PilotCycle[];matchedWorkItemIds:string[];workerReady:boolean;recovery?:PilotRecoveryStatus}>,selfCommissioning?:{control:ProductionSelfCommissioningControl;token:string},commission?:{inbox:CommissionInbox;token:string;status:()=>Promise<WatcherStatus|null>;recover?:(runId:string,input:unknown)=>Promise<unknown>;humanDecision?:(runId:string,input:unknown)=>Promise<unknown>;deployment?:{token:string;request:()=>void}},temperatureHistory?:TemperatureHistory) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if(path==="/api/commissions"&&request.method==="GET"&&commission)return json(response,200,{candidates:await commission.inbox.list()});
      if(path==="/api/commission-watcher"&&request.method==="GET"&&commission)return json(response,200,watcherView(await commission.status()));
      if(path==="/api/internal/commission-deploy"&&request.method==="POST"&&commission?.deployment){const remote=request.socket?.remoteAddress??"";if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(remote))return json(response,403,{error:"loopback_required"});if(!validControlToken(request,commission.deployment.token))return json(response,401,{error:"unauthorized"});commission.deployment.request();return json(response,202,{status:"accepted",operation:"TX_LCC_DEPLOY_DISABLED"})}
      const commissionAction=path.match(/^\/api\/commissions\/([A-Za-z0-9-]+)\/commission$/);
      const runControl=path.match(/^\/api\/commission-runs\/([A-Za-z0-9._-]{1,100})\/(recover|human-gate)$/);
      if(commission&&runControl&&request.method==="POST"){if(!validControlToken(request,commission.token))return json(response,401,{error:"unauthorized"});const body=await requestJson(request);return json(response,202,runControl[2]==="recover"?await commission.recover?.(runControl[1]!,body):await commission.humanDecision?.(runControl[1]!,body));}
      if(commission&&((path==="/api/commissions"&&request.method==="POST")||(commissionAction&&request.method==="POST"))){if(!validControlToken(request,commission.token))return json(response,401,{error:"unauthorized"});return json(response,commissionAction?200:201,commissionAction?await commission.inbox.commission(commissionAction[1]!):await commission.inbox.register(await requestJson(request)));}
      if(path==="/api/self-commissioning"&&request.method==="GET"&&selfCommissioning)return json(response,200,{readiness:await selfCommissioning.control.readinessStatus(),runs:await selfCommissioning.control.list()});
      const createRun=path==="/api/self-commissioning/runs"&&request.method==="POST",runAction=path.match(/^\/api\/self-commissioning\/runs\/([A-Za-z0-9._-]{1,100})\/(start|cancel)$/);
      if(selfCommissioning&&(createRun||runAction&&request.method==="POST")){if(!validControlToken(request,selfCommissioning.token))return json(response,401,{error:"unauthorized"});if(createRun)return json(response,201,await selfCommissioning.control.create(await requestJson(request)));const runId=runAction![1]!,action=runAction![2]!;return json(response,action==="start"?202:200,action==="start"?await selfCommissioning.control.start(runId):await selfCommissioning.control.cancel(runId));}
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      if (path === "/health") return json(response, 200, { status: "ok", service: "luckountry-control-center", version: "0.3.0" });
      if (path === "/api/system-status") return json(response, 200, await collectSystemStatus());
      if (path === "/api/devices") return json(response, 200, { timestamp: new Date().toISOString(), devices: await collectDeviceStatuses(devices,temperatureHistory) });
      if (path === "/api/products") return json(response, 200, await products.getProducts());
      if (path === "/api/runtime" && runtimeStatus) return json(response, 200, runtimeStatus());
      if (path === "/api/work-items" && workItems) return json(response, 200, { workItems: await workItems() });
      if (path === "/api/executions" && executions) return json(response, 200, await executions());
      if (path === "/api/verifications" && verifications) return json(response, 200, sanitizeVerifications(await verifications()));
      if (path === "/api/automation-control" && automationControl) return json(response,200,sanitizeAutomationControl(await automationControl()));
      const asset = assets.get(path);
      if (!asset) return json(response, 404, { error: "not_found" });
      const [file, contentType] = asset;
      const body = await readFile(join(publicDir, file));
      response.writeHead(200, { "content-type": contentType, "cache-control": file === "index.html" ? "no-cache" : "public, max-age=3600", "x-content-type-options": "nosniff" });
      response.end(body);
    } catch (error) {
      console.error(error);
      json(response, 500, { error: "internal_error" });
    }
  };
}
async function requestJson(request:IncomingMessage):Promise<unknown>{let body="";for await(const chunk of request){body+=String(chunk);if(Buffer.byteLength(body)>4096)throw new Error("request body too large");}return JSON.parse(body||"{}")}
function sanitizeVerifications(state:VerificationState):VerificationState{return{leases:structuredClone(state.leases),records:state.records.map(record=>({...structuredClone(record),criteria:record.criteria.slice(0,100).map(criterion=>({...structuredClone(criterion),summary:redact(criterion.summary,500)})),summary:redact(record.summary,500),evidence:record.evidence.slice(0,10).map(v=>redact(v,500)),checks:record.checks.slice(0,20).map(check=>({...structuredClone(check),summary:redact(check.summary,500),evidence:check.evidence.slice(0,10).map(v=>redact(v,500))}))}))};}
function sanitizeAutomationControl(value:{control:PilotControl;cycles:PilotCycle[];matchedWorkItemIds:string[];workerReady:boolean;recovery?:PilotRecoveryStatus}){const scope=value.control.scope;return{mode:value.control.mode,executionEnabled:value.control.executionEnabled,verificationEnabled:value.control.verificationEnabled,enabled:value.control.enabled,reason:redact(value.control.reason,500),scope:scope?{cycleId:scope.cycleId,repository:scope.repository,externalId:scope.externalId,workerId:scope.workerId,workspaceId:scope.workspaceId,verificationProfileId:scope.verificationProfileId,baseBranch:scope.baseBranch,expiresAt:scope.expiresAt}:null,matchedWorkItemCount:value.matchedWorkItemIds.length,matchedWorkItemIds:value.matchedWorkItemIds.slice(0,1),workerReady:value.workerReady,recovery:value.recovery?{...value.recovery,reason:redact(value.recovery.reason,500),previousFailureReason:redact(value.recovery.previousFailureReason??"",500)||null}:null,cycles:value.cycles.slice(0,1).map(cycle=>({...cycle,reason:redact(cycle.reason,500),previousFailureReason:redact(cycle.previousFailureReason??"",500)||null,previousRemediationFailureReason:redact(cycle.previousRemediationFailureReason??"",500)||null}))};}
