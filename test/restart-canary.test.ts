import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Issue 78 restart canary documents the durable recovery lifecycle", async () => {
  const evidence = await readFile("docs/lcc-v2-restart-canary.md", "utf8");
  const lifecycleTerms = [
    "ACTIVE",
    "process",
    "termination",
    "FAILED_RETRYABLE",
    "bounded retry",
    "new Lease",
    "new PID",
    "new Heartbeat",
    "persistent Job ID",
  ];

  for (const term of lifecycleTerms) {
    assert.match(evidence, new RegExp(term, "i"), `missing restart lifecycle term: ${term}`);
  }
});
