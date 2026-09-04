import assert from "node:assert/strict";
import test from "node:test";
import { assertRunInvariant, summarizeRun, type SelfCommissioningRun } from "../src/domain/self-commissioning-run.js";

const run = (changes: Partial<SelfCommissioningRun> = {}): SelfCommissioningRun => ({
  runId: "run-009",
  objective: "Complete LCC-008 AC-32 through AC-35",
  status: "IDLE",
  currentStep: null,
  activeActor: null,
  activeExecutionId: null,
  queuedActor: null,
  queuedStep: null,
  startedAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  completedSteps: [],
  failedStep: null,
  blocker: "No autonomous task is assigned",
  humanGate: null,
  retryBudget: { limit: 1, consumed: 0 },
  recoveryBudget: { limit: 3, consumed: 0 },
  history: [],
  ...changes
});

test("L009-02 nonterminal run always owns an explicit disposition", () => {
  assert.throws(
    () => assertRunInvariant(run({ status: "RUNNING", blocker: null })),
    /active actor.*execution/i
  );
  assert.throws(
    () => assertRunInvariant(run({ status: "QUEUED", blocker: null })),
    /queued actor.*step/i
  );
  assert.throws(
    () => assertRunInvariant(run({ status: "WAITING_HUMAN", blocker: null })),
    /human gate/i
  );
  assert.doesNotThrow(() => assertRunInvariant(run({
    status: "RUNNING", blocker: null, currentStep: "GTX_WORKER_STATUS",
    activeActor: "GTX1060", activeExecutionId: "maintenance-1"
  })));
});

test("L009-03 idle and blocked cannot serialize as ongoing", () => {
  for (const stopped of [
    run(),
    run({ status: "BLOCKED", blocker: "Worker authentication failed", failedStep: "GTX_WORKER_STATUS" })
  ]) {
    const summary = summarizeRun(stopped);
    assert.equal(summary.ongoing, false);
    assert.equal(summary.ballHolder, "NONE");
    assert.ok(summary.reason);
    assert.doesNotMatch(summary.message, /progress|running|進め|進行中|何もしなくてよい/i);
  }
});
