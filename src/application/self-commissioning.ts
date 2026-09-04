import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TxMaintenanceRequest } from "./tx-maintenance.js";
import type { GtxMaintenanceRequest } from "../worker/maintenance.js";
import {
  assertRunInvariant,
  type RunActor,
  type SelfCommissioningRun,
} from "../domain/self-commissioning-run.js";
import { redact } from "./verification.js";
export interface CodexJob {
  operation?: SupervisorOperation;
}
export interface CodexJob {
  objective: string;
  repository: string;
  workspaceId: string;
  issueNumber?: number;
  sourceRevision?: string|null;
  humanGate?: string|null;
  policy: {
    allowCommit: true;
    allowPush: boolean;
    allowMerge: boolean;
    allowDeploy: boolean;
  };
}
export type SupervisorOperation =
  | "INSPECT_CURRENT_STATE"
  | "ASSERT_REMEDIATION_ELIGIBILITY"
  | "ENABLE_BOUNDED_PILOT"
  | "OBSERVE_EXECUTION"
  | "INDEPENDENT_VERIFICATION"
  | "ASSERT_PROMOTION_HOLD"
  | "KILL_SWITCH"
  | "POST_ACCEPTANCE_OBSERVATION"
  | "HUMAN_GATE";
export interface SupervisorJob extends CodexJob {
  operation: SupervisorOperation;
}
export type SelfCommissioningStep =
  | { stepId: string; kind: "TX_OPERATION"; request: TxMaintenanceRequest }
  | { stepId: string; kind: "GTX_OPERATION"; request: GtxMaintenanceRequest }
  | { stepId: string; kind: "CODEX_JOB"; job: CodexJob }
  | { stepId: string; kind: "SUPERVISOR_OPERATION"; job: SupervisorJob };
export interface CommissioningResult {
  status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "WAITING_HUMAN";
  summary: string;
  evidence: readonly string[];
  retryable?: boolean;
  blocker?: string;
  humanGate?: string;
}
export interface CommissioningExecutors {
  tx(request: TxMaintenanceRequest, id: string): Promise<CommissioningResult>;
  gtx(request: GtxMaintenanceRequest, id: string): Promise<CommissioningResult>;
  codex(job: CodexJob, id: string): Promise<CommissioningResult>;
}
interface Stored {
  run: SelfCommissioningRun;
  steps: SelfCommissioningStep[];
}
interface Snapshot {
  version: 1;
  dispatchEnabled: boolean;
  runs: Stored[];
}
export class DurableSelfCommissioningStore {
  private pending = Promise.resolve();
  private constructor(
    private path: string,
    private snapshot: Snapshot,
  ) {}
  static async open(path: string) {
    let value: Snapshot,
      changed = false;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as Snapshot;
      if (
        value.version !== 1 ||
        typeof value.dispatchEnabled !== "boolean" ||
        !Array.isArray(value.runs)
      )
        throw Error("invalid store");
    } catch (e) {
      if (
        !(
          e instanceof Error &&
          "code" in e &&
          (e as NodeJS.ErrnoException).code === "ENOENT"
        )
      )
        throw e;
      value = { version: 1, dispatchEnabled: true, runs: [] };
      changed = true;
    }
    for (const v of value.runs) {
      if (!v.run.recoveryBudget) {
        v.run.recoveryBudget = { limit: 3, consumed: 0 };
        changed = true;
      }
      if (v.run.status === "RUNNING") {
        const step = v.steps.find((s) => s.stepId === v.run.currentStep);
        if (!step) throw Error("checkpoint unavailable");
        v.run = {
          ...v.run,
          status: "QUEUED",
          activeActor: null,
          activeExecutionId: null,
          queuedActor: actor(step),
          queuedStep: step.stepId,
          updatedAt: new Date().toISOString(),
          history: [
            ...v.run.history,
            event("RESTART_RESUME", "Interrupted actor no longer claimed", []),
          ],
        };
        changed = true;
      }
      assertRunInvariant(v.run);
    }
    if (changed) await persist(path, value);
    else if (((await stat(path)).mode & 0o777) !== 0o660)
      await chmod(path, 0o660);
    return new DurableSelfCommissioningStore(path, value);
  }
  async get(id: string) {
    await this.pending;
    return structuredClone(
      this.snapshot.runs.find((v) => v.run.runId === id)?.run ?? null,
    );
  }
  async list() {
    await this.pending;
    return structuredClone(this.snapshot.runs.map((v) => v.run));
  }
  async stored(id: string) {
    await this.pending;
    return structuredClone(
      this.snapshot.runs.find((v) => v.run.runId === id) ?? null,
    );
  }
  async create(v: Stored) {
    return this.update((n) => {
      if (n.runs.some((x) => x.run.runId === v.run.runId))
        throw Error("run exists");
      n.runs.push(v);
      return v.run;
    });
  }
  async replace(v: Stored) {
    return this.update((n) => {
      const i = n.runs.findIndex((x) => x.run.runId === v.run.runId);
      if (i < 0) throw Error("run absent");
      n.runs[i] = v;
      return v.run;
    });
  }
  async cancel(id: string) {
    return this.update((n) => {
      const v = n.runs.find((x) => x.run.runId === id);
      if (!v) throw Error("run absent");
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(v.run.status))
        return v.run;
      v.run = {
        ...v.run,
        status: "CANCELLED",
        activeActor: null,
        activeExecutionId: null,
        queuedActor: null,
        queuedStep: null,
        updatedAt: new Date().toISOString(),
        history: [
          ...v.run.history,
          event("CANCELLED", "Cancellation requested", []),
        ],
      };
      return v.run;
    });
  }
  async enabled() {
    await this.pending;
    return this.snapshot.dispatchEnabled;
  }
  async setEnabled(v: boolean) {
    await this.update((n) => {
      n.dispatchEnabled = v;
      return v;
    });
  }
  async recover(id:string,input:{actor:string;reason:string;expectedFailure:string}) {
    return this.update(n=>{
      const v=n.runs.find(x=>x.run.runId===id);if(!v)throw Error("run absent");
      if(v.run.status!=="BLOCKED"||!v.run.failedStep||!v.run.blocker)throw Error("run is not recoverable");
      if(input.expectedFailure!==failureRevision(v.run))throw Error("failure revision mismatch");
      if(!/^[A-Za-z0-9_.@-]{1,100}$/.test(input.actor)||!input.reason.trim()||input.reason.length>500)throw Error("invalid recovery request");
      if(v.run.recoveryBudget.consumed>=v.run.recoveryBudget.limit)throw Error("recovery budget exhausted");
      const step=v.steps.find(s=>s.stepId===v.run.failedStep);if(!step)throw Error("failed checkpoint unavailable");
      v.run={...v.run,status:"QUEUED",currentStep:step.stepId,queuedActor:actor(step),queuedStep:step.stepId,failedStep:null,blocker:null,updatedAt:new Date().toISOString(),recoveryBudget:{...v.run.recoveryBudget,consumed:v.run.recoveryBudget.consumed+1},history:[...v.run.history,event("RECOVERED",`${input.actor}: ${input.reason}`,[`prior=${input.expectedFailure}`])]};
      return v.run;
    });
  }
  async recoverInterrupted(id:string,input:{reason:string;staleBefore:string}) {
    return this.update(n=>{
      const v=n.runs.find(x=>x.run.runId===id);if(!v)throw Error("run absent");
      if(v.run.status!=="RUNNING")return v.run;
      if(v.run.updatedAt>input.staleBefore)throw Error("run is not stale");
      if(v.run.recoveryBudget.consumed>=v.run.recoveryBudget.limit)throw Error("recovery budget exhausted");
      const step=v.steps.find(s=>s.stepId===v.run.currentStep);if(!step)throw Error("checkpoint unavailable");
      v.run={...v.run,status:"QUEUED",activeActor:null,activeExecutionId:null,queuedActor:actor(step),queuedStep:step.stepId,updatedAt:new Date().toISOString(),recoveryBudget:{...v.run.recoveryBudget,consumed:v.run.recoveryBudget.consumed+1},history:[...v.run.history,event("RECOVERING",input.reason,[`checkpoint=${step.stepId}`])]};
      return v.run;
    });
  }
  async humanDecision(id:string,input:{actor:string;decision:"OK"|"NG";reason?:string|undefined}) {
    return this.update(n=>{
      const v=n.runs.find(x=>x.run.runId===id);if(!v)throw Error("run absent");
      if(v.run.status!=="WAITING_HUMAN"||!v.run.currentStep)throw Error("run is not waiting for Human");
      if(!/^[A-Za-z0-9_.@-]{1,100}$/.test(input.actor)||input.reason&&input.reason.length>500)throw Error("invalid Human decision");
      const step=v.steps.find(s=>s.stepId===v.run.currentStep);if(!step)throw Error("checkpoint unavailable");const at=new Date().toISOString();
      if(input.decision==="OK")v.run={...v.run,status:"SUCCEEDED",currentStep:null,humanGate:null,completedSteps:[...new Set([...v.run.completedSteps,step.stepId])],updatedAt:at,history:[...v.run.history,event("HUMAN_GATE_OK",`${input.actor}: ${input.reason??"accepted"}`,[])]};
      else v.run={...v.run,status:"QUEUED",queuedActor:actor(step),queuedStep:step.stepId,humanGate:null,updatedAt:at,history:[...v.run.history,event("HUMAN_GATE_NG",`${input.actor}: ${input.reason??"rejected; repair required"}`,[])]};
      return v.run;
    });
  }
  private async update<T>(fn: (n: Snapshot) => T) {
    const op = this.pending.then(async () => {
      const n = structuredClone(this.snapshot),
        r = fn(n);
      n.runs.forEach((v) => assertRunInvariant(v.run));
      await persist(this.path, n);
      this.snapshot = n;
      return structuredClone(r);
    });
    this.pending = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }
}
export class SelfCommissioningOrchestrator {
  private inflight = new Map<string, Promise<SelfCommissioningRun>>();
  constructor(
    private store: DurableSelfCommissioningStore,
    private executors: CommissioningExecutors,
  ) {}
  async create(i: {
    runId: string;
    objective: string;
    steps: SelfCommissioningStep[];
    retryLimit: number;
  }) {
    validate(i);
    const at = new Date().toISOString(),
      s = i.steps[0]!,
      run: SelfCommissioningRun = {
        runId: i.runId,
        objective: i.objective,
        status: "QUEUED",
        currentStep: s.stepId,
        activeActor: null,
        activeExecutionId: null,
        queuedActor: actor(s),
        queuedStep: s.stepId,
        startedAt: at,
        updatedAt: at,
        completedSteps: [],
        failedStep: null,
        blocker: null,
        humanGate: null,
        retryBudget: { limit: i.retryLimit, consumed: 0 },
        recoveryBudget: { limit: 3, consumed: 0 },
        history: [event("CREATED", "Durable objective registered", [])],
      };
    return this.store.create({ run, steps: structuredClone(i.steps) });
  }
  async tick(id: string) {
    const active = this.inflight.get(id);
    if (active) return active;
    const op = this.once(id);
    this.inflight.set(id, op);
    try {
      return await op;
    } finally {
      this.inflight.delete(id);
    }
  }
  async setKillSwitch(v: boolean) {
    await this.store.setEnabled(v);
  }
  async block(id: string, reason: string) {
    const v = await this.store.stored(id);
    if (!v) throw Error("run absent");
    const run = {
      ...v.run,
      status: "BLOCKED" as const,
      activeActor: null,
      activeExecutionId: null,
      queuedActor: null,
      queuedStep: null,
      failedStep: v.run.currentStep,
      blocker: safe(reason),
      updatedAt: new Date().toISOString(),
      history: [...v.run.history, event("READINESS_BLOCKED", reason, [])],
    };
    return this.store.replace({ ...v, run });
  }
  private async once(id: string) {
    const v = await this.store.stored(id);
    if (!v) throw Error("run absent");
    if (v.run.status !== "QUEUED") return v.run;
    if (!(await this.store.enabled())) {
      const run = {
        ...v.run,
        status: "BLOCKED" as const,
        queuedActor: null,
        queuedStep: null,
        failedStep: v.run.currentStep,
        blocker: "Autonomous dispatch kill switch is disabled",
        updatedAt: new Date().toISOString(),
        history: [
          ...v.run.history,
          event("KILL_SWITCH", "New dispatch prevented", []),
        ],
      };
      return this.store.replace({ ...v, run });
    }
    const step = v.steps.find((s) => s.stepId === v.run.currentStep);
    if (!step) throw Error("checkpoint unavailable");
    const eid = identity(v.run, step),
      running: SelfCommissioningRun = {
        ...v.run,
        status: "RUNNING",
        activeActor: actor(step),
        activeExecutionId: eid,
        queuedActor: null,
        queuedStep: null,
        blocker: null,
        humanGate: null,
        updatedAt: new Date().toISOString(),
        history: [
          ...v.run.history,
          event("DISPATCHED", step.kind + " dispatched", []),
        ],
      };
    await this.store.replace({ ...v, run: running });
    let result: CommissioningResult;
    try {
      result =
        step.kind === "TX_OPERATION"
          ? await this.executors.tx(step.request, eid)
          : step.kind === "GTX_OPERATION"
            ? await this.executors.gtx(step.request, eid)
            : await this.executors.codex(structuredClone(step.job), eid);
    } catch (e) {
      result = {
        status: "FAILED",
        summary: e instanceof Error ? e.message : "executor failure",
        evidence: [],
        retryable: true,
      };
    }
    return this.finish({ ...v, run: running }, step, result);
  }
  private async finish(
    v: Stored,
    step: SelfCommissioningStep,
    r: CommissioningResult,
  ) {
    const base = {
      ...v.run,
      activeActor: null,
      activeExecutionId: null,
      updatedAt: new Date().toISOString(),
      history: [...v.run.history, event("RESULT", r.summary, r.evidence)],
    };
    let run: SelfCommissioningRun;
    if (r.status === "SUCCEEDED") {
      const done = [...v.run.completedSteps, step.stepId],
        next = v.steps.find((s) => !done.includes(s.stepId));
      run = next
        ? {
            ...base,
            status: "QUEUED",
            currentStep: next.stepId,
            queuedActor: actor(next),
            queuedStep: next.stepId,
            completedSteps: done,
          }
        : {
            ...base,
            status: "SUCCEEDED",
            currentStep: null,
            queuedActor: null,
            queuedStep: null,
            completedSteps: done,
          };
    } else if (r.status === "WAITING_HUMAN")
      run = {
        ...base,
        status: "WAITING_HUMAN",
        queuedActor: null,
        queuedStep: null,
        humanGate: safe(r.humanGate ?? r.summary),
      };
    else if (r.status === "BLOCKED")
      run = {
        ...base,
        status: "BLOCKED",
        queuedActor: null,
        queuedStep: null,
        failedStep: step.stepId,
        blocker: safe(r.blocker ?? r.summary),
      };
    else if (
      r.retryable &&
      v.run.retryBudget.consumed < v.run.retryBudget.limit
    )
      run = {
        ...base,
        status: "QUEUED",
        queuedActor: actor(step),
        queuedStep: step.stepId,
        retryBudget: {
          ...v.run.retryBudget,
          consumed: v.run.retryBudget.consumed + 1,
        },
      };
    else if (r.retryable)
      run = {
        ...base,
        status: "BLOCKED",
        queuedActor: null,
        queuedStep: null,
        failedStep: step.stepId,
        blocker: "Autonomous retry budget exhausted",
      };
    else
      run = {
        ...base,
        status: "FAILED",
        queuedActor: null,
        queuedStep: null,
        failedStep: step.stepId,
        blocker: safe(r.summary),
      };
    return this.store.replace({ ...v, run });
  }
}
export function failureRevision(run:SelfCommissioningRun){return createHash("sha256").update(`${run.runId}\0${run.failedStep??""}\0${run.blocker??""}\0${run.retryBudget.consumed}`).digest("hex").slice(0,24)}
function actor(s: SelfCommissioningStep): RunActor {
  return s.kind === "TX_OPERATION"
    ? "TX66KWH"
    : s.kind === "GTX_OPERATION"
      ? "GTX1060"
      : s.kind === "CODEX_JOB"
        ? "CODEX"
        : "LCC";
}
function identity(r: SelfCommissioningRun, s: SelfCommissioningStep) {
  return createHash("sha256")
    .update(r.runId + "\0" + s.stepId + "\0" + r.retryBudget.consumed)
    .digest("hex")
    .slice(0, 32);
}
function safe(v: string) {
  return redact(v, 500);
}
function event(type: string, summary: string, evidence: readonly string[]) {
  return {
    type,
    at: new Date().toISOString(),
    summary: safe(summary),
    evidence: evidence.slice(0, 10).map(safe),
  };
}
function validate(i: {
  runId: string;
  objective: string;
  steps: SelfCommissioningStep[];
  retryLimit: number;
}) {
  if (
    !/^[\w.-]{1,100}$/.test(i.runId) ||
    !i.objective.trim() ||
    i.objective.length > 500 ||
    !Number.isInteger(i.retryLimit) ||
    i.retryLimit < 0 ||
    i.retryLimit > 3 ||
    !i.steps.length ||
    i.steps.length > 50 ||
    new Set(i.steps.map((s) => s.stepId)).size !== i.steps.length
  )
    throw Error("invalid bounded run");
  for (const s of i.steps)
    if (
      !/^[\w.-]{1,100}$/.test(s.stepId) ||
      ((s.kind === "CODEX_JOB" || s.kind === "SUPERVISOR_OPERATION") &&
        unsafeJob(s.job))
    )
      throw Error("unsafe step");
}
function unsafeJob(job: CodexJob) {
  const allowed = new Set([
      "objective",
      "repository",
      "workspaceId",
      "policy",
      "operation",
      "issueNumber",
      "sourceRevision",
      "humanGate",
    ]),
    policyKeys = Object.keys(job.policy);
  return (
    Object.keys(job).some((key) => !allowed.has(key)) ||
    !/^[\w.-]+\/[\w.-]+$/.test(job.repository) ||
    !/^[\w.-]+$/.test(job.workspaceId) ||
    !job.objective.trim() ||
    policyKeys.length !== 4 ||
    job.policy.allowCommit !== true ||
    typeof job.policy.allowPush!=="boolean" ||
    typeof job.policy.allowMerge!=="boolean" ||
    typeof job.policy.allowDeploy!=="boolean" ||
    (job.issueNumber!==undefined&&(!Number.isInteger(job.issueNumber)||job.issueNumber<1)) ||
    ((job.policy.allowPush||job.policy.allowMerge||job.policy.allowDeploy)&&(!job.issueNumber||!job.sourceRevision||!["knys/luckountry-control-center","knys/TOBIE"].includes(job.repository))) ||
    (job.policy.allowMerge&&!job.policy.allowPush) ||
    (job.policy.allowDeploy&&!job.policy.allowMerge)
  );
}
async function persist(path: string, v: Snapshot) {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(v, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o660,
  });
  await rename(temp, path);
  // The API and the dedicated Watcher intentionally use different OS users
  // in the same restricted `luckountry` group. chmod after rename avoids the
  // service umask silently removing the group-write bit from their shared SSOT.
  await chmod(path, 0o660);
}
