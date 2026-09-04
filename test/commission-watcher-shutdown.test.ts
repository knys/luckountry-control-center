import assert from "node:assert/strict";
import test from "node:test";
import { InterruptibleWait } from "../src/application/interruptible-wait.js";
import { readFile } from "node:fs/promises";

test("Issue 31 graceful shutdown interrupts an idle watcher wait", async () => {
  const sleeper = new InterruptibleWait();
  let completed = false;
  const waiting = sleeper.wait(60_000).then(() => { completed = true; });
  sleeper.cancel();
  await waiting;
  assert.equal(completed, true);
});

test("Issue 31 dispatches AI-safe implementation even when later Human acceptance is declared", async () => {
  const source = await readFile("src/application/commission-watcher.ts", "utf8");
  assert.doesNotMatch(source, /commissionState===\"COMMISSIONED\"&&v\.runId&&!v\.humanGate/);
  assert.match(source, /allRuns\.filter\(v=>v\.status===\"WAITING_HUMAN\"\)/);
  assert.match(source, /v\.dependsOn\.every/);
});
