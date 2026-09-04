import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionRequest, ExecutionResultStatus } from "../application/execution.js";

export type WorkerExecutionStatus = "QUEUED" | "RUNNING" | ExecutionResultStatus | "LOST";
export interface WorkerExecutionRecord { executionId: string; workspaceId: string; requestDigest: string; status: WorkerExecutionStatus; startedAt: string | null; finishedAt: string | null; summary: string; evidence: string[];codexStatus?:ExecutionResultStatus;finalAgentMessage?:string;baseHead?:string;candidateBranch?:string;candidateHead?:string }
interface WorkerSnapshot { version: 1; executions: WorkerExecutionRecord[] }
export function executionRequestDigest(request: ExecutionRequest): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
export class WorkerExecutionStore {
  private pending = Promise.resolve();
  private constructor(private readonly path: string, private snapshot: WorkerSnapshot) {}
  static async open(path: string): Promise<WorkerExecutionStore> { let snapshot: WorkerSnapshot; try { snapshot = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; snapshot = { version: 1, executions: [] }; await persist(path, snapshot); } if (snapshot.version !== 1 || !Array.isArray(snapshot.executions)) throw new Error("invalid worker execution store"); for (const item of snapshot.executions) if (item.status === "RUNNING" || item.status === "QUEUED") { item.status = "LOST"; item.finishedAt = new Date().toISOString(); item.summary = "Worker restarted before execution completion"; } await persist(path, snapshot); return new WorkerExecutionStore(path, snapshot); }
  async list(): Promise<WorkerExecutionRecord[]> { await this.pending; return structuredClone(this.snapshot.executions); }
  async get(id: string): Promise<WorkerExecutionRecord | null> { return (await this.list()).find(item => item.executionId === id) ?? null; }
  async active(workspaceId:string):Promise<boolean>{return(await this.list()).some(item=>item.workspaceId===workspaceId&&["QUEUED","RUNNING"].includes(item.status));}
  async create(request: ExecutionRequest): Promise<{ record: WorkerExecutionRecord; created: boolean }> { return this.update(next => { const digest = executionRequestDigest(request), old = next.executions.find(item => item.executionId === request.executionId); if (old) { if (old.requestDigest !== digest) throw new WorkerConflictError(); return { record: old, created: false }; } if (next.executions.some(item => ["QUEUED", "RUNNING"].includes(item.status) && item.workspaceId === request.workspaceId)) throw new WorkerBusyError(); const record: WorkerExecutionRecord = { executionId: request.executionId, workspaceId: request.workspaceId, requestDigest: digest, status: "QUEUED", startedAt: null, finishedAt: null, summary: "Queued", evidence: [] }; next.executions.push(record); return { record, created: true }; }); }
  async patch(id: string, change: (record: WorkerExecutionRecord) => void): Promise<WorkerExecutionRecord> { return this.update(next => { const record = next.executions.find(item => item.executionId === id); if (!record) throw new Error("execution not found"); change(record); record.summary = record.summary.slice(0, 500); record.evidence = record.evidence.slice(0, 10).map(item => item.slice(0, 500));if(record.finalAgentMessage)record.finalAgentMessage=record.finalAgentMessage.slice(0,500); return record; }); }
  private async update<T>(change: (next: WorkerSnapshot) => T): Promise<T> { const operation = this.pending.then(async()=>{ const next=structuredClone(this.snapshot), result=change(next); await persist(this.path,next); this.snapshot=next; return structuredClone(result); }); this.pending=operation.then(()=>undefined,()=>undefined); return operation; }
}
export class WorkerConflictError extends Error { readonly statusCode=409; constructor(){super("executionId request digest conflict");} }
export class WorkerBusyError extends Error { readonly statusCode=409; constructor(){super("workspace already executing");} }
async function persist(path: string, snapshot: WorkerSnapshot): Promise<void> { await mkdir(dirname(path),{recursive:true}); const temporary=`${path}.${randomUUID()}.tmp`; await writeFile(temporary,`${JSON.stringify(snapshot,null,2)}\n`,{encoding:"utf8",mode:0o600}); await rename(temporary,path); }
