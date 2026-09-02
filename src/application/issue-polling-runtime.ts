import { SyncFailure } from "./issue-sync-service.js";
import type { FailureType } from "../domain/work-item.js";

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const MIN_POLL_INTERVAL_MS = 10_000;
const TRANSIENT_BACKOFF_START_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface SyncOperation { sync(repository: string): Promise<unknown> }
export interface Scheduler { now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void }
export type RepositoryPhase = "IDLE" | "SYNCING" | "BACKOFF" | "BLOCKED";
export interface RepositoryRuntimeStatus { repository: string; phase: RepositoryPhase; lastAttemptedAt: string | null; lastSuccessfulAt: string | null; nextAttemptAt: string | null; consecutiveFailures: number; failureType: FailureType | null }
export interface RuntimeStatus { running: boolean; startedAt: string | null; pollIntervalMs: number; repositories: RepositoryRuntimeStatus[]; shuttingDown: boolean }

interface RepositoryState extends RepositoryRuntimeStatus { timer: unknown | null }

export function pollIntervalFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.WORK_ITEM_POLL_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS) throw new Error(`invalid WORK_ITEM_POLL_INTERVAL_MS: expected integer >= ${MIN_POLL_INTERVAL_MS}`);
  return value;
}

export const systemScheduler: Scheduler = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class IssuePollingRuntime {
  private readonly states: RepositoryState[];
  private readonly inflight = new Map<string, Promise<void>>();
  private running = false;
  private shuttingDown = false;
  private startedAt: string | null = null;

  constructor(repositories: readonly string[], private readonly syncOperation: SyncOperation, private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, private readonly scheduler: Scheduler = systemScheduler) {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS) throw new Error(`invalid poll interval: expected integer >= ${MIN_POLL_INTERVAL_MS}`);
    this.states = [...new Set(repositories)].map((repository) => ({ repository, phase: "IDLE", lastAttemptedAt: null, lastSuccessfulAt: null, nextAttemptAt: null, consecutiveFailures: 0, failureType: null, timer: null }));
  }

  start(): void {
    if (this.running || this.shuttingDown) throw new Error("polling runtime cannot be started in its current state");
    this.running = true;
    this.startedAt = timestamp(this.scheduler.now());
    for (const state of this.states) this.beginPoll(state);
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) { await Promise.allSettled(this.inflight.values()); return; }
    this.shuttingDown = true;
    for (const state of this.states) {
      if (state.timer !== null) this.scheduler.clearTimeout(state.timer);
      state.timer = null;
      state.nextAttemptAt = null;
    }
    await Promise.allSettled(this.inflight.values());
    this.running = false;
  }

  status(): RuntimeStatus {
    return { running: this.running, startedAt: this.startedAt, pollIntervalMs: this.pollIntervalMs, repositories: this.states.map(({ timer: _timer, ...state }) => structuredClone(state)), shuttingDown: this.shuttingDown };
  }

  private beginPoll(state: RepositoryState): void {
    if (!this.running || this.shuttingDown || this.inflight.has(state.repository)) return;
    state.timer = null;
    state.nextAttemptAt = null;
    state.phase = "SYNCING";
    state.lastAttemptedAt = timestamp(this.scheduler.now());
    const operation = this.executePoll(state);
    this.inflight.set(state.repository, operation);
    void operation.then(() => this.inflight.delete(state.repository), () => this.inflight.delete(state.repository));
  }

  private async executePoll(state: RepositoryState): Promise<void> {
    try {
      await this.syncOperation.sync(state.repository);
      state.phase = "IDLE";
      state.lastSuccessfulAt = timestamp(this.scheduler.now());
      state.consecutiveFailures = 0;
      state.failureType = null;
      this.schedule(state, this.pollIntervalMs);
    } catch (error) {
      const failure = error instanceof SyncFailure ? error : new SyncFailure("UNKNOWN", error instanceof Error ? error.message : "unknown polling failure");
      state.consecutiveFailures++;
      state.failureType = failure.failureType;
      const authBlocked = failure.failureType === "AUTHENTICATION" || failure.failureType === "AUTHORIZATION";
      state.phase = authBlocked ? "BLOCKED" : "BACKOFF";
      this.schedule(state, this.failureDelay(failure, state.consecutiveFailures));
    }
  }

  private failureDelay(failure: SyncFailure, failures: number): number {
    if (failure.failureType === "AUTHENTICATION" || failure.failureType === "AUTHORIZATION") return Math.max(this.pollIntervalMs, MAX_BACKOFF_MS);
    if (failure.failureType === "RATE_LIMIT") {
      const retryDelay = failure.retryAfter === null ? 0 : Math.max(0, failure.retryAfter * 1000);
      const resetDelay = failure.resetAt === null ? 0 : Math.max(0, Date.parse(failure.resetAt) - this.scheduler.now());
      if (retryDelay > 0 || resetDelay > 0) return Math.max(retryDelay, resetDelay, MIN_POLL_INTERVAL_MS);
    }
    return Math.min(MAX_BACKOFF_MS, TRANSIENT_BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));
  }

  private schedule(state: RepositoryState, delayMs: number): void {
    if (!this.running || this.shuttingDown) { state.nextAttemptAt = null; return; }
    state.nextAttemptAt = timestamp(this.scheduler.now() + delayMs);
    state.timer = this.scheduler.setTimeout(() => this.beginPoll(state), delayMs);
  }
}

const timestamp = (milliseconds: number): string => new Date(milliseconds).toISOString();
