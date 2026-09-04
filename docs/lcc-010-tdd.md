# LCC-010 Persistent Codex Dispatcher Acceptance / TDD Matrix

SSOT: GitHub Issue #21. LCC-008 real acceptance remains paused while this
dispatcher is implemented and proven. Existing LCC-009 run, operation,
checkpoint, evidence, retry, and actor-truth contracts are reused unchanged.

| AC | Behavioral test | Observable contract |
|---|---|---|
| AC-01 | dispatcher reopen/resume | A RUNNING checkpoint is truthfully restored to QUEUED and resumes without repeating completed steps. |
| AC-02 | CODEX terminal -> next step | A successful whole CODEX_JOB automatically dispatches the next allowlisted Supervisor step. |
| AC-03 | concurrent start | One deterministic execution identity is dispatched once. |
| AC-04 | retry/restart | Retry consumption is durable, bounded to the run budget, and never replenished by restart. |
| AC-05 | kill switch | Disabling dispatch prevents the next queued step while preserving run history. |
| AC-06 | terminal dispositions | BLOCKED and WAITING_HUMAN stop dispatch and retain an exact safe reason. |
| AC-07 | evidence | Every checkpoint is reported through the existing bounded/redacted durable outbox path. |
| AC-08 | unsafe input | Dispatcher accepts only an already-validated allowlisted run graph; no command, argv, cwd, or environment surface exists. |
| AC-09 | regression | LCC-001 through LCC-009 suites remain green. |
| AC-10 | one-start three-step acceptance | One bootstrap/start executes at least three consecutive production-domain Supervisor steps with no Human transport. |

Merge remains prohibited until real zero-bridge acceptance passes. Product
deployment, automatic merge, Issue close, scope/budget expansion, and arbitrary
shell execution remain out of scope.
