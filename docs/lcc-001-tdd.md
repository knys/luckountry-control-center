# LCC-001 TDD evidence

## RED

- Date: 2026-09-03 (Asia/Tokyo)
- Command: `npm test`, followed by `node .test-dist/test/issue-sync.test.js` for case-level output
- Compile/import/test runner: PASS
- Existing suites: PASS (devices, parsers, products)
- New LCC-001 tests: 14 FAIL, 1 integration SKIP
- Failure reason: application and adapter methods raised `LCC-001 not implemented`

This is the required feature-missing RED state, not a syntax, import, configuration, or runner failure.

## GREEN

- `npm test`: PASS
- Explicit T14 command: `LCC_GITHUB_INTEGRATION=1 node .test-dist/test/issue-sync.test.js`
- T14 result: PASS against the public `knys/luckountry-control-center` repository. The assertion validates the live open-Issue contract without depending on one Issue remaining open.

## Acceptance verification

| AC | Result | Evidence | Test |
| --- | --- | --- | --- |
| AC-01 | PASS | Adapter requests the specified repository's open Issues | T01, T14 |
| AC-02 | PASS | Mock response maps number, title, state, labels, assignees, updatedAt, and URL | T01 |
| AC-03 | PASS | Application mapping creates a provider-neutral WorkItem | T02 |
| AC-04 | PASS | Deterministic source identity is upserted without duplication | T04 |
| AC-05 | PASS | Source changes update the existing WorkItem | T05 |
| AC-06 | PASS | Network failure leaves the last successful records unchanged | T06 |
| AC-07 | PASS | 401 and 403 reject with classified failures | T07, T08 |
| AC-08 | PASS | Rate limit includes classification, resetAt, and retryAfter | T09 |
| AC-09 | PASS | Success and failure metadata preserve the correct timestamps and reason | T10, T11 |
| AC-10 | PASS | Invalid entries and persistence failure cannot publish a partial set | T13, repository atomicity test |
| AC-11 | PASS | Full automated suite, typecheck, and build pass | T15 verification commands |

Final verification on 2026-09-03:

- `npm test`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- T14 live integration: PASS (15 tests, 0 failures, 0 skipped in the explicit integration run)
