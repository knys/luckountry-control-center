# LCC-005 TDD and acceptance evidence

Issue #10 is the SSOT. This change deliberately provides only the execution gate, fake executor boundary, durable lease/history, lifecycle mapping, and read-only observability. It does not start Codex, a shell, or a remote worker.

## RED

On 2026-09-03, `npm test` compiled the project and ran the existing nine suites successfully. The new `execution-gate.test.ts` suite then failed at runtime with `LCC-005 execution gate not implemented`. This was a valid behavioral RED: TypeScript compilation, imports, and the Node test runner were working. The placeholder was replaced only after this result was observed.

## GREEN and refactor

The application layer now owns deterministic eligibility and orchestration interfaces. The durable infrastructure implementation serializes eligibility re-check, `EXECUTION_STARTED`, lease creation, and history creation in one atomic snapshot write. Executor completion and its semantic WorkEvent are also one atomic write. Source synchronization merges only source fields and therefore cannot roll execution state back.

Schema v3 adds top-level `execution.leases` and `execution.records`. The explicit v2→v3 migration preserves all repositories and WorkItems and creates no lease. Its atomic replacement means a failed migration write leaves the v2 file intact. Invalid/unknown snapshots fail; they are never reset.

## Test Matrix / Acceptance

| AC | Result | Evidence / test |
|---|---|---|
| AC-01 | PASS | T01 gate matrix requires READY/CODEX/EXECUTE/aiExecutable |
| AC-02 | PASS | T02 aiExecutable alone rejected |
| AC-03 | PASS | T03 capability coverage |
| AC-04 | PASS | T04 unmapped repository rejected |
| AC-05 | PASS | T05 explicit repository/workspace target |
| AC-06 | PASS | T06 unavailable worker; executor not invoked |
| AC-07 | PASS | T07 active WorkItem lease |
| AC-08 | PASS | T08 exclusive repository lease |
| AC-09 | PASS | T09 two deterministic concurrent acquisitions yield one executor call |
| AC-10 | PASS | T10 failed durable lease write leaves READY |
| AC-11 | PASS | T11 executor observes State Machine-produced RUNNING |
| AC-12 | PASS | T12 transition/write failure makes zero executor calls |
| AC-13 | PASS | T13 Fake Executor receives workspaceId and structured action, no path |
| AC-14 | PASS | T14 SUCCEEDED → VERIFYING, never DONE |
| AC-15 | PASS | T15 retryable failure → FAILED semantic event |
| AC-16 | PASS | T16 terminal failure is FAILED, not success |
| AC-17 | PASS | T17 timeout → FAILED; worker loss → WAITING_WORKER |
| AC-18 | PASS | T18 durable execution history restored |
| AC-19 | PASS | T19 active lease restored and gate refuses redispatch |
| AC-20 | PASS | T20 restored orphan remains observable and is not automatically run |
| AC-21 | PASS | T21 completion write failure exposes prior atomic RUNNING/ACTIVE snapshot only |
| AC-22 | PASS | T22 sync during deferred execution preserves RUNNING/lease and updates source |
| AC-23 | PASS | T23 cloned read-only API response contains no token/env/stdout/stderr |
| AC-24 | PASS | T24 shutdown rejects new dispatch |
| AC-25 | PASS | T25 shutdown awaits deferred Fake Executor |
| AC-26 | PASS | T26 full LCC-001–004 suite |
| AC-27 | PASS | T27 `npm test`, `npm run typecheck`, and `npm run build` |

The v2→v3 migration test also proves WorkItem preservation, empty lease initialization, and persisted schema version. Existing corruption, unknown-version, and migration-failure preservation tests remain in the regression suite.
