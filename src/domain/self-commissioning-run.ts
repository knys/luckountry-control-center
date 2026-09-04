export const selfCommissioningRunStatuses = ["RUNNING", "QUEUED", "WAITING_HUMAN", "BLOCKED", "IDLE", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type SelfCommissioningRunStatus = typeof selfCommissioningRunStatuses[number];
export type RunActor = "LCC" | "TX66KWH" | "GTX1060" | "CODEX" | "GITHUB";

export interface SelfCommissioningRun {
  runId: string;
  objective: string;
  status: SelfCommissioningRunStatus;
  currentStep: string | null;
  activeActor: RunActor | null;
  activeExecutionId: string | null;
  queuedActor: RunActor | null;
  queuedStep: string | null;
  startedAt: string;
  updatedAt: string;
  completedSteps: string[];
  failedStep: string | null;
  blocker: string | null;
  humanGate: string | null;
  retryBudget: { limit: number; consumed: number };
  recoveryBudget: { limit: number; consumed: number };
  history: unknown[];
}

export interface RunSummary {
  runId: string;
  status: SelfCommissioningRunStatus;
  activeActor: RunActor | null;
  activeExecutionId: string | null;
  ballHolder: RunActor | "HUMAN" | "NONE";
  ongoing: boolean;
  message: string;
  reason: string | null;
}

export class InvalidSelfCommissioningRunError extends Error {}

const present = (value: string | null): value is string => typeof value === "string" && value.trim().length > 0;

export function assertRunInvariant(run: SelfCommissioningRun): void {
  if (!present(run.runId) || !present(run.objective)) throw new InvalidSelfCommissioningRunError("run id and objective are required");
  if (!Number.isSafeInteger(run.retryBudget.limit) || !Number.isSafeInteger(run.retryBudget.consumed) || run.retryBudget.limit < 0 || run.retryBudget.consumed < 0 || run.retryBudget.consumed > run.retryBudget.limit) {
    throw new InvalidSelfCommissioningRunError("retry budget must be bounded and cannot be over-consumed");
  }
  if (!Number.isSafeInteger(run.recoveryBudget.limit) || !Number.isSafeInteger(run.recoveryBudget.consumed) || run.recoveryBudget.limit < 0 || run.recoveryBudget.consumed < 0 || run.recoveryBudget.consumed > run.recoveryBudget.limit) throw new InvalidSelfCommissioningRunError("recovery budget must be bounded and cannot be over-consumed");
  const active = run.activeActor !== null || run.activeExecutionId !== null;
  const queued = run.queuedActor !== null || run.queuedStep !== null;
  if (run.status === "RUNNING") {
    if (!run.activeActor || !present(run.activeExecutionId) || !present(run.currentStep)) throw new InvalidSelfCommissioningRunError("RUNNING requires an active actor, execution, and current step");
    if (queued || present(run.blocker) || present(run.humanGate)) throw new InvalidSelfCommissioningRunError("RUNNING cannot also be queued, blocked, or at a Human Gate");
  } else if (run.status === "QUEUED") {
    if (!run.queuedActor || !present(run.queuedStep)) throw new InvalidSelfCommissioningRunError("QUEUED requires a queued actor and step");
    if (active || present(run.blocker) || present(run.humanGate)) throw new InvalidSelfCommissioningRunError("QUEUED cannot also be active, blocked, or at a Human Gate");
  } else if (run.status === "WAITING_HUMAN") {
    if (!present(run.humanGate)) throw new InvalidSelfCommissioningRunError("WAITING_HUMAN requires an exact Human Gate");
    if (active || queued || present(run.blocker)) throw new InvalidSelfCommissioningRunError("WAITING_HUMAN cannot have an actor, queue, or blocker");
  } else if (run.status === "BLOCKED") {
    if (!present(run.blocker)) throw new InvalidSelfCommissioningRunError("BLOCKED requires an exact blocker");
    if (active || queued || present(run.humanGate)) throw new InvalidSelfCommissioningRunError("BLOCKED cannot have an actor, queue, or Human Gate");
  } else if (run.status === "IDLE") {
    if (!present(run.blocker)) throw new InvalidSelfCommissioningRunError("IDLE requires an exact no-actor reason");
    if (active || queued || present(run.humanGate)) throw new InvalidSelfCommissioningRunError("IDLE cannot have an actor, queue, or Human Gate");
  } else if (active || queued || present(run.humanGate)) {
    throw new InvalidSelfCommissioningRunError("terminal runs cannot retain an active or queued actor or Human Gate");
  }
}

export function summarizeRun(run: SelfCommissioningRun): RunSummary {
  assertRunInvariant(run);
  const ongoing = run.status === "RUNNING" || run.status === "QUEUED";
  const ballHolder = run.status === "RUNNING" ? run.activeActor! : run.status === "QUEUED" ? run.queuedActor! : run.status === "WAITING_HUMAN" ? "HUMAN" : "NONE";
  const reason = run.status === "WAITING_HUMAN" ? run.humanGate : run.blocker;
  const message = run.status === "RUNNING"
    ? `${run.activeActor} is executing ${run.currentStep}`
    : run.status === "QUEUED"
      ? `${run.queuedStep} is durably queued for ${run.queuedActor}`
      : run.status === "WAITING_HUMAN"
        ? `Human decision required: ${run.humanGate}`
        : run.status === "BLOCKED"
          ? `Autonomous execution stopped: ${run.blocker}`
          : run.status === "IDLE"
            ? `No autonomous task is active: ${run.blocker}`
            : `Run ended with status ${run.status}`;
  return {
    runId: run.runId,
    status: run.status,
    activeActor: run.activeActor,
    activeExecutionId: run.activeExecutionId,
    ballHolder,
    ongoing,
    message,
    reason
  };
}
