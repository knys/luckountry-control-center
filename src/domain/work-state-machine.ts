import type { ActionKind, BallHolder, NextAction, WorkItem, WorkState } from "./work-item.js";

export const workStates = ["IDEA", "DEFINED", "READY", "RUNNING", "VERIFYING", "WAITING_HUMAN", "WAITING_WORKER", "BLOCKED", "FAILED", "RETRYING", "DONE", "UNKNOWN"] as const;
export const ballHolders = ["LCC", "CHATGPT", "CODEX", "HUMAN", "EXTERNAL", "NONE", "UNKNOWN"] as const;
export const actionKinds = ["DEFINE", "EXECUTE", "VERIFY", "RETRY", "WAIT_HUMAN", "WAIT_WORKER", "RESOLVE_BLOCKER", "INVESTIGATE", "NONE", "UNKNOWN"] as const;
export type CanonicalWorkState = WorkState;
export type CanonicalBallHolder = BallHolder;
export type { ActionKind, NextAction };

export const allowedTransitions: Readonly<Record<WorkState, readonly WorkState[]>> = {
  IDEA: ["DEFINED"], DEFINED: ["READY", "BLOCKED"], READY: ["RUNNING", "WAITING_HUMAN", "WAITING_WORKER", "BLOCKED"],
  RUNNING: ["VERIFYING", "FAILED", "WAITING_HUMAN", "WAITING_WORKER", "BLOCKED"], VERIFYING: ["DONE", "RUNNING", "WAITING_HUMAN", "FAILED", "BLOCKED"],
  FAILED: ["RETRYING", "WAITING_HUMAN", "BLOCKED"], RETRYING: ["RUNNING", "FAILED", "BLOCKED"], WAITING_HUMAN: ["READY", "BLOCKED"],
  WAITING_WORKER: ["READY", "BLOCKED"], BLOCKED: ["READY"], DONE: ["READY"], UNKNOWN: []
};

export type WorkEvent =
  | { type: "DEFINITION_STARTED" }
  | { type: "DEFINITION_COMPLETED"; executor: "CODEX" | "CHATGPT" }
  | { type: "EXECUTION_STARTED" }
  | { type: "EXECUTION_COMPLETED"; verification: "AUTOMATED" | "HUMAN" }
  | { type: "VERIFICATION_PASSED" } | { type: "VERIFICATION_FAILED" }
  | { type: "HUMAN_REQUIRED"; summary: string } | { type: "HUMAN_COMPLETED"; executor: "CODEX" | "CHATGPT" }
  | { type: "WORKER_UNAVAILABLE"; monitor: "LCC" | "HUMAN" } | { type: "WORKER_AVAILABLE"; executor: "CODEX" | "CHATGPT" }
  | { type: "RETRYABLE_FAILURE" } | { type: "TERMINAL_FAILURE" } | { type: "RETRY_STARTED" }
  | { type: "BLOCKER_SET"; owner: "HUMAN" | "EXTERNAL"; summary: string } | { type: "BLOCKER_CLEARED"; executor: "CODEX" | "CHATGPT" }
  | { type: "REOPENED"; executor: "CODEX" | "CHATGPT" };

export interface TransitionDecision { from: WorkState; to: WorkState; ballHolder: BallHolder; nextAction: NextAction; reason: string }
export class InvalidWorkTransitionError extends Error { constructor(from: WorkState, event: WorkEvent) { super(`event ${event.type} is not allowed from ${from}`); this.name = "InvalidWorkTransitionError"; } }

export function safeInitialExecution(): Pick<WorkItem, "workState" | "ballHolder" | "nextAction" | "transitionReason"> {
  const nextAction = action("DEFINE", "Complete the definition and Coding Ready Gate", "HUMAN", false);
  return { workState: "DEFINED", ballHolder: "HUMAN", nextAction, transitionReason: "Source discovered; explicit definition completion is required" };
}

export function transitionWorkItem(item: WorkItem, event: WorkEvent): { workItem: WorkItem; decision: TransitionDecision } {
  const result = decide(item, event);
  if (!allowedTransitions[item.workState].includes(result.to)) throw new InvalidWorkTransitionError(item.workState, event);
  const decision: TransitionDecision = { from: item.workState, to: result.to, ballHolder: result.ballHolder, nextAction: result.nextAction, reason: result.reason };
  return { workItem: { ...item, workState: result.to, ballHolder: result.ballHolder, nextAction: structuredClone(result.nextAction), blocker: result.blocker, transitionReason: result.reason }, decision };
}

function decide(item: WorkItem, event: WorkEvent): { to: WorkState; ballHolder: BallHolder; nextAction: NextAction; reason: string; blocker: string | null } {
  const reason = `${event.type} accepted from ${item.workState}`;
  const ready = (executor: "CODEX" | "CHATGPT") => ({ to: "READY" as const, ballHolder: executor, nextAction: action("EXECUTE", "Execute the defined work", executor, true, ["CODE_EDIT"]), reason, blocker: null });
  switch (event.type) {
    case "DEFINITION_STARTED": if (item.workState === "IDEA") return { to: "DEFINED", ballHolder: "HUMAN", nextAction: action("DEFINE", "Complete the work definition", "HUMAN", false), reason, blocker: null }; break;
    case "DEFINITION_COMPLETED": if (item.workState === "DEFINED") return ready(event.executor); break;
    case "EXECUTION_STARTED": if (item.workState === "READY" || item.workState === "RETRYING") return { to: "RUNNING", ballHolder: item.ballHolder, nextAction: action("EXECUTE", "Continue execution", item.ballHolder, true, ["CODE_EDIT"]), reason, blocker: null }; break;
    case "EXECUTION_COMPLETED": if (item.workState === "RUNNING") { const human = event.verification === "HUMAN"; const holder = human ? "HUMAN" : "LCC"; return { to: "VERIFYING", ballHolder: holder, nextAction: action(human ? "WAIT_HUMAN" : "VERIFY", human ? "Complete human acceptance" : "Run automated verification", holder, !human, human ? [] : ["TEST"]), reason, blocker: null }; } break;
    case "VERIFICATION_PASSED": if (item.workState === "VERIFYING") return { to: "DONE", ballHolder: "NONE", nextAction: action("NONE", "No further action", "NONE", false), reason, blocker: null }; break;
    case "VERIFICATION_FAILED": if (item.workState === "VERIFYING") return { to: "RUNNING", ballHolder: "CODEX", nextAction: action("EXECUTE", "Fix verification failures", "CODEX", true, ["CODE_EDIT"]), reason, blocker: null }; break;
    case "HUMAN_REQUIRED": if (["READY", "RUNNING", "VERIFYING", "FAILED"].includes(item.workState)) return { to: "WAITING_HUMAN", ballHolder: "HUMAN", nextAction: action("WAIT_HUMAN", event.summary, "HUMAN", false), reason, blocker: null }; break;
    case "HUMAN_COMPLETED": if (item.workState === "WAITING_HUMAN") return ready(event.executor); break;
    case "WORKER_UNAVAILABLE": if (item.workState === "READY" || item.workState === "RUNNING") { const holder = event.monitor; return { to: "WAITING_WORKER", ballHolder: holder, nextAction: action("WAIT_WORKER", "Wait for worker availability", holder, holder === "LCC", ["WORKER_MONITOR"]), reason, blocker: null }; } break;
    case "WORKER_AVAILABLE": if (item.workState === "WAITING_WORKER") return ready(event.executor); break;
    case "RETRYABLE_FAILURE": case "TERMINAL_FAILURE": if (["RUNNING", "VERIFYING", "RETRYING"].includes(item.workState)) return { to: "FAILED", ballHolder: "LCC", nextAction: action("INVESTIGATE", "Investigate execution failure", "LCC", true, ["DIAGNOSTICS"]), reason, blocker: null }; break;
    case "RETRY_STARTED": if (item.workState === "FAILED") return { to: "RETRYING", ballHolder: "LCC", nextAction: action("RETRY", "Retry failed work", "LCC", true, ["RETRY"]), reason, blocker: null }; break;
    case "BLOCKER_SET": if (["DEFINED", "READY", "RUNNING", "VERIFYING", "FAILED", "RETRYING", "WAITING_HUMAN", "WAITING_WORKER"].includes(item.workState)) return { to: "BLOCKED", ballHolder: event.owner, nextAction: action("RESOLVE_BLOCKER", event.summary, event.owner, false), reason, blocker: event.summary }; break;
    case "BLOCKER_CLEARED": if (item.workState === "BLOCKED") return ready(event.executor); break;
    case "REOPENED": if (item.workState === "DONE") return ready(event.executor); break;
  }
  throw new InvalidWorkTransitionError(item.workState, event);
}

function action(kind: ActionKind, summary: string, ballHolder: BallHolder, aiExecutable: boolean, requiredCapabilities: string[] = []): NextAction { return { kind, summary, ballHolder, aiExecutable, requiredCapabilities }; }
