# LCC-003 polling runtime evidence

## RED

- Date: 2026-09-03 (Asia/Tokyo)
- Command: `npm test`
- Compile/import/test runner: PASS after adding an explicit return type to the composition stub. The earlier compile-only failure was discarded and is not RED evidence.
- Existing devices, durable repository, issue sync, parsers, and products suites: PASS
- New runtime and composition suites: FAIL
- Failure reason: `LCC-003 polling runtime not implemented`, `LCC-003 production composition not implemented`, and the runtime API/credential injection contract were not connected.

This RED state was caused by missing requested runtime behavior, not syntax, imports, environment setup, or the test runner. All scheduling tests use a deterministic fake scheduler and no real sleep.

## GREEN and acceptance verification

| AC | Result | Evidence | Test |
| --- | --- | --- | --- |
| AC-01 | PASS | Composition opens durable storage and connects adapter, sync service, and runtime | T01 |
| AC-02 | PASS | Non-null manifest repositories are deduplicated | T02 |
| AC-03 | PASS | `start()` begins every repository immediately | T03 |
| AC-04 | PASS | Successful completion schedules the configured cadence | T04 |
| AC-05 | PASS | A repository receives no timer until its in-flight poll settles | T05 |
| AC-06 | PASS | Repository failures are caught independently | T06 |
| AC-07 | PASS | Network backoff grows from 30 seconds and caps at 15 minutes; invalid/unknown use the same bounded policy | T07 and transient-policy test |
| AC-08 | PASS | Rate limit scheduling honors the later retryAfter/resetAt constraint | T08 |
| AC-09 | PASS | Authentication and authorization remain BLOCKED failures, never successful empty results | T09 |
| AC-10 | PASS | A successful retry clears failure state and resumes normal cadence | T10 |
| AC-11 | PASS | `/api/runtime` exposes the minimum read-only status model | T11, T15 |
| AC-12 | PASS | Stop cancels timers, prevents new work, and awaits in-flight sync | T12, T13 |
| AC-13 | PASS | Timer entry points consume promises; shutdown settles rejected in-flight work | T13 |
| AC-14 | PASS | Invalid, sub-minimum, fractional, and non-finite intervals are rejected | T14 |
| AC-15 | PASS | Token comes only from environment injection; API/unit/source contain no literal | T15 |
| AC-16 | PASS | Durable open errors propagate and prevent composition | T16 |
| AC-17 | PASS | Existing snapshot is restored, refreshed, and retains execution state | T17 |
| AC-18 | PASS | Existing health/dashboard tests remain green | T18 and existing product/device tests |
| AC-19 | PASS | LCC-001 and LCC-002 suites pass unchanged | T19 existing regression suites |
| AC-20 | PASS | Full test, typecheck, and production build pass | T20 verification commands |

## Runtime policy

- Normal cadence: 60000 ms by default; `WORK_ITEM_POLL_INTERVAL_MS`, minimum 10000 ms.
- Transient backoff: 30000, 60000, 120000 ms, doubling to a 900000 ms cap.
- Rate limit: later of positive `retryAfter` and `resetAt`, with a 10000 ms floor.
- Authentication/authorization: BLOCKED with retry no sooner than 900000 ms or the configured normal interval.
- Success: clears consecutive failures and schedules the normal cadence.
- Shutdown: marks shutting down, cancels timers, awaits all in-flight operations, then lets the composition root close HTTP.
