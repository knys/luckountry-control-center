import type { WorkItem } from "../domain/work-item.js";
import type { WorkEvent } from "../domain/work-state-machine.js";
import { randomUUID } from "node:crypto";

export type GateStatus = "ELIGIBLE" | "WAITING_WORKER" | "REJECTED" | "ALREADY_RUNNING";
export interface RepositoryExecutionTarget { repository: string; workerId: string; workspaceId: string; requiredCapabilities: string[]; concurrency: "EXCLUSIVE_REPOSITORY" }
export interface WorkerDescriptor { workerId: string; status: "ONLINE" | "OFFLINE" | "BUSY" | "DRAINING" | "UNKNOWN"; capabilities: string[]; workspaceIds: string[]; executorKinds: string[]; agentVersion?: string; codexVersion?: string; codexReady?: boolean; lastHealthAt?: string }
export interface ExecutionLease { executionId: string; workItemId: string; repository: string; workerId: string; acquiredAt: string; status: "ACTIVE" | "COMPLETED" | "ABANDONED"; attempt: number }
export interface ExecutionRecord { executionId: string; workItemId: string; attempt: number; workerId: string; requestedAt: string; startedAt: string; finishedAt: string | null; resultStatus: ExecutionResultStatus | "ACTIVE"; summary: string; evidence: string[] }
export interface ExecutionState { leases: ExecutionLease[]; records: ExecutionRecord[] }
export interface GateDecision { status: GateStatus; reason: string; target: RepositoryExecutionTarget | null; worker: WorkerDescriptor | null }
export interface ExecutionRequest { executionId: string; workItemId: string; repository: string; workspaceId: string; actionKind: "EXECUTE"; summary: string; requiredCapabilities: string[]; sourceUrl: string }
export type ExecutionResultStatus = "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "WORKER_LOST";
export interface ExecutionResult { executionId: string; status: ExecutionResultStatus; startedAt: string; finishedAt: string; exitCode?: number; summary: string; evidence: string[]; retryable: boolean }
export interface WorkerRegistry { get(workerId: string): Promise<WorkerDescriptor | null> }
export interface Executor { execute(request: ExecutionRequest): Promise<ExecutionResult> }
export interface AcquireExecutionCommand { executionId: string; workItemId: string; target: RepositoryExecutionTarget; worker: WorkerDescriptor; requestedAt: string; shuttingDown: boolean }
export interface AcquireExecutionResult { decision: GateDecision; lease: ExecutionLease | null; workItem: WorkItem | null }
export interface ExecutionRepository {
  findWorkItem(id: string): Promise<WorkItem | null>;
  executionState(): Promise<ExecutionState>;
  acquireExecution(command: AcquireExecutionCommand): Promise<AcquireExecutionResult>;
  completeExecution(executionId: string, result: ExecutionResult, event: WorkEvent): Promise<WorkItem>;
}
export function evaluateExecutionGate(workItem: WorkItem, target: RepositoryExecutionTarget | null, worker: WorkerDescriptor | null, state: ExecutionState, shuttingDown: boolean): GateDecision {
  const rejected = (reason: string): GateDecision => ({ status: "REJECTED", reason, target, worker });
  if (shuttingDown) return rejected("execution service is shutting down");
  if (!target || target.repository !== workItem.source.repository) return rejected("repository is not uniquely allowlisted");
  if (state.leases.some((lease) => lease.status === "ACTIVE" && (lease.workItemId === workItem.id || lease.repository === target.repository))) return { status: "ALREADY_RUNNING", reason: "an active exclusive lease exists", target, worker };
  if (workItem.workState !== "READY" || workItem.ballHolder !== "CODEX" || workItem.nextAction.kind !== "EXECUTE" || !workItem.nextAction.aiExecutable) return rejected("WorkItem execution state is not eligible");
  if (workItem.nextAction.requiredCapabilities.length === 0) return rejected("required capabilities are empty");
  if (!worker || worker.workerId !== target.workerId) return { status: "WAITING_WORKER", reason: "configured worker is unavailable", target, worker };
  if (worker.status !== "ONLINE") return { status: "WAITING_WORKER", reason: `worker is ${worker.status}`, target, worker };
  if (worker.codexReady === false) return { status: "WAITING_WORKER", reason: "worker Codex runtime is not ready", target, worker };
  if (!worker.workspaceIds.includes(target.workspaceId) || !worker.executorKinds.includes("CODEX")) return { status: "WAITING_WORKER", reason: "worker cannot handle workspace or executor kind", target, worker };
  const requirements = new Set([...workItem.nextAction.requiredCapabilities, ...target.requiredCapabilities]);
  if ([...requirements].some((capability) => !worker.capabilities.includes(capability))) return { status: "WAITING_WORKER", reason: "worker capabilities do not satisfy requirements", target, worker };
  return { status: "ELIGIBLE", reason: "all execution gate conditions passed", target, worker };
}
export class ExecutionService {
  private shuttingDown = false; private readonly inflight = new Set<Promise<unknown>>();
  constructor(private readonly repository: ExecutionRepository, private readonly targets: readonly RepositoryExecutionTarget[], private readonly workers: WorkerRegistry, private readonly executor: Executor, private readonly now: () => number = Date.now, private readonly id: () => string = randomUUID) {}
  async execute(workItemId: string): Promise<GateDecision> {
    if (this.shuttingDown) return { status: "REJECTED", reason: "execution service is shutting down", target: null, worker: null };
    const workItem = await this.repository.findWorkItem(workItemId); if (!workItem) return { status: "REJECTED", reason: "WorkItem not found", target: null, worker: null };
    const matches = this.targets.filter((item) => item.repository === workItem.source.repository);
    const target = matches.length === 1 ? matches[0]! : null; const worker = target ? await this.workers.get(target.workerId) : null;
    const preliminary = evaluateExecutionGate(workItem, target, worker, await this.repository.executionState(), this.shuttingDown); if (preliminary.status !== "ELIGIBLE" || !target || !worker) return preliminary;
    const requestedAt = new Date(this.now()).toISOString(); const acquired = await this.repository.acquireExecution({ executionId: this.id(), workItemId, target, worker, requestedAt, shuttingDown: this.shuttingDown });
    if (acquired.decision.status !== "ELIGIBLE" || !acquired.lease || !acquired.workItem) return acquired.decision;
    const request: ExecutionRequest = { executionId: acquired.lease.executionId, workItemId, repository: target.repository, workspaceId: target.workspaceId, actionKind: "EXECUTE", summary: workItem.nextAction.summary, requiredCapabilities: [...new Set([...workItem.nextAction.requiredCapabilities, ...target.requiredCapabilities])], sourceUrl: workItem.sourceUrl };
    const operation = this.run(request); this.inflight.add(operation); try { await operation; } finally { this.inflight.delete(operation); }
    return acquired.decision;
  }
  async stop(): Promise<void> { this.shuttingDown = true; await Promise.allSettled(this.inflight); }
  private async run(request: ExecutionRequest): Promise<void> {
    let result: ExecutionResult;
    try { result = await this.executor.execute(structuredClone(request)); }
    catch (error) { const now = new Date(this.now()).toISOString(); result = { executionId: request.executionId, status: "FAILED", startedAt: now, finishedAt: now, summary: error instanceof Error ? error.message.slice(0, 500) : "executor failure", evidence: [], retryable: true }; }
    const sanitized = { ...result, summary: result.summary.slice(0, 500), evidence: result.evidence.slice(0, 10).map((item) => item.slice(0, 500)) };
    let event: WorkEvent;
    if (result.status === "SUCCEEDED") event = { type: "EXECUTION_COMPLETED", verification: "AUTOMATED" };
    else if (result.status === "WORKER_LOST") event = { type: "WORKER_UNAVAILABLE", monitor: "LCC" };
    else event = { type: result.retryable ? "RETRYABLE_FAILURE" : "TERMINAL_FAILURE" };
    await this.repository.completeExecution(request.executionId, sanitized, event);
  }
}
