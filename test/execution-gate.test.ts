import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExecutionGate, type ExecutionLease, type ExecutionState, type RepositoryExecutionTarget, type WorkerDescriptor } from "../src/application/execution.js";
import type { WorkItem } from "../src/domain/work-item.js";

export const target: RepositoryExecutionTarget = { repository: "knys/repo", workerId: "gtx1060", workspaceId: "repo-workspace", requiredCapabilities: ["CODE_EDIT", "GIT"], concurrency: "EXCLUSIVE_REPOSITORY" };
export const worker: WorkerDescriptor = { workerId: "gtx1060", status: "ONLINE", capabilities: ["CODE_EDIT", "GIT", "NODE20"], workspaceIds: ["repo-workspace"], executorKinds: ["CODEX"] };
export const readyItem = (changes: Partial<WorkItem> = {}): WorkItem => ({ id: "github:knys/repo:10", source: { provider: "github", repository: "knys/repo", externalId: "10" }, title: "Execution gate", sourceState: "open", labels: [], assignees: [], sourceUrl: "https://github.com/knys/repo/issues/10", workState: "READY", ballHolder: "CODEX", nextAction: { kind: "EXECUTE", summary: "Implement issue", ballHolder: "CODEX", aiExecutable: true, requiredCapabilities: ["CODE_EDIT", "GIT"] }, blocker: null, acceptanceCriteria: [], evidence: [], sourceUpdatedAt: "2026-09-03T00:00:00Z", lastSyncedAt: "2026-09-03T00:00:00Z", transitionReason: "Defined", ...changes });
const state = (leases: ExecutionLease[] = []): ExecutionState => ({ leases, records: [] });
const active = (changes: Partial<ExecutionLease> = {}): ExecutionLease => ({ executionId: "e1", workItemId: readyItem().id, repository: "knys/repo", workerId: "gtx1060", acquiredAt: "2026-09-03T00:00:00Z", status: "ACTIVE", attempt: 1, ...changes });

test("T01 gate_requires_ready_codex_execute_and_ai_executable", () => assert.equal(evaluateExecutionGate(readyItem(), target, worker, state(), false).status, "ELIGIBLE"));
test("T02 ai_executable_alone_is_insufficient", () => { for (const item of [readyItem({ workState: "DEFINED" }), readyItem({ ballHolder: "HUMAN" }), readyItem({ nextAction: { ...readyItem().nextAction, kind: "VERIFY" } })]) assert.equal(evaluateExecutionGate(item, target, worker, state(), false).status, "REJECTED"); });
test("T03 worker_capabilities_must_cover_action", () => assert.equal(evaluateExecutionGate(readyItem(), target, { ...worker, capabilities: ["GIT"] }, state(), false).status, "WAITING_WORKER"));
test("T04 unknown_repository_is_rejected", () => assert.equal(evaluateExecutionGate(readyItem(), null, worker, state(), false).status, "REJECTED"));
test("T05 repository_workspace_binding_is_allowlisted", () => { assert.equal(evaluateExecutionGate(readyItem(), target, worker, state(), false).status, "ELIGIBLE"); assert.equal(evaluateExecutionGate(readyItem(), target, { ...worker, workspaceIds: ["other"] }, state(), false).status, "WAITING_WORKER"); });
test("T06 unavailable_worker_is_not_dispatched", () => { for (const status of ["OFFLINE", "BUSY", "DRAINING", "UNKNOWN"] as const) assert.equal(evaluateExecutionGate(readyItem(), target, { ...worker, status }, state(), false).status, "WAITING_WORKER"); });
test("T07 active_work_item_lease_prevents_duplicate", () => assert.equal(evaluateExecutionGate(readyItem(), target, worker, state([active()]), false).status, "ALREADY_RUNNING"));
test("T08 exclusive_repository_lease_prevents_parallel_edit", () => assert.equal(evaluateExecutionGate(readyItem(), target, worker, state([active({ workItemId: "other" })]), false).status, "ALREADY_RUNNING"));
test("shutdown is ineligible", () => assert.equal(evaluateExecutionGate(readyItem(), target, worker, state(), true).status, "REJECTED"));
test("R07 canonical RETRYING work is execution eligible",()=>assert.equal(evaluateExecutionGate(readyItem({workState:"RETRYING",ballHolder:"LCC",nextAction:{kind:"RETRY",summary:"Retry failed work",ballHolder:"LCC",aiExecutable:true,requiredCapabilities:["CODE_EDIT"]}}),target,worker,state(),false).status,"ELIGIBLE"));
