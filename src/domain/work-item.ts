export const failureTypes = ["AUTHENTICATION", "AUTHORIZATION", "RATE_LIMIT", "NETWORK", "INVALID_RESPONSE", "UNKNOWN"] as const;
export type FailureType = typeof failureTypes[number];

export type WorkState = "READY" | "RUNNING" | "WAITING" | "BLOCKED" | "ACCEPTANCE" | "DONE" | "UNKNOWN";
export type BallHolder = "CHATGPT" | "CODEX" | "HUMAN" | "EXTERNAL" | "NONE" | "UNKNOWN";

export interface WorkItem {
  id: string;
  source: { provider: string; repository: string; externalId: string };
  title: string;
  sourceState: string;
  labels: string[];
  assignees: string[];
  sourceUrl: string;
  workState: WorkState;
  ballHolder: BallHolder;
  nextAction: string | null;
  blocker: string | null;
  acceptanceCriteria: string[];
  evidence: string[];
  sourceUpdatedAt: string;
  lastSyncedAt: string;
}

export interface SyncMetadata {
  status: "NEVER" | "SUCCEEDED" | "FAILED";
  lastAttemptedSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  failureReason: string | null;
  failureType: FailureType | null;
  resetAt: string | null;
  retryAfter: number | null;
}
