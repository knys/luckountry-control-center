import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Issue 80 documents the dashboard consistency contract", async () => {
  const contract = await readFile("docs/lcc-v2-dashboard-consistency-canary.md", "utf8");
  const consistencyRules = [
    /Queue Depth:[^\n]*only Jobs[^\n]*`QUEUED`/i,
    /ACTIVE:[^\n]*only when[^\n]*PID is live[^\n]*Heartbeat[^\n]*Lease[^\n]*fresh/i,
    /Ball Holder:[^\n]*only when[^\n]*valid Lease[^\n]*next action/i,
    /GitHub completion:[^\n]*only when[^\n]*(?:Pull Request \(PR\)|PR)[^\n]*(?:continuous integration \(CI\)|CI)[^\n]*main(?:-branch)? evidence/i,
  ];

  for (const rule of consistencyRules) {
    assert.match(contract, rule, `missing dashboard consistency rule: ${rule}`);
  }
});
