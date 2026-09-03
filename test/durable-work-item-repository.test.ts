import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableRepositoryError, DurableWorkItemRepository, CURRENT_SCHEMA_VERSION, DEFAULT_WORK_ITEM_DATABASE_PATH, directoryDurabilityPolicy, syncRenamedDirectory, workItemDatabasePath, type AtomicFileWriter } from "../src/infrastructure/durable-work-item-repository.js";
import { IssueSyncService, type ExternalIssue, type IssueSource } from "../src/application/issue-sync-service.js";
import type { SyncMetadata, WorkItem } from "../src/domain/work-item.js";

const repositoryName = "knys/luckountry-control-center";
const successfulAt = "2026-09-03T01:00:00.000Z";
const metadata = (changes: Partial<SyncMetadata> = {}): SyncMetadata => ({ status: "SUCCEEDED", lastAttemptedSyncAt: successfulAt, lastSuccessfulSyncAt: successfulAt, failureReason: null, failureType: null, resetAt: null, retryAfter: null, ...changes });
const workItem = (changes: Partial<WorkItem> = {}): WorkItem => ({ id: `github:${repositoryName}:4`, source: { provider: "github", repository: repositoryName, externalId: "4" }, title: "Durable repository", sourceState: "open", labels: ["feature"], assignees: ["knys"], sourceUrl: `https://github.com/${repositoryName}/issues/4`, workState: "RUNNING", ballHolder: "HUMAN", nextAction: { kind: "EXECUTE", summary: "Review persistence", ballHolder: "HUMAN", aiExecutable: false, requiredCapabilities: [] }, blocker: null, acceptanceCriteria: ["survives restart"], evidence: ["test"], sourceUpdatedAt: "2026-09-03T00:00:00Z", lastSyncedAt: successfulAt, transitionReason: "Started", ...changes });
const externalIssue = (changes: Partial<ExternalIssue> = {}): ExternalIssue => ({ externalId: "4", title: "Updated source title", state: "open", labels: ["changed"], assignees: [], updatedAt: "2026-09-03T02:00:00Z", url: `https://github.com/${repositoryName}/issues/4`, ...changes });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lcc-002-"));
  return { directory, path: join(directory, "work-items.json"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("T01 persist_work_item", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const repository = await DurableWorkItemRepository.open(file.path);
  await repository.commitSync(repositoryName, [workItem()], metadata());
  assert.deepEqual(await repository.list(repositoryName), [workItem()]);
  assert.match(await readFile(file.path, "utf8"), /Durable repository/);
});

test("T02 restore_after_repository_recreate", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const first = await DurableWorkItemRepository.open(file.path);
  await first.commitSync(repositoryName, [workItem()], metadata());
  const recreated = await DurableWorkItemRepository.open(file.path);
  assert.deepEqual(await recreated.list(repositoryName), [workItem()]);
});

test("LCC-005 schema v2 migrates explicitly to v3 without changing WorkItems", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const original = workItem();
  await writeFile(file.path, `${JSON.stringify({ schemaVersion: 2, repositories: { [repositoryName]: { workItems: [original], metadata: metadata() } } }, null, 2)}\n`, "utf8");
  const repository = await DurableWorkItemRepository.open(file.path);
  assert.deepEqual(await repository.list(repositoryName), [original]);
  assert.deepEqual(await repository.executionState(), { leases: [], records: [] });
  assert.equal(JSON.parse(await readFile(file.path, "utf8")).schemaVersion, 3);
});

test("T03 persist_sync_metadata", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const first = await DurableWorkItemRepository.open(file.path);
  await first.commitSync(repositoryName, [workItem()], metadata());
  assert.deepEqual(await (await DurableWorkItemRepository.open(file.path)).metadata(repositoryName), metadata());
});

test("T04 preserve_execution_state_on_resync", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const first = await DurableWorkItemRepository.open(file.path);
  await first.commitSync(repositoryName, [workItem()], metadata());
  const recreated = await DurableWorkItemRepository.open(file.path);
  const source: IssueSource = { fetchOpenIssues: async () => [externalIssue()] };
  await new IssueSyncService(source, recreated, () => Date.parse("2026-09-03T03:00:00Z")).sync(repositoryName);
  const [restored] = await recreated.list(repositoryName);
  assert.equal(restored?.title, "Updated source title");
  assert.equal(restored?.workState, "RUNNING");
  assert.equal(restored?.ballHolder, "HUMAN");
  assert.equal(restored?.nextAction.summary, "Review persistence");
  assert.deepEqual(restored?.evidence, ["test"]);
});

test("T05 no_duplicate_after_restart", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  await (await DurableWorkItemRepository.open(file.path)).commitSync(repositoryName, [workItem()], metadata());
  const recreated = await DurableWorkItemRepository.open(file.path);
  await new IssueSyncService({ fetchOpenIssues: async () => [externalIssue()] }, recreated).sync(repositoryName);
  assert.equal((await recreated.list(repositoryName)).length, 1);
});

test("T06 commit_sync_atomic_on_write_failure", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  await (await DurableWorkItemRepository.open(file.path)).commitSync(repositoryName, [workItem()], metadata());
  const failWrite: AtomicFileWriter = async () => { throw new Error("simulated disk full before rename"); };
  const failing = await DurableWorkItemRepository.open(file.path, failWrite);
  await assert.rejects(failing.commitSync(repositoryName, [workItem({ title: "partial" })], metadata({ lastAttemptedSyncAt: "2026-09-04T00:00:00Z" })), /disk full/);
  const restored = await DurableWorkItemRepository.open(file.path);
  assert.equal((await restored.list(repositoryName))[0]?.title, "Durable repository");
  assert.deepEqual(await restored.metadata(repositoryName), metadata());
});

test("T07 record_failure_preserves_last_good_state", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const repository = await DurableWorkItemRepository.open(file.path);
  await repository.commitSync(repositoryName, [workItem()], metadata());
  const failedMetadata = metadata({ status: "FAILED", lastAttemptedSyncAt: "2026-09-04T00:00:00Z", lastSuccessfulSyncAt: "2099-01-01T00:00:00Z", failureReason: "offline", failureType: "NETWORK" });
  await repository.recordFailure(repositoryName, failedMetadata);
  const restored = await DurableWorkItemRepository.open(file.path);
  assert.deepEqual(await restored.list(repositoryName), [workItem()]);
  assert.deepEqual(await restored.metadata(repositoryName), { ...failedMetadata, lastSuccessfulSyncAt: successfulAt });
});

test("T08 initialize_schema_first_run", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  await DurableWorkItemRepository.open(file.path);
  assert.deepEqual(JSON.parse(await readFile(file.path, "utf8")), { schemaVersion: CURRENT_SCHEMA_VERSION, repositories: {}, execution: { leases: [], records: [] } });
});

test("T09 schema_initialization_idempotent", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  await (await DurableWorkItemRepository.open(file.path)).commitSync(repositoryName, [workItem()], metadata());
  await DurableWorkItemRepository.open(file.path);
  await DurableWorkItemRepository.open(file.path);
  assert.deepEqual(await (await DurableWorkItemRepository.open(file.path)).list(repositoryName), [workItem()]);
});

test("T10 unwritable_storage_fails_explicitly", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const parentFile = join(file.directory, "not-a-directory");
  await writeFile(parentFile, "occupied");
  await assert.rejects(DurableWorkItemRepository.open(join(parentFile, "work-items.json")), (error: unknown) => error instanceof DurableRepositoryError && error.databasePath.endsWith("work-items.json"));
});

test("T11 corrupt_storage_not_silently_reset", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  await writeFile(file.path, "{ definitely not valid JSON");
  await assert.rejects(DurableWorkItemRepository.open(file.path), (error: unknown) => error instanceof DurableRepositoryError && /corrupt|invalid/i.test(error.message));
  assert.equal(await readFile(file.path, "utf8"), "{ definitely not valid JSON");
});

test("T12 configurable_database_path", () => {
  assert.equal(workItemDatabasePath({ WORK_ITEM_DATABASE_PATH: "/srv/lcc/custom.json" }), "/srv/lcc/custom.json");
  assert.equal(workItemDatabasePath({}), DEFAULT_WORK_ITEM_DATABASE_PATH);
});

test("T13 production_data_directory_contract", async () => {
  const installer = await readFile("ops/install.sh", "utf8");
  const service = await readFile("ops/luckountry-control-center.service", "utf8");
  assert.match(installer, /\/var\/lib\/luckountry-control-center/);
  assert.match(installer, /luckountry.*luckountry.*0750|0750.*luckountry.*luckountry/);
  assert.match(service, /WORK_ITEM_DATABASE_PATH=\/var\/lib\/luckountry-control-center\/work-items\.json/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/luckountry-control-center/);
});

test("rejects unsupported schema version without modifying storage", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  const future = JSON.stringify({ schemaVersion: 99, repositories: {} });
  await writeFile(file.path, future);
  await assert.rejects(DurableWorkItemRepository.open(file.path), /schema version 99/);
  assert.equal(await readFile(file.path, "utf8"), future);
});

test("recordFailure remains atomic on write failure", async (context) => {
  const file = await fixture(); context.after(file.cleanup);
  await (await DurableWorkItemRepository.open(file.path)).commitSync(repositoryName, [workItem()], metadata());
  const failing = await DurableWorkItemRepository.open(file.path, async () => { throw new Error("write failed"); });
  await assert.rejects(failing.recordFailure(repositoryName, metadata({ status: "FAILED", failureType: "NETWORK", failureReason: "offline" })), /write failed/);
  assert.deepEqual(await (await DurableWorkItemRepository.open(file.path)).metadata(repositoryName), metadata());
});

test("Windows directory durability ignores only unsupported directory fsync EPERM", async () => {
  assert.equal(directoryDurabilityPolicy("win32"), "UNSUPPORTED_BEST_EFFORT");
  assert.equal(directoryDurabilityPolicy("linux"), "REQUIRED");
  let closed = false;
  const eperm = Object.assign(new Error("unsupported"), { code: "EPERM" });
  await syncRenamedDirectory("C:\\state", "win32", async () => ({ sync: async () => { throw eperm; }, close: async () => { closed = true; } }));
  assert.equal(closed, true);
  await assert.rejects(syncRenamedDirectory("/state", "linux", async () => ({ sync: async () => { throw eperm; }, close: async () => undefined })), /unsupported/);
  const eio = Object.assign(new Error("disk failure"), { code: "EIO" });
  await assert.rejects(syncRenamedDirectory("C:\\state", "win32", async () => ({ sync: async () => { throw eio; }, close: async () => undefined })), /disk failure/);
});
