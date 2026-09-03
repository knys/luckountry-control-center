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

const defaultPublicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const assets = new Map<string, readonly [string, string]>([["/", ["index.html", "text/html; charset=utf-8"]], ["/styles.css", ["styles.css", "text/css; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createRequestHandler(products: ProductService, devices: DeviceProvider[], publicDir = defaultPublicDir, runtimeStatus?: () => RuntimeStatus, workItems?: () => Promise<WorkItem[]>, executions?: () => Promise<ExecutionState>,verifications?:()=>Promise<VerificationState>,automationControl?:()=>Promise<{control:PilotControl;cycles:PilotCycle[];matchedWorkItemIds:string[];workerReady:boolean;recovery?:PilotRecoveryStatus}>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/health") return json(response, 200, { status: "ok", service: "luckountry-control-center", version: "0.3.0" });
      if (path === "/api/system-status") return json(response, 200, await collectSystemStatus());
      if (path === "/api/devices") return json(response, 200, { timestamp: new Date().toISOString(), devices: await collectDeviceStatuses(devices) });
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
function sanitizeVerifications(state:VerificationState):VerificationState{return{leases:structuredClone(state.leases),records:state.records.map(record=>({...structuredClone(record),criteria:record.criteria.slice(0,100).map(criterion=>({...structuredClone(criterion),summary:redact(criterion.summary,500)})),summary:redact(record.summary,500),evidence:record.evidence.slice(0,10).map(v=>redact(v,500)),checks:record.checks.slice(0,20).map(check=>({...structuredClone(check),summary:redact(check.summary,500),evidence:check.evidence.slice(0,10).map(v=>redact(v,500))}))}))};}
function sanitizeAutomationControl(value:{control:PilotControl;cycles:PilotCycle[];matchedWorkItemIds:string[];workerReady:boolean;recovery?:PilotRecoveryStatus}){const scope=value.control.scope;return{mode:value.control.mode,executionEnabled:value.control.executionEnabled,verificationEnabled:value.control.verificationEnabled,enabled:value.control.enabled,reason:redact(value.control.reason,500),scope:scope?{cycleId:scope.cycleId,repository:scope.repository,externalId:scope.externalId,workerId:scope.workerId,workspaceId:scope.workspaceId,verificationProfileId:scope.verificationProfileId,baseBranch:scope.baseBranch,expiresAt:scope.expiresAt}:null,matchedWorkItemCount:value.matchedWorkItemIds.length,matchedWorkItemIds:value.matchedWorkItemIds.slice(0,1),workerReady:value.workerReady,recovery:value.recovery?{...value.recovery,reason:redact(value.recovery.reason,500),previousFailureReason:redact(value.recovery.previousFailureReason??"",500)||null}:null,cycles:value.cycles.slice(0,1).map(cycle=>({...cycle,reason:redact(cycle.reason,500),previousFailureReason:redact(cycle.previousFailureReason??"",500)||null,previousRemediationFailureReason:redact(cycle.previousRemediationFailureReason??"",500)||null}))};}
