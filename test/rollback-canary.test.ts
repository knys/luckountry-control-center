import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Issue 75 rollback checklist covers all required evidence", async () => {
  const checklist = await readFile("docs/lcc-v2-rollback-canary.md", "utf8");
  const concepts = [
    "Retained v1 artifacts",
    "Retained v2 state",
    "Service health",
    "Dashboard consistency",
    "Main revision",
  ];

  for (const concept of concepts) {
    assert.match(checklist, new RegExp(`^- \\[ \\] \\*\\*${concept}:\\*\\*`, "m"));
  }
});
