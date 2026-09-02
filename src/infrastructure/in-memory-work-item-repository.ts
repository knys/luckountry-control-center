import type { SyncMetadata, WorkItem } from "../domain/work-item.js";
import type { WorkItemRepository } from "../application/issue-sync-service.js";

export const emptySyncMetadata = (): SyncMetadata => ({ status: "NEVER", lastAttemptedSyncAt: null, lastSuccessfulSyncAt: null, failureReason: null, failureType: null, resetAt: null, retryAfter: null });

export class InMemoryWorkItemRepository implements WorkItemRepository {
  private readonly workItems = new Map<string, WorkItem[]>();
  private readonly syncMetadata = new Map<string, SyncMetadata>();

  async list(repository: string): Promise<WorkItem[]> { return structuredClone(this.workItems.get(repository) ?? []); }
  async metadata(repository: string): Promise<SyncMetadata> { return structuredClone(this.syncMetadata.get(repository) ?? emptySyncMetadata()); }
  async commitSync(repository: string, workItems: readonly WorkItem[], metadata: SyncMetadata): Promise<void> {
    const existing = new Map((this.workItems.get(repository) ?? []).map((item) => [item.source.externalId, item]));
    const nextItems = structuredClone(workItems).map((item) => mergeExecution(item, existing.get(item.source.externalId)));
    const nextMetadata = structuredClone(metadata);
    this.workItems.set(repository, nextItems);
    this.syncMetadata.set(repository, nextMetadata);
  }
  async recordFailure(repository: string, metadata: SyncMetadata): Promise<void> { this.syncMetadata.set(repository, structuredClone(metadata)); }
  async transitionExecutionState(id: string, update: (current: WorkItem) => WorkItem): Promise<WorkItem> {
    for (const [repository, items] of this.workItems) { const index = items.findIndex((item) => item.id === id); if (index >= 0) { const updated = structuredClone(update(structuredClone(items[index]!))); items[index] = updated; this.workItems.set(repository, items); return structuredClone(updated); } }
    throw new Error(`WorkItem not found: ${id}`);
  }
}

function mergeExecution(source: WorkItem, current?: WorkItem): WorkItem { return current ? { ...source, workState: current.workState, ballHolder: current.ballHolder, nextAction: structuredClone(current.nextAction), blocker: current.blocker, acceptanceCriteria: [...current.acceptanceCriteria], evidence: [...current.evidence], transitionReason: current.transitionReason } : source; }
