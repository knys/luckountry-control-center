# LCC-004 Work State Machine evidence

## RED

- Date: 2026-09-03 (Asia/Tokyo)
- Command: `npm test`
- Compile/import/test runner: PASS after correcting an empty-tuple stub typing issue; the earlier compile failure was discarded.
- LCC-001 through LCC-003 suites: PASS
- New state-machine suite: FAIL because `LCC-004 state machine not implemented` was raised.

## Domain and migration decisions

The state machine is pure and accepts only a WorkItem plus a semantic WorkEvent. GitHub, HTTP, filesystem, timers, and executors are absent from the Domain implementation. New source records start as DEFINED/HUMAN/DEFINE/non-executable. READY requires `DEFINITION_COMPLETED`.

Schema v2 stores structured NextAction and transitionReason. Migration is explicit and atomic. Legacy READY is changed to DEFINED because schema v1 cannot prove that a Coding Ready Gate occurred. Active RUNNING is retained; ACCEPTANCE becomes VERIFYING/HUMAN; WAITING becomes WAITING_HUMAN; BLOCKED, DONE, and UNKNOWN retain their safe canonical meanings. Migration validation or persistence failure leaves the v1 snapshot intact.

Source sync and execution transitions are serialized by the repository. `commitSync` merges source fields with the latest stored execution fields inside that boundary; `transitionExecutionState` updates execution state in the same atomic snapshot transaction.

## Acceptance verification

| AC | Result | Evidence / Test |
| --- | --- | --- |
| AC-01 | PASS | Canonical states, T01 |
| AC-02 | PASS | Canonical holders including LCC, T02 |
| AC-03 | PASS | Structured action, T03 |
| AC-04 | PASS | Allowed matrix, T04 |
| AC-05 | PASS | Domain error, T05 |
| AC-06 | PASS | RUNNING cannot skip VERIFYING, T06 |
| AC-07 | PASS | Deterministic decision/reason, T07 |
| AC-08 | PASS | Human verification decision, T08 |
| AC-09 | PASS | Automated verification/LCC, T09 |
| AC-10 | PASS | Worker monitoring/LCC, T10 |
| AC-11 | PASS | RETRYING/LCC/RETRY, T11 |
| AC-12 | PASS | DONE/NONE/NONE, T12 |
| AC-13 | PASS | Safe new Issue, T13 |
| AC-14 | PASS | Explicit ready event, T14 |
| AC-15 | PASS | Atomic durable transition, T15 |
| AC-16 | PASS | Restart restore, T16 |
| AC-17 | PASS | Source sync preserves execution, T17 |
| AC-18 | PASS | Deterministic concurrent race, T18 |
| AC-19 | PASS | Failed writer preserves snapshot, T19 |
| AC-20 | PASS | Explicit v1→v2 migration, T20 |
| AC-21 | PASS | Failed migration preserves bytes; unknown/corrupt regression, T21 |
| AC-22 | PASS | Read-only `/api/work-items` and clone isolation, T22 |
| AC-23 | PASS | Existing LCC-001–003 suites, T23 |
| AC-24 | PASS | Full verification commands, T24 |
