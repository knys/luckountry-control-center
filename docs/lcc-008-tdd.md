# LCC-008 acceptance test matrix

Issue #16 is the SSOT. A checked GitHub checkbox, process exit zero, or Codex prose is never promotion evidence.

| AC | Automated contract |
|---|---|
| 01 | AutomationMode defaults disabled; production is reserved |
| 02 | Pilot requires one exact scope and both execution flags |
| 03 | Malformed, multiple, or expired scope fails closed |
| 04 | Only exact repository/externalId matches |
| 05 | Both `lcc:pilot` and `lcc:ready` are required |
| 06 | All deterministic Definition headings and Coding Ready YES are required |
| 07 | Missing/malformed Acceptance cannot become READY |
| 08 | Valid scoped DEFINED item becomes READY/CODEX without an LLM |
| 09 | Unrelated READY items never execute |
| 10 | Unrelated VERIFYING items never verify |
| 11 | Execution and verification budgets prevent repeats |
| 12 | Expiry, kill switch, or removed readiness prevents dispatch |
| 13 | Durable cycle restart retains its exact target |
| 14 | Schema v1-v4 migration preserves prior state |
| 15 | Candidate branch is deterministic and is not base |
| 16 | Pilot prompt prohibits merge, close, deploy, release, and dangerous bypass |
| 17 | Candidate/base postcondition failure rejects success |
| 18 | Bounded branch/baseHead/candidateHead evidence is durable |
| 19 | Verification HEAD must equal candidateHead |
| 20 | Pilot AUTO PASS persists evidence then waits for Human, never DONE |
| 21 | Failure cannot loop after budget exhaustion |
| 22 | Automation control API is read-only, bounded, and secret/path safe |
| 23 | Kill switch preserves active/history records |
| 24 | No-promotion preflight and base-ref movement detection |
| 25 | Windows installer is idempotent and separates ports 9200/9100 |
| 26 | Worker secret is absent from command line and logs |
| 27 | Disable/uninstall never removes product workspaces |
| 28 | LCC-001 through LCC-007 regressions remain green |
| 29 | TypeScript typecheck |
| 30 | Production build |
| 31 | Human: persistent non-TTY GTX1060 lifecycle |
| 32 | Human: one real scoped Issue completes automated execution/verification |
| 33 | Human: WAITING_HUMAN with verified candidate while base is unchanged |
| 34 | Human: unrelated eligible item is not dispatched |
| 35 | Human: kill switch prevents additional dispatch |

## Controlled production Pilot Recovery acceptance

Recovery is an explicit Human-approved, exact one-shot operation for the existing
failed cycle. `WORK_PILOT_RECOVERY_ID` must equal that cycle's `cycleId`; it is not
an automatic scanner retry and it cannot create, delete, or retarget a cycle.

Execution budget counts dispatches, including a Worker preflight/setup failure
before Codex starts. The original dispatch therefore remains attempt 1. A valid
Recovery grants exactly one additional dispatch to the same cycle (at most one
Recovery grant per cycle); it never resets counters. The effective execution
limit is `maxExecutionAttempts + consumedRecoveryGrant`, so the Human exception is
explicit, durable, and bounded.

| Recovery AC | Automated contract |
|---|---|
| R01 | FAILED WorkItem plus matching FAILED cycle is identifiable as a Recovery candidate |
| R02 | A non-FAILED cycle is rejected |
| R03 | Scope fingerprint mismatch is rejected |
| R04 | WorkItem mismatch is rejected |
| R05 | Recovery cannot act on an unrelated item |
| R06 | Recovery uses `RETRY_STARTED` for FAILED -> RETRYING |
| R07 | Execution acquisition uses canonical RETRYING -> RUNNING |
| R08 | WorkItem, cycle, execution, verification, and retry history is retained |
| R09 | The previous execution record remains unchanged |
| R10 | A duplicate Recovery request is idempotently rejected |
| R11 | Durable consumption prevents a second Recovery after restart |
| R12 | An expired scope rejects Recovery |
| R13 | Missing required labels reject Recovery |
| R14 | Worker, workspace, or verification profile not ready rejects Recovery |
| R15 | Disabled automation never dispatches Recovery work |
| R16 | Dispatch-count budget plus one durable Recovery grant is strictly bounded |
| R17 | Terminal/non-retryable and post-Codex implementation failures reject Recovery |
| R18 | Read-only observability is bounded and excludes secrets, paths, environment, and HMAC material |
| R19 | LCC-001 through LCC-008 regression remains green |
| R20 | Production flags continue to default false until the real Pilot Recovery is explicitly run |
