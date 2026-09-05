import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Issue 74 runtime note names the durable lifecycle terms", async () => {
  const operatorNote = await readFile("docs/lcc-v2-runtime-canary.md", "utf8");
  const lifecycleTerms = ["Lease", "Heartbeat", "COMPLETED"];

  for (const term of lifecycleTerms) {
    assert.match(operatorNote, new RegExp(`\\b${term}\\b`), `missing lifecycle term: ${term}`);
  }
});
