import assert from "node:assert/strict";
import test from "node:test";
import { InterruptibleWait } from "../src/application/interruptible-wait.js";

test("Issue 31 graceful shutdown interrupts an idle watcher wait", async () => {
  const sleeper = new InterruptibleWait();
  let completed = false;
  const waiting = sleeper.wait(60_000).then(() => { completed = true; });
  sleeper.cancel();
  await waiting;
  assert.equal(completed, true);
});
