export const failureTypes = ["AUTHENTICATION", "AUTHORIZATION", "RATE_LIMIT", "NETWORK", "INVALID_RESPONSE", "UNKNOWN"] as const;
export type FailureType = typeof failureTypes[number];

export type WorkState = "IDEA" | "DEFINED" | "READY" | "RUNNING" | "VERIFYING" | "WAITING_HUMAN" | "WAITING_WORKER" | "BLOCKED" | "FAILED" | "RETRYING" | "DONE" | "UNKNOWN";
export type BallHolder = "LCC" | "CHATGPT" | "CODEX" | "HUMAN" | "EXTERNAL" | "NONE" | "UNKNOWN";
export type ActionKind = "DEFINE" | "EXECUTE" | "VERIFY" | "RETRY" | "WAIT_HUMAN" | "WAIT_WORKER" | "RESOLVE_BLOCKER" | "INVESTIGATE" | "NONE" | "UNKNOWN";
export interface NextAction { kind: ActionKind; summary: string; ballHolder: BallHolder; aiExecutable: boolean; requiredCapabilities: string[] }

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
  nextAction: NextAction;
  blocker: string | null;
  acceptanceCriteria: string[];
  definitionReady?: boolean;
  evidence: string[];
  sourceUpdatedAt: string;
  lastSyncedAt: string;
  transitionReason: string;
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
