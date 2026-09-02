import type { SyncMetadata, WorkItem } from "../domain/work-item.js";
import type { WorkItemRepository } from "../application/issue-sync-service.js";

export const emptySyncMetadata = (): SyncMetadata => ({ status: "NEVER", lastAttemptedSyncAt: null, lastSuccessfulSyncAt: null, failureReason: null, failureType: null, resetAt: null, retryAfter: null });

export class InMemoryWorkItemRepository implements WorkItemRepository {
  private readonly workItems = new Map<string, WorkItem[]>();
  private readonly syncMetadata = new Map<string, SyncMetadata>();

  async list(repository: string): Promise<WorkItem[]> { return structuredClone(this.workItems.get(repository) ?? []); }
  async metadata(repository: string): Promise<SyncMetadata> { return structuredClone(this.syncMetadata.get(repository) ?? emptySyncMetadata()); }
  async commitSync(repository: string, workItems: readonly WorkItem[], metadata: SyncMetadata): Promise<void> {
    const nextItems = structuredClone(workItems) as WorkItem[];
    const nextMetadata = structuredClone(metadata);
    this.workItems.set(repository, nextItems);
    this.syncMetadata.set(repository, nextMetadata);
  }
  async recordFailure(repository: string, metadata: SyncMetadata): Promise<void> { this.syncMetadata.set(repository, structuredClone(metadata)); }
}
