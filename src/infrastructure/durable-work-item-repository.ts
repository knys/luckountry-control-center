import { open as openFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { failureTypes, type SyncMetadata, type WorkItem } from "../domain/work-item.js";
import type { WorkItemRepository } from "../application/issue-sync-service.js";

export const CURRENT_SCHEMA_VERSION = 1;
export const DEFAULT_WORK_ITEM_DATABASE_PATH = "/var/lib/luckountry-control-center/work-items.json";
export type AtomicFileWriter = (path: string, contents: string) => Promise<void>;

interface RepositoryData { workItems: WorkItem[]; metadata: SyncMetadata }
interface Snapshot { schemaVersion: 1; repositories: Record<string, RepositoryData> }

export class DurableRepositoryError extends Error {
  constructor(message: string, readonly databasePath: string, options?: ErrorOptions) { super(message, options); this.name = "DurableRepositoryError"; }
}

export function workItemDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.WORK_ITEM_DATABASE_PATH?.trim() || DEFAULT_WORK_ITEM_DATABASE_PATH;
}

export class DurableWorkItemRepository implements WorkItemRepository {
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly databasePath: string, private snapshot: Snapshot, private readonly writer: AtomicFileWriter) {}

  static async open(databasePath: string, writer: AtomicFileWriter = atomicWrite): Promise<DurableWorkItemRepository> {
    if (!databasePath.trim()) throw new DurableRepositoryError("database path must not be empty", databasePath);
    try {
      const contents = await readFile(databasePath, "utf8");
      return new DurableWorkItemRepository(databasePath, parseSnapshot(contents, databasePath), writer);
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof DurableRepositoryError) throw error;
        throw storageError("cannot open durable repository", databasePath, error);
      }
      const initial: Snapshot = { schemaVersion: CURRENT_SCHEMA_VERSION, repositories: {} };
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
      next.repositories[repository] = { workItems: structuredClone(workItems) as WorkItem[], metadata: structuredClone(metadata) };
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

  private async update(change: (next: Snapshot) => void): Promise<void> {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.snapshot);
      change(next);
      try { await this.writer(this.databasePath, serialize(next)); }
      catch (error) { throw storageError("cannot write durable repository", this.databasePath, error); }
      this.snapshot = next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
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
    const directoryHandle = await openFile(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseSnapshot(contents: string, path: string): Snapshot {
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (error) { throw new DurableRepositoryError(`corrupt storage at ${path}: invalid JSON`, path, { cause: error }); }
  const root = record(value);
  if (!root || typeof root.schemaVersion !== "number") throw new DurableRepositoryError(`invalid storage at ${path}: schema version is missing`, path);
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
  return structuredClone(value) as Snapshot;
}

function validateWorkItems(items: readonly unknown[], repository: string, path: string): asserts items is WorkItem[] {
  const references = new Set<string>();
  for (const raw of items) {
    const item = record(raw); const source = record(item?.source);
    const valid = item && source && strings(item.labels) && strings(item.assignees) && strings(item.acceptanceCriteria) && strings(item.evidence)
      && requiredStrings(item, ["id", "title", "sourceState", "sourceUrl", "sourceUpdatedAt", "lastSyncedAt"])
      && requiredStrings(source, ["provider", "repository", "externalId"])
      && source.repository === repository && ["READY", "RUNNING", "WAITING", "BLOCKED", "ACCEPTANCE", "DONE", "UNKNOWN"].includes(String(item.workState))
      && ["CHATGPT", "CODEX", "HUMAN", "EXTERNAL", "NONE", "UNKNOWN"].includes(String(item.ballHolder))
      && nullableString(item.nextAction) && nullableString(item.blocker);
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
function storageError(message: string, path: string, cause: unknown): DurableRepositoryError { return new DurableRepositoryError(`${message} at ${path}: ${cause instanceof Error ? cause.message : "unknown error"}`, path, { cause }); }
