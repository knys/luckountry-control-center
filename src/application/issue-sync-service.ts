import type { FailureType, SyncMetadata, WorkItem } from "../domain/work-item.js";
import { safeInitialExecution } from "../domain/work-state-machine.js";
import { extractAcceptanceCriteria } from "../domain/verification.js";

export interface ExternalIssue {
  externalId: string;
  title: string;
  state: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  url: string;
  body?: string | null;
}

export interface IssueSource {
  fetchOpenIssues(repository: string): Promise<ExternalIssue[]>;
}

export interface WorkItemRepository {
  list(repository: string): Promise<WorkItem[]>;
  metadata(repository: string): Promise<SyncMetadata>;
  commitSync(repository: string, workItems: readonly WorkItem[], metadata: SyncMetadata): Promise<void>;
  recordFailure(repository: string, metadata: SyncMetadata): Promise<void>;
  transitionExecutionState(id: string, update: (current: WorkItem) => WorkItem): Promise<WorkItem>;
}

export class SyncFailure extends Error {
  constructor(readonly failureType: FailureType, message: string, readonly resetAt: string | null = null, readonly retryAfter: number | null = null) {
    super(message);
    this.name = "SyncFailure";
  }
}

export class IssueSyncService {
  constructor(private readonly source: IssueSource, private readonly repository: WorkItemRepository, private readonly now: () => number = Date.now) {}

  async sync(repositoryName: string): Promise<WorkItem[]> {
    const attemptedAt = new Date(this.now()).toISOString();
    const previousMetadata = await this.repository.metadata(repositoryName);
    try {
      const externalIssues = await this.source.fetchOpenIssues(repositoryName);
      const existing = new Map((await this.repository.list(repositoryName)).map((item) => [item.source.externalId, item]));
      const seen = new Set<string>();
      const workItems = externalIssues.map((external): WorkItem => {
        if (!external.externalId || !external.title || external.state !== "open" || !isTimestamp(external.updatedAt) || !isHttpUrl(external.url) || seen.has(external.externalId)) {
          throw new SyncFailure("INVALID_RESPONSE", `invalid issue ${external.externalId || "without id"}`);
        }
        seen.add(external.externalId);
        const prior = existing.get(external.externalId);
        const initial = safeInitialExecution();
        return {
          id: prior?.id ?? `github:${repositoryName}:${external.externalId}`,
          source: { provider: "github", repository: repositoryName, externalId: external.externalId },
          title: external.title,
          sourceState: external.state,
          labels: [...external.labels],
          assignees: [...external.assignees],
          sourceUrl: external.url,
          workState: prior?.workState ?? initial.workState,
          ballHolder: prior?.ballHolder ?? initial.ballHolder,
          nextAction: structuredClone(prior?.nextAction ?? initial.nextAction),
          blocker: prior?.blocker ?? null,
          acceptanceCriteria: extractAcceptanceCriteria(external.body),
          evidence: [...(prior?.evidence ?? [])],
          sourceUpdatedAt: external.updatedAt,
          lastSyncedAt: attemptedAt
          ,transitionReason: prior?.transitionReason ?? initial.transitionReason
        };
      });
      const metadata: SyncMetadata = { status: "SUCCEEDED", lastAttemptedSyncAt: attemptedAt, lastSuccessfulSyncAt: attemptedAt, failureReason: null, failureType: null, resetAt: null, retryAfter: null };
      await this.repository.commitSync(repositoryName, workItems, metadata);
      return workItems;
    } catch (error) {
      const failure = error instanceof SyncFailure ? error : new SyncFailure("UNKNOWN", messageOf(error));
      const metadata: SyncMetadata = {
        status: "FAILED",
        lastAttemptedSyncAt: attemptedAt,
        lastSuccessfulSyncAt: previousMetadata.lastSuccessfulSyncAt,
        failureReason: failure.message,
        failureType: failure.failureType,
        resetAt: failure.resetAt,
        retryAfter: failure.retryAfter
      };
      await this.repository.recordFailure(repositoryName, metadata);
      throw failure;
    }
  }
}

const isTimestamp = (value: string): boolean => value.trim().length > 0 && Number.isFinite(Date.parse(value));
const isHttpUrl = (value: string): boolean => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
const messageOf = (error: unknown): string => error instanceof Error ? error.message : "unknown sync failure";
