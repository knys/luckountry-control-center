import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeIssueRuntime, discoverRepositories } from "../src/composition.js";
import { DurableRepositoryError, DurableWorkItemRepository } from "../src/infrastructure/durable-work-item-repository.js";
import { GitHubIssueAdapter } from "../src/infrastructure/github-issue-adapter.js";
import { IssueSyncService, type IssueSource } from "../src/application/issue-sync-service.js";
import { IssuePollingRuntime, type Scheduler } from "../src/application/issue-polling-runtime.js";
import { parseProductsManifest, ProductService, type GitHubMetadataProvider } from "../src/products.js";
import { createRequestHandler } from "../src/http-app.js";
import type { RuntimeStatus } from "../src/application/issue-polling-runtime.js";
import type { WorkItem } from "../src/domain/work-item.js";

const manifest = parseProductsManifest({ version: 1, products: [
  { id: "one", name: "One", repository: "knys/shared", summary: "One", status: "READY", ball: "CODEX", nextAction: "Sync" },
  { id: "two", name: "Two", repository: "knys/shared", summary: "Two", status: "READY", ball: "CODEX", nextAction: "Sync" },
  { id: "none", name: "None", repository: null, summary: "None", status: "BLOCKED", ball: "HUMAN", nextAction: "Configure" }
] });
const noopScheduler: Scheduler = { now: () => 0, setTimeout: () => 1, clearTimeout: () => undefined };

test("T01 compose_durable_issue_sync_runtime", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lcc-003-compose-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const composition = await composeIssueRuntime(manifest, { WORK_ITEM_DATABASE_PATH: join(directory, "state.json") }, { scheduler: noopScheduler });
  assert.ok(composition.repository instanceof DurableWorkItemRepository);
  assert.ok(composition.adapter instanceof GitHubIssueAdapter);
  assert.ok(composition.syncService instanceof IssueSyncService);
  assert.ok(composition.runtime instanceof IssuePollingRuntime);
});

test("T02 discover_unique_repositories_from_manifest", async () => {
  const checkedIn = parseProductsManifest(JSON.parse(await readFile("config/products.json", "utf8")));
  const repositories = discoverRepositories(checkedIn);
  assert.equal(repositories.filter((item) => item === "knys/TOBIE").length, 1);
  assert.ok(!repositories.includes(""));
  assert.equal(repositories.length, new Set(repositories).size);
});

test("T15 credential_not_exposed", async () => {
  const token = "test-placeholder-never-a-real-token";
  const serverSource = await readFile("src/server.ts", "utf8");
  const unit = await readFile("ops/luckountry-control-center.service", "utf8");
  assert.doesNotMatch(serverSource, new RegExp(token));
  assert.doesNotMatch(unit, /GITHUB_TOKEN\s*=/);
  assert.match(unit, /EnvironmentFile=-\/etc\/luckountry-control-center\/environment/);
  assert.match(await readFile("ops/install.sh", "utf8"), /root.*root.*0750.*\/etc\/luckountry-control-center/);
  const status: RuntimeStatus = { running: true, startedAt: null, pollIntervalMs: 60_000, shuttingDown: false, repositories: [] };
  const provider: GitHubMetadataProvider = { fetch: async () => new Map() };
  const handler = createRequestHandler(new ProductService(manifest, provider), [], undefined, () => status);
  let body = ""; let code = 0;
  await new Promise<void>((resolve) => handler({ method: "GET", url: "/api/runtime" } as IncomingMessage, { writeHead: (value: number) => { code = value; }, end: (value: string) => { body = value; resolve(); } } as unknown as ServerResponse));
  assert.equal(code, 200); assert.deepEqual(JSON.parse(body), status); assert.doesNotMatch(body, /token|authorization|secret/i);
});

test("T16 durable_open_failure_fails_startup", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lcc-003-fail-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const occupied = join(directory, "occupied"); await writeFile(occupied, "file");
  await assert.rejects(composeIssueRuntime(manifest, { WORK_ITEM_DATABASE_PATH: join(occupied, "state.json") }), (error: unknown) => error instanceof DurableRepositoryError);
});

test("T17 restart_restores_then_continues_polling", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lcc-003-restart-")); context.after(() => rm(directory, { recursive: true, force: true })); const path = join(directory, "state.json");
  const saved: WorkItem = { id: "github:knys/shared:1", source: { provider: "github", repository: "knys/shared", externalId: "1" }, title: "Old", sourceState: "open", labels: [], assignees: [], sourceUrl: "https://github.com/knys/shared/issues/1", workState: "RUNNING", ballHolder: "HUMAN", nextAction: { kind: "EXECUTE", summary: "Keep", ballHolder: "HUMAN", aiExecutable: false, requiredCapabilities: [] }, blocker: null, acceptanceCriteria: [], evidence: ["saved"], sourceUpdatedAt: "2026-09-01T00:00:00Z", lastSyncedAt: "2026-09-01T00:00:00Z", transitionReason: "Started" };
  const first = await DurableWorkItemRepository.open(path); await first.commitSync("knys/shared", [saved], { status: "SUCCEEDED", lastAttemptedSyncAt: saved.lastSyncedAt, lastSuccessfulSyncAt: saved.lastSyncedAt, failureReason: null, failureType: null, resetAt: null, retryAfter: null });
  const source: IssueSource = { fetchOpenIssues: async () => [{ externalId: "1", title: "New", state: "open", labels: [], assignees: [], updatedAt: "2026-09-02T00:00:00Z", url: saved.sourceUrl }] };
  const composition = await composeIssueRuntime(manifest, { WORK_ITEM_DATABASE_PATH: path }, { source, scheduler: noopScheduler }); composition.runtime.start(); await composition.runtime.stop();
  const [restored] = await composition.repository.list("knys/shared"); assert.equal(restored?.title, "New"); assert.equal(restored?.workState, "RUNNING"); assert.equal(restored?.nextAction.summary, "Keep"); assert.deepEqual(restored?.evidence, ["saved"]);
});

test("T18 existing_dashboard_regression", async () => {
  const provider: GitHubMetadataProvider = { fetch: async () => new Map() }; const handler = createRequestHandler(new ProductService(manifest, provider), []);
  let code = 0; await new Promise<void>((resolve) => handler({ method: "GET", url: "/health" } as IncomingMessage, { writeHead: (value: number) => { code = value; }, end: () => resolve() } as unknown as ServerResponse)); assert.equal(code, 200);
});

test("LCC-007 V23 verification API is read-only bounded secret/path-free",async()=>{const provider:GitHubMetadataProvider={fetch:async()=>new Map()},secret="token=super-secret",state={leases:[],records:[{verificationId:"v",workItemId:"w",sourceExecutionId:"e",repository:"knys/repo",workerId:"gtx",workspaceId:"repo",profileId:"node",requestedAt:"a",startedAt:"a",finishedAt:"b",verifiedHead:"abc",status:"PASSED"as const,criteria:[],criterionEvidence:[],checks:[{checkId:"test",status:"PASSED"as const,exitCode:0,startedAt:"a",finishedAt:"b",summary:"ok",evidence:[`C:\\Users\\dev\\secret.txt ${secret}`]}],summary:secret,evidence:[secret]}]},handler=createRequestHandler(new ProductService(manifest,provider),[],undefined,undefined,undefined,undefined,async()=>state);for(const method of["GET","POST"]){let code=0,body="";await new Promise<void>(resolve=>handler({method,url:"/api/verifications"}as IncomingMessage,{writeHead:(value:number)=>{code=value;},end:(value:string)=>{body=value??"";resolve();}}as unknown as ServerResponse));if(method==="GET"){assert.equal(code,200);assert.doesNotMatch(body,/super-secret|C:\\\\Users/);assert.match(body,/REDACTED|LOCAL_PATH/);}else assert.equal(code,405);}});
