import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GtxWorkerMaintenanceService, type GtxFixedCommand, type GtxMaintenanceContext } from "../src/worker/maintenance.js";
import { HmacVerifier, signRequest } from "../src/infrastructure/hmac-auth.js";
import { createWorkerHandler } from "../src/worker/http-server.js";

const sha = "a".repeat(40);
const descriptor = { workerId: "gtx1060", status: "ONLINE" as const, capabilities: ["CODE_EDIT"], workspaceIds: ["tobie-pilot"], executorKinds: ["CODEX", "VERIFICATION"] };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gtx-maintenance-")), commands: GtxFixedCommand[] = [];
  const execution = join(dir, "executions.json"), verification = join(dir, "verifications.json"), product = join(dir, "product-marker");
  await writeFile(execution, "execution-history"); await writeFile(verification, "verification-history"); await writeFile(product, "product-workspace");
  const context: GtxMaintenanceContext = {
    workerRepositoryPath: join(dir, "worker-repository"), allowedRefs: [sha], allowedWorkspaceIds: ["tobie-pilot"],
    storePath: join(dir, "maintenance.json"), protectedPaths: [execution, verification, product],
    gitExecutable: "C:\\Program Files\\Git\\cmd\\git.exe", nodeExecutable: "C:\\Program Files\\nodejs\\node.exe", restartHelperExecutable: "C:\\LCC\\worker-maintenance.exe",
    run: async command => { commands.push(command); return { code: 0, stdout: "ok token=hidden C:\\Users\\private\\file", stderr: "" }; },
    status: async () => ["worker online"], descriptor: async () => descriptor,
    preflight: async workspaceId => ({ branch: "main", head: workspaceId === "tobie-pilot" ? sha : "bad" })
  };
  return { dir, commands, context, execution, verification, product, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("L009-05 maintenance store cannot overlap execution verification or product state", async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.throws(() => new GtxWorkerMaintenanceService({ ...f.context, storePath: f.execution }), /protected|state|workspace/i);
});

test("L009-05 typed allowlists reject arbitrary shell ref workspace cwd and environment", async t => {
  const f = await fixture(); t.after(f.cleanup); const service = new GtxWorkerMaintenanceService(f.context);
  for (const value of [
    { operation: "POWERSHELL", idempotencyKey: "x", command: "pwsh" },
    { operation: "GTX_WORKER_STATUS", idempotencyKey: "x", cwd: "C:\\" },
    { operation: "GTX_WORKER_BUILD", idempotencyKey: "x", environment: { SECRET: "x" } },
    { operation: "GTX_WORKER_UPDATE_EXACT_REF", idempotencyKey: "x", exactRef: "main" },
    { operation: "GTX_WORKSPACE_PREFLIGHT", idempotencyKey: "x", workspaceId: "unknown" }
  ]) await assert.rejects(service.execute(value), /reject|allow|unknown/i);
  assert.equal(f.commands.length, 0);
});

test("GTX operations are bounded idempotent and preserve execution verification and product state", async t => {
  const f = await fixture(); t.after(f.cleanup); const service = new GtxWorkerMaintenanceService(f.context);
  for (const value of [
    { operation: "GTX_WORKER_UPDATE_EXACT_REF", idempotencyKey: "u", exactRef: sha },
    { operation: "GTX_WORKER_BUILD", idempotencyKey: "b" },
    { operation: "GTX_WORKER_RESTART", idempotencyKey: "r" },
    { operation: "GTX_WORKER_DESCRIPTOR", idempotencyKey: "d" },
    { operation: "GTX_WORKSPACE_PREFLIGHT", idempotencyKey: "p", workspaceId: "tobie-pilot" }
  ] as const) {
    const result = await service.execute(value); assert.equal(result.status, "SUCCEEDED");
    assert.ok(result.evidence.every(v => v.length <= 500)); assert.doesNotMatch(JSON.stringify(result), /hidden|C:\\Users/i);
  }
  const count = f.commands.length; await service.execute({ operation: "GTX_WORKER_BUILD", idempotencyKey: "b" });
  await new GtxWorkerMaintenanceService(f.context).execute({ operation: "GTX_WORKER_BUILD", idempotencyKey: "b" });
  assert.equal(f.commands.length, count); assert.equal(await readFile(f.execution, "utf8"), "execution-history");
  assert.equal(await readFile(f.verification, "utf8"), "verification-history"); assert.equal(await readFile(f.product, "utf8"), "product-workspace");
  assert.ok(f.commands.every(v => v.timeoutMs > 0 && v.timeoutMs <= 20 * 60_000 && v.cwd === f.context.workerRepositoryPath));
});

async function invoke(handler: ReturnType<typeof createWorkerHandler>, body: string, headers: object) {
  const req = Object.assign(Readable.from([body]), { method: "POST", url: "/v1/maintenance", headers }) as unknown as IncomingMessage;
  let code = 0, text = ""; await handler(req, { writeHead: (v: number) => code = v, end: (v?: string) => text = v ?? "" } as unknown as ServerResponse);
  return { code, text };
}
test("GTX maintenance endpoint requires HMAC authentication and rejects replay", async t => {
  const f = await fixture(); t.after(f.cleanup); const credentials = { keyId: "lcc", secret: "secret" };
  const verifier = new HmacVerifier(credentials, 60_000, () => 1000), service = new GtxWorkerMaintenanceService(f.context);
  const handler = createWorkerHandler({ descriptor } as never, verifier, undefined, service);
  const body = JSON.stringify({ operation: "GTX_WORKER_STATUS", idempotencyKey: "status" }), headers = signRequest(credentials, "POST", "/v1/maintenance", body, 1000, "nonce");
  assert.equal((await invoke(handler, body, {})).code, 401); assert.equal((await invoke(handler, body, headers)).code, 200); assert.equal((await invoke(handler, body, headers)).code, 401);
});

test("GTX interrupted durable operation resumes after restart with one concurrent dispatch", async t => {
  const f = await fixture(); t.after(f.cleanup); let calls = 0, release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await writeFile(f.context.storePath, JSON.stringify({ version: 1, results: [{ idempotencyKey: "resume", operation: "GTX_WORKER_STATUS", status: "RUNNING", startedAt: "a", finishedAt: null, summary: "interrupted", evidence: [] }] }));
  f.context.status = async () => { calls++; await gate; return ["online"]; }; const service = new GtxWorkerMaintenanceService(f.context);
  const first = service.execute({ operation: "GTX_WORKER_STATUS", idempotencyKey: "resume" }), second = service.execute({ operation: "GTX_WORKER_STATUS", idempotencyKey: "resume" });
  while (!calls) await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release(); assert.deepEqual(await first, await second);
  assert.equal((await new GtxWorkerMaintenanceService(f.context).execute({ operation: "GTX_WORKER_STATUS", idempotencyKey: "resume" })).status, "SUCCEEDED"); assert.equal(calls, 1);
});
