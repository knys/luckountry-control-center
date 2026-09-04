import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceProviders } from "./devices.js";
import { GhCliMetadataProvider, parseProductsManifest, ProductService } from "./products.js";
import { createRequestHandler } from "./http-app.js";
import { composeExecutionRuntime, composeIssueRuntime,composePilotRuntime,composeVerificationRuntime } from "./composition.js";
import { discoverRepositories } from "./composition.js";
import { composeProductionSelfCommissioning } from "./production-self-commissioning-composition.js";
import { CommissionInbox,type WatcherStatus } from "./application/commission-inbox.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const manifestPath = process.env.PRODUCTS_MANIFEST ?? join(dirname(fileURLToPath(import.meta.url)), "config", "products.json");
const deviceProviders = createDeviceProviders();
const manifest = parseProductsManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const issueRuntime = await composeIssueRuntime(manifest);
const repositories = discoverRepositories(manifest);
const productService = new ProductService(manifest, new GhCliMetadataProvider(),60_000,Date.now,async()=>({workItems:(await Promise.all(repositories.map(repository=>issueRuntime.repository.list(repository)))).flat(),executions:(await issueRuntime.repository.executionState?.())?.records??[]}));
const durable=issueRuntime.repository as Required<typeof issueRuntime.repository>,pilotRuntime=issueRuntime.repository.acquireExecution&&issueRuntime.repository.acquireVerification?await composePilotRuntime(durable):null;
const executionRuntime = pilotRuntime ? await composeExecutionRuntime(durable, repositories,process.env,pilotRuntime) : null;
const verificationRuntime=pilotRuntime?await composeVerificationRuntime(durable,repositories,process.env,pilotRuntime):null;
const selfCommissioning=issueRuntime.repository.acquireExecution&&issueRuntime.repository.acquireVerification?await composeProductionSelfCommissioning(durable):undefined;
const commissionInbox=new CommissionInbox(process.env.COMMISSION_INBOX_PATH??"/var/lib/luckountry-control-center/commissions.json"),watcherPath=process.env.COMMISSION_WATCHER_STATUS_PATH??"/var/lib/luckountry-control-center/watcher.json";
const server = createServer(createRequestHandler(productService, deviceProviders, undefined, () => issueRuntime.runtime.status(), async () => (await Promise.all(repositories.map((repository) => issueRuntime.repository.list(repository)))).flat(), issueRuntime.repository.executionState ? () => issueRuntime.repository.executionState!() : undefined,issueRuntime.repository.verificationState?()=>issueRuntime.repository.verificationState!():undefined,pilotRuntime?async()=>{const scope=pilotRuntime.control.scope,items=scope?await issueRuntime.repository.list(scope.repository):[];return{control:pilotRuntime.control,cycles:await pilotRuntime.cycles.pilotCycles(),matchedWorkItemIds:scope?items.filter(item=>item.source.externalId===scope.externalId).map(item=>item.id):[],workerReady:pilotRuntime.targetReady,recovery:await pilotRuntime.readiness.recoveryStatus()};}:undefined,selfCommissioning,{inbox:commissionInbox,token:process.env.LCC_CONTROL_TOKEN??"",status:async()=>{try{return JSON.parse(await readFile(watcherPath,"utf8")) as WatcherStatus}catch{return null}}}));

server.listen(port, host, () => console.log(`Luckountry Control Center listening on http://${host}:${port}`));
issueRuntime.runtime.start();
executionRuntime?.scanner.start();
verificationRuntime?.scanner.start();

let shutdownStarted = false;
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await issueRuntime.runtime.stop();
  await executionRuntime?.scanner.stop();
  await verificationRuntime?.scanner.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function handleSignal(): void {
  void shutdown().then(() => process.exit(0), (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "shutdown failed");
    process.exit(1);
  });
}
process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);
