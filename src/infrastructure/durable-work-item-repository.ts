import { open as openFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { failureTypes, type SyncMetadata, type WorkItem } from "../domain/work-item.js";
import type { WorkItemRepository } from "../application/issue-sync-service.js";
import { safeInitialExecution } from "../domain/work-state-machine.js";
import { transitionWorkItem, type WorkEvent } from "../domain/work-state-machine.js";
import { evaluateExecutionGate, type AcquireExecutionCommand, type AcquireExecutionResult, type ExecutionRepository, type ExecutionResult, type ExecutionState } from "../application/execution.js";

export const CURRENT_SCHEMA_VERSION = 3;
export const DEFAULT_WORK_ITEM_DATABASE_PATH = "/var/lib/luckountry-control-center/work-items.json";
export type AtomicFileWriter = (path: string, contents: string) => Promise<void>;
export type DirectoryDurabilityPolicy = "REQUIRED" | "UNSUPPORTED_BEST_EFFORT";

interface RepositoryData { workItems: WorkItem[]; metadata: SyncMetadata }
interface Snapshot { schemaVersion: 3; repositories: Record<string, RepositoryData>; execution: ExecutionState }

export class DurableRepositoryError extends Error {
  constructor(message: string, readonly databasePath: string, options?: ErrorOptions) { super(message, options); this.name = "DurableRepositoryError"; }
}

export function workItemDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.WORK_ITEM_DATABASE_PATH?.trim() || DEFAULT_WORK_ITEM_DATABASE_PATH;
}

export class DurableWorkItemRepository implements WorkItemRepository, ExecutionRepository {
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly databasePath: string, private snapshot: Snapshot, private readonly writer: AtomicFileWriter) {}

  static async open(databasePath: string, writer: AtomicFileWriter = atomicWrite): Promise<DurableWorkItemRepository> {
    if (!databasePath.trim()) throw new DurableRepositoryError("database path must not be empty", databasePath);
    try {
      const contents = await readFile(databasePath, "utf8");
      const snapshot = parseSnapshot(contents, databasePath);
      const original = record(JSON.parse(contents));
      if (original?.schemaVersion === 1 || original?.schemaVersion === 2) {
        try { await writer(databasePath, serialize(snapshot)); }
        catch (error) { throw storageError(`cannot persist migration from schema version ${original.schemaVersion}`, databasePath, error); }
      }
      return new DurableWorkItemRepository(databasePath, snapshot, writer);
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof DurableRepositoryError) throw error;
        throw storageError("cannot open durable repository", databasePath, error);
      }
      const initial: Snapshot = { schemaVersion: CURRENT_SCHEMA_VERSION, repositories: {}, execution: { leases: [], records: [] } };
      try {
        await writer(databasePath, serialize(initial));
        return new DurableWorkItemRepository(databasePath, initial, writer);
      } catch (writeError) { throw storageError("cannot initialize durable repository", databasePath, writeError); }
    }
  }

  async list(repository: string): Promise<WorkItem[]> { await this.pending; return structuredClone(this.snapshot.repositories[repository]?.workItems ?? []); }
  async metadata(repository: string): Promise<SyncMetadata> { await this.pending; return structuredClone(this.snapshot.repositories[repository]?.metadata ?? emptyMetadata()); }

  async commitSync(repository: string, workItems: readonly WorkItem[], metadata: SyncMetadata): Promise<void> {
    return this.update((next) => {
      validateRepositoryName(repository, this.databasePath);
      validateWorkItems(workItems, repository, this.databasePath);
      validateMetadata(metadata, this.databasePath);
      const current = new Map((next.repositories[repository]?.workItems ?? []).map((item) => [item.source.externalId, item]));
      next.repositories[repository] = { workItems: structuredClone(workItems).map((item) => mergeExecution(item, current.get(item.source.externalId))), metadata: structuredClone(metadata) };
    });
  }

  async recordFailure(repository: string, metadata: SyncMetadata): Promise<void> {
    return this.update((next) => {
      validateRepositoryName(repository, this.databasePath);
      validateMetadata(metadata, this.databasePath);
      const previous = next.repositories[repository];
      const failureMetadata = structuredClone(metadata);
      if (previous) failureMetadata.lastSuccessfulSyncAt = previous.metadata.lastSuccessfulSyncAt;
      next.repositories[repository] = { workItems: structuredClone(previous?.workItems ?? []), metadata: failureMetadata };
    });
  }

  async transitionExecutionState(id: string, update: (current: WorkItem) => WorkItem): Promise<WorkItem> {
    return this.update((next) => {
      for (const data of Object.values(next.repositories)) {
        const index = data.workItems.findIndex((item) => item.id === id);
        if (index >= 0) { const updated = structuredClone(update(structuredClone(data.workItems[index]!))); validateWorkItems([updated], updated.source.repository, this.databasePath); data.workItems[index] = updated; return updated; }
      }
      throw new DurableRepositoryError(`WorkItem not found: ${id}`, this.databasePath);
    });
  }

  async findWorkItem(id: string): Promise<WorkItem | null> { await this.pending; for (const data of Object.values(this.snapshot.repositories)) { const found = data.workItems.find((item) => item.id === id); if (found) return structuredClone(found); } return null; }
  async executionState(): Promise<ExecutionState> { await this.pending; return structuredClone(this.snapshot.execution); }
  async acquireExecution(command: AcquireExecutionCommand): Promise<AcquireExecutionResult> {
    return this.update((next) => {
      let current: WorkItem | null = null; let container: RepositoryData | null = null; let index = -1;
      for (const data of Object.values(next.repositories)) { const found = data.workItems.findIndex((item) => item.id === command.workItemId); if (found >= 0) { current = data.workItems[found]!; container = data; index = found; break; } }
      if (!current || !container) return { decision: { status: "REJECTED", reason: "WorkItem not found", target: command.target, worker: command.worker }, lease: null, workItem: null };
      const decision = evaluateExecutionGate(current, command.target, command.worker, next.execution, command.shuttingDown);
      if (decision.status !== "ELIGIBLE") return { decision, lease: null, workItem: null };
      const running = transitionWorkItem(current, { type: "EXECUTION_STARTED" }).workItem; container.workItems[index] = running;
      const attempt = next.execution.leases.filter((lease) => lease.workItemId === current!.id).length + 1;
      const lease = { executionId: command.executionId, workItemId: current.id, repository: current.source.repository, workerId: command.worker.workerId, acquiredAt: command.requestedAt, status: "ACTIVE" as const, attempt };
      next.execution.leases.push(lease); next.execution.records.push({ executionId: lease.executionId, workItemId: lease.workItemId, attempt, workerId: lease.workerId, requestedAt: command.requestedAt, startedAt: command.requestedAt, finishedAt: null, resultStatus: "ACTIVE", summary: "Execution dispatched", evidence: [] });
      return { decision, lease, workItem: running };
    });
  }
  async completeExecution(executionId: string, result: ExecutionResult, event: WorkEvent): Promise<WorkItem> {
    return this.update((next) => {
      const lease = next.execution.leases.find((item) => item.executionId === executionId && item.status === "ACTIVE"); if (!lease) throw new DurableRepositoryError(`Active execution lease not found: ${executionId}`, this.databasePath);
      let current: WorkItem | null = null; let container: RepositoryData | null = null; let index = -1; for (const data of Object.values(next.repositories)) { const found = data.workItems.findIndex((item) => item.id === lease.workItemId); if (found >= 0) { current = data.workItems[found]!; container = data; index = found; break; } }
      if (!current || !container) throw new DurableRepositoryError(`WorkItem not found for execution: ${executionId}`, this.databasePath);
      const updated = transitionWorkItem(current, event).workItem; container.workItems[index] = updated; lease.status = result.status === "WORKER_LOST" ? "ABANDONED" : "COMPLETED";
      const record = next.execution.records.find((item) => item.executionId === executionId)!; record.finishedAt = result.finishedAt; record.resultStatus = result.status; record.summary = result.summary; record.evidence = [...result.evidence]; return updated;
    });
  }

  private async update<T>(change: (next: Snapshot) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.snapshot);
      const result = change(next);
      try { await this.writer(this.databasePath, serialize(next)); }
      catch (error) { throw storageError("cannot write durable repository", this.databasePath, error); }
      this.snapshot = next;
      return structuredClone(result);
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await openFile(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncRenamedDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function directoryDurabilityPolicy(platform: NodeJS.Platform = process.platform): DirectoryDurabilityPolicy {
  return platform === "win32" ? "UNSUPPORTED_BEST_EFFORT" : "REQUIRED";
}

interface SyncDirectoryHandle { sync(): Promise<void>; close(): Promise<void> }
export async function syncRenamedDirectory(directory: string, platform: NodeJS.Platform = process.platform, opener: (path:string)=>Promise<SyncDirectoryHandle> = async path => openFile(path,"r")): Promise<void> {
  let directoryHandle;
  try {
    directoryHandle = await opener(directory);
    await directoryHandle.sync();
  } catch (error) {
    if (directoryDurabilityPolicy(platform) !== "UNSUPPORTED_BEST_EFFORT" || !isErrorCode(error, "EPERM")) throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

function parseSnapshot(contents: string, path: string): Snapshot {
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (error) { throw new DurableRepositoryError(`corrupt storage at ${path}: invalid JSON`, path, { cause: error }); }
  let root = record(value);
  if (!root || typeof root.schemaVersion !== "number") throw new DurableRepositoryError(`invalid storage at ${path}: schema version is missing`, path);
  if (root.schemaVersion === 1) { value = migrateV1(root, path); root = record(value)!; }
  if (root.schemaVersion === 2) { value = migrateV2(root, path); root = record(value)!; }
  if (root.schemaVersion !== CURRENT_SCHEMA_VERSION) throw new DurableRepositoryError(`unsupported schema version ${root.schemaVersion} at ${path}; expected ${CURRENT_SCHEMA_VERSION}`, path);
  const repositories = record(root.repositories);
  if (!repositories) throw new DurableRepositoryError(`invalid storage at ${path}: repositories are missing`, path);
  for (const [repository, raw] of Object.entries(repositories)) {
    validateRepositoryName(repository, path);
    const data = record(raw);
    if (!data || !Array.isArray(data.workItems)) throw new DurableRepositoryError(`invalid storage at ${path}: repository entry ${repository}`, path);
    validateWorkItems(data.workItems, repository, path);
    validateMetadata(data.metadata, path);
  }
  validateExecutionState(root.execution, path);
  return structuredClone(value) as Snapshot;
}

function validateExecutionState(value: unknown, path: string): asserts value is ExecutionState {
  const execution = record(value);
  if (!execution || !Array.isArray(execution.leases) || !Array.isArray(execution.records)) throw new DurableRepositoryError(`invalid storage at ${path}: execution state is missing`, path);
  for (const raw of execution.leases) {
    const lease = record(raw);
    if (!lease || !requiredStrings(lease, ["executionId", "workItemId", "repository", "workerId", "acquiredAt"]) || !["ACTIVE", "COMPLETED", "ABANDONED"].includes(String(lease.status)) || !Number.isInteger(lease.attempt) || Number(lease.attempt) < 1) throw new DurableRepositoryError(`invalid storage at ${path}: invalid execution lease`, path);
  }
  for (const raw of execution.records) {
    const entry = record(raw);
    if (!entry || !requiredStrings(entry, ["executionId", "workItemId", "workerId", "requestedAt", "startedAt", "summary"]) || !Number.isInteger(entry.attempt) || Number(entry.attempt) < 1 || !nullableString(entry.finishedAt) || !["ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "WORKER_LOST"].includes(String(entry.resultStatus)) || !strings(entry.evidence)) throw new DurableRepositoryError(`invalid storage at ${path}: invalid execution record`, path);
  }
}

function validateWorkItems(items: readonly unknown[], repository: string, path: string): asserts items is WorkItem[] {
  const references = new Set<string>();
  for (const raw of items) {
    const item = record(raw); const source = record(item?.source);
    const valid = item && source && strings(item.labels) && strings(item.assignees) && strings(item.acceptanceCriteria) && strings(item.evidence)
      && requiredStrings(item, ["id", "title", "sourceState", "sourceUrl", "sourceUpdatedAt", "lastSyncedAt"])
      && requiredStrings(source, ["provider", "repository", "externalId"])
      && source.repository === repository && ["IDEA", "DEFINED", "READY", "RUNNING", "VERIFYING", "WAITING_HUMAN", "WAITING_WORKER", "BLOCKED", "FAILED", "RETRYING", "DONE", "UNKNOWN"].includes(String(item.workState))
      && ["LCC", "CHATGPT", "CODEX", "HUMAN", "EXTERNAL", "NONE", "UNKNOWN"].includes(String(item.ballHolder))
      && validNextAction(item.nextAction) && nullableString(item.blocker) && typeof item.transitionReason === "string";
    const reference = valid ? `${source.provider}:${source.repository}:${source.externalId}` : "";
    if (!valid || references.has(reference)) throw new DurableRepositoryError(`invalid storage at ${path}: invalid or duplicate WorkItem source reference`, path);
    references.add(reference);
  }
}

function validateMetadata(value: unknown, path: string): asserts value is SyncMetadata {
  const item = record(value);
  const valid = item && ["NEVER", "SUCCEEDED", "FAILED"].includes(String(item.status))
    && nullableString(item.lastAttemptedSyncAt) && nullableString(item.lastSuccessfulSyncAt) && nullableString(item.failureReason)
    && (item.failureType === null || failureTypes.includes(item.failureType as typeof failureTypes[number]))
    && nullableString(item.resetAt) && (item.retryAfter === null || typeof item.retryAfter === "number");
  if (!valid) throw new DurableRepositoryError(`invalid storage at ${path}: invalid SyncMetadata`, path);
}

function serialize(snapshot: Snapshot): string { return `${JSON.stringify(snapshot, null, 2)}\n`; }
function emptyMetadata(): SyncMetadata { return { status: "NEVER", lastAttemptedSyncAt: null, lastSuccessfulSyncAt: null, failureReason: null, failureType: null, resetAt: null, retryAfter: null }; }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function requiredStrings(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((key) => typeof value[key] === "string" && String(value[key]).length > 0); }
function validateRepositoryName(value: string, path: string): void { if (!value.trim()) throw new DurableRepositoryError(`invalid storage at ${path}: empty repository name`, path); }
function isNotFound(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function storageError(message: string, path: string, cause: unknown): DurableRepositoryError { return new DurableRepositoryError(`${message} at ${path}: ${cause instanceof Error ? cause.message : "unknown error"}`, path, { cause }); }

function validNextAction(value: unknown): boolean { const item = record(value); return !!item && ["DEFINE", "EXECUTE", "VERIFY", "RETRY", "WAIT_HUMAN", "WAIT_WORKER", "RESOLVE_BLOCKER", "INVESTIGATE", "NONE", "UNKNOWN"].includes(String(item.kind)) && typeof item.summary === "string" && ["LCC", "CHATGPT", "CODEX", "HUMAN", "EXTERNAL", "NONE", "UNKNOWN"].includes(String(item.ballHolder)) && typeof item.aiExecutable === "boolean" && strings(item.requiredCapabilities); }
function mergeExecution(source: WorkItem, current?: WorkItem): WorkItem { return current ? { ...source, workState: current.workState, ballHolder: current.ballHolder, nextAction: structuredClone(current.nextAction), blocker: current.blocker, acceptanceCriteria: [...current.acceptanceCriteria], evidence: [...current.evidence], transitionReason: current.transitionReason } : source; }

function migrateV1(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const repositories = record(root.repositories);
  if (!repositories) throw new DurableRepositoryError(`migration from schema version 1 failed at ${path}: repositories missing`, path);
  const migrated: Record<string, RepositoryData> = {};
  for (const [name, raw] of Object.entries(repositories)) {
    const data = record(raw); if (!data || !Array.isArray(data.workItems)) throw new DurableRepositoryError(`migration from schema version 1 failed at ${path}: invalid repository ${name}`, path);
    const metadata = data.metadata as SyncMetadata;
    migrated[name] = { metadata: structuredClone(metadata), workItems: data.workItems.map((rawItem) => migrateV1Item(rawItem, path)) };
  }
  return { schemaVersion: 2, repositories: migrated };
}

function migrateV2(root: Record<string, unknown>, path: string): Snapshot { const repositories = record(root.repositories); if (!repositories) throw new DurableRepositoryError(`migration from schema version 2 failed at ${path}: repositories missing`, path); return { schemaVersion: 3, repositories: structuredClone(repositories) as unknown as Record<string, RepositoryData>, execution: { leases: [], records: [] } }; }

function migrateV1Item(raw: unknown, path: string): WorkItem {
  const item = record(raw); if (!item || typeof item.workState !== "string") throw new DurableRepositoryError(`migration from schema version 1 failed at ${path}: invalid WorkItem`, path);
  const oldState = item.workState;
  const safe = safeInitialExecution();
  let execution = safe;
  if (oldState === "RUNNING") execution = { workState: "RUNNING", ballHolder: item.ballHolder === "CHATGPT" ? "CHATGPT" : "CODEX", nextAction: { kind: "EXECUTE", summary: typeof item.nextAction === "string" ? item.nextAction : "Continue execution", ballHolder: item.ballHolder === "CHATGPT" ? "CHATGPT" : "CODEX", aiExecutable: true, requiredCapabilities: ["CODE_EDIT"] }, transitionReason: "Migrated active execution from schema v1" };
  else if (oldState === "ACCEPTANCE") execution = { workState: "VERIFYING", ballHolder: "HUMAN", nextAction: { kind: "WAIT_HUMAN", summary: typeof item.nextAction === "string" ? item.nextAction : "Complete human acceptance", ballHolder: "HUMAN", aiExecutable: false, requiredCapabilities: [] }, transitionReason: "Migrated ACCEPTANCE from schema v1" };
  else if (oldState === "WAITING") execution = { workState: "WAITING_HUMAN", ballHolder: "HUMAN", nextAction: { kind: "WAIT_HUMAN", summary: typeof item.nextAction === "string" ? item.nextAction : "Review waiting work", ballHolder: "HUMAN", aiExecutable: false, requiredCapabilities: [] }, transitionReason: "Migrated WAITING from schema v1" };
  else if (oldState === "BLOCKED") execution = { workState: "BLOCKED", ballHolder: item.ballHolder === "EXTERNAL" ? "EXTERNAL" : "HUMAN", nextAction: { kind: "RESOLVE_BLOCKER", summary: typeof item.blocker === "string" ? item.blocker : "Resolve blocker", ballHolder: item.ballHolder === "EXTERNAL" ? "EXTERNAL" : "HUMAN", aiExecutable: false, requiredCapabilities: [] }, transitionReason: "Migrated BLOCKED from schema v1" };
  else if (oldState === "DONE") execution = { workState: "DONE", ballHolder: "NONE", nextAction: { kind: "NONE", summary: "No further action", ballHolder: "NONE", aiExecutable: false, requiredCapabilities: [] }, transitionReason: "Migrated DONE from schema v1" };
  else if (oldState === "UNKNOWN") execution = { workState: "UNKNOWN", ballHolder: "UNKNOWN", nextAction: { kind: "UNKNOWN", summary: "Investigate unknown execution state", ballHolder: "UNKNOWN", aiExecutable: false, requiredCapabilities: [] }, transitionReason: "Migrated UNKNOWN from schema v1" };
  return { ...(item as unknown as WorkItem), ...execution, blocker: typeof item.blocker === "string" ? item.blocker : null };
}
