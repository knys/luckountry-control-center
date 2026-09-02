import test from "node:test";
import assert from "node:assert/strict";
import { IssuePollingRuntime, pollIntervalFromEnvironment, type Scheduler, type SyncOperation } from "../src/application/issue-polling-runtime.js";
import { SyncFailure } from "../src/application/issue-sync-service.js";

class FakeScheduler implements Scheduler {
  time = Date.parse("2026-09-03T00:00:00Z");
  tasks: Array<{ id: number; at: number; callback: () => void }> = [];
  private id = 0;
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): unknown { const task = { id: ++this.id, at: this.time + delayMs, callback }; this.tasks.push(task); return task.id; }
  clearTimeout(handle: unknown): void { this.tasks = this.tasks.filter((task) => task.id !== handle); }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const next = this.tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.tasks = this.tasks.filter((task) => task !== next); this.time = next.at; next.callback(); await flush();
    }
    this.time = target; await flush();
  }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("T03 initial_sync_runs_immediately", async () => {
  const calls: string[] = []; const clock = new FakeScheduler();
  const runtime = new IssuePollingRuntime(["knys/a", "knys/b"], { sync: async (repository) => { calls.push(repository); } }, 60_000, clock);
  runtime.start(); await flush();
  assert.deepEqual(calls.sort(), ["knys/a", "knys/b"]);
});

test("T04 polls_again_after_interval", async () => {
  let calls = 0; const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { calls++; } }, 60_000, clock);
  runtime.start(); await flush(); await clock.advance(59_999); assert.equal(calls, 1); await clock.advance(1); assert.equal(calls, 2);
});

test("T05 does_not_overlap_same_repository", async () => {
  const gate = deferred<void>(); let active = 0; let maximum = 0; const clock = new FakeScheduler();
  const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { active++; maximum = Math.max(maximum, active); await gate.promise; active--; } }, 10_000, clock);
  runtime.start(); await flush(); await clock.advance(60_000); assert.equal(maximum, 1); assert.equal(clock.tasks.length, 0); gate.resolve(); await flush(); assert.equal(clock.tasks.length, 1);
});

test("T06 repository_failure_is_isolated", async () => {
  const calls: string[] = []; const clock = new FakeScheduler();
  const runtime = new IssuePollingRuntime(["knys/bad", "knys/good"], { sync: async (repository) => { calls.push(repository); if (repository.endsWith("bad")) throw new SyncFailure("NETWORK", "offline"); } }, 60_000, clock);
  runtime.start(); await flush(); assert.deepEqual(calls.sort(), ["knys/bad", "knys/good"]); assert.equal(runtime.status().repositories.find((item) => item.repository.endsWith("good"))?.phase, "IDLE");
});

test("T07 network_failure_uses_bounded_backoff", async () => {
  let calls = 0; const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { calls++; throw new SyncFailure("NETWORK", "offline"); } }, 10_000, clock);
  runtime.start(); await flush(); assert.equal(Date.parse(runtime.status().repositories[0]!.nextAttemptAt!) - clock.now(), 30_000);
  await clock.advance(30_000); assert.equal(calls, 2); assert.equal(Date.parse(runtime.status().repositories[0]!.nextAttemptAt!) - clock.now(), 60_000);
  for (let i = 0; i < 8; i++) { const next = Date.parse(runtime.status().repositories[0]!.nextAttemptAt!) - clock.now(); await clock.advance(next); }
  assert.ok(Date.parse(runtime.status().repositories[0]!.nextAttemptAt!) - clock.now() <= 900_000);
});

test("invalid response and unknown failures use bounded backoff", async () => {
  for (const failureType of ["INVALID_RESPONSE", "UNKNOWN"] as const) {
    const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { throw new SyncFailure(failureType, "failure"); } }, 10_000, clock);
    runtime.start(); await flush(); assert.equal(Date.parse(runtime.status().repositories[0]!.nextAttemptAt!) - clock.now(), 30_000); await runtime.stop();
  }
});

test("T08 rate_limit_honors_retry_time", async () => {
  const clock = new FakeScheduler(); const resetAt = new Date(clock.now() + 120_000).toISOString();
  const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { throw new SyncFailure("RATE_LIMIT", "limited", resetAt, 60); } }, 10_000, clock);
  runtime.start(); await flush(); assert.equal(Date.parse(runtime.status().repositories[0]!.nextAttemptAt!) - clock.now(), 120_000); assert.equal(clock.tasks.length, 1);
});

test("T09 authentication_failure_is_not_empty_success", async () => {
  for (const failureType of ["AUTHENTICATION", "AUTHORIZATION"] as const) {
    const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { throw new SyncFailure(failureType, "access denied"); } }, 10_000, clock);
    runtime.start(); await flush(); const status = runtime.status().repositories[0]!; assert.equal(status.phase, "BLOCKED"); assert.equal(status.failureType, failureType); assert.equal(status.lastSuccessfulAt, null); assert.ok(Date.parse(status.nextAttemptAt!) - clock.now() >= 900_000); await runtime.stop();
  }
});

test("T10 success_resets_backoff", async () => {
  let fail = true; const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { if (fail) { fail = false; throw new SyncFailure("NETWORK", "offline"); } } }, 10_000, clock);
  runtime.start(); await flush(); await clock.advance(30_000); const status = runtime.status().repositories[0]!; assert.equal(status.consecutiveFailures, 0); assert.equal(status.failureType, null); assert.equal(status.phase, "IDLE"); assert.equal(Date.parse(status.nextAttemptAt!) - clock.now(), 10_000);
});

test("T11 runtime_status_is_observable", async () => {
  const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => undefined }, 60_000, clock); runtime.start(); await flush();
  assert.deepEqual(runtime.status(), { running: true, startedAt: "2026-09-03T00:00:00.000Z", pollIntervalMs: 60_000, repositories: [{ repository: "knys/a", phase: "IDLE", lastAttemptedAt: "2026-09-03T00:00:00.000Z", lastSuccessfulAt: "2026-09-03T00:00:00.000Z", nextAttemptAt: "2026-09-03T00:01:00.000Z", consecutiveFailures: 0, failureType: null }], shuttingDown: false });
});

test("T12 graceful_shutdown_stops_new_polls", async () => {
  let calls = 0; const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => { calls++; } }, 10_000, clock); runtime.start(); await flush(); await runtime.stop(); await clock.advance(60_000); assert.equal(calls, 1); assert.equal(runtime.status().shuttingDown, true); assert.equal(runtime.status().running, false);
});

test("T13 shutdown_awaits_inflight_without_unhandled_rejection", async () => {
  const gate = deferred<void>(); const clock = new FakeScheduler(); const runtime = new IssuePollingRuntime(["knys/a"], { sync: async () => gate.promise }, 10_000, clock); runtime.start(); await flush(); let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false); gate.reject(new Error("settled failure")); await stopping; assert.equal(stopped, true);
});

test("T14 invalid_interval_rejected", () => {
  for (const value of ["0", "-1", "NaN", "9999", "1.5"]) assert.throws(() => pollIntervalFromEnvironment({ WORK_ITEM_POLL_INTERVAL_MS: value }), /invalid WORK_ITEM_POLL_INTERVAL_MS/);
  assert.equal(pollIntervalFromEnvironment({}), 60_000);
});
