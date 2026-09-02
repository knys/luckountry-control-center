# LCC-002 durable repository evidence

## Storage decision

The production runtime contract remains Node.js 20 or newer, and the target-compatible development runtime is v20.19.2. Node's built-in `node:sqlite` was added in v22.5.0 and is absent from the Node 20 API. Adding a native addon or an undeclared SQLite CLI dependency would make TX66KWH deployment less predictable.

LCC-002 therefore uses a versioned JSON snapshot implemented only with Node 20 standard filesystem APIs. Each mutation writes and fsyncs a mode-0600 temporary file in the same directory, atomically renames it over the prior snapshot, and fsyncs the directory. In-memory state is published only after the rename succeeds. The format has an explicit `schemaVersion`; unsupported versions and corrupt data fail without replacement.

Schema version 1 is the baseline. Startup validates the version before decoding repository data. A future migration must be introduced as an explicit version-to-version transform before incrementing `CURRENT_SCHEMA_VERSION`; unknown newer or older versions currently stop startup and preserve the original file.

References:

- https://nodejs.org/api/sqlite.html (`node:sqlite` added in v22.5.0)
- https://nodejs.org/download/release/v20.19.2/docs/api/ (Node 20 API surface)

## RED

- Date: 2026-09-03 (Asia/Tokyo)
- Commands: `npm test`, then `node .test-dist/test/durable-work-item-repository.test.js`
- Compile/import/test runner: PASS
- Existing suites including LCC-001: PASS
- LCC-002 suite: 13 FAIL, 2 PASS
- Failure reason: durable operations raised `LCC-002 durable repository not implemented`, and production data-directory assertions found the expected contract absent.
- T10 and T12 passed because the explicit error and path configuration skeletons existed before persistence implementation.

The RED state was caused by missing requested behavior, not syntax, imports, configuration, or the test runner.

## GREEN and acceptance verification

| AC | Result | Evidence | Test |
| --- | --- | --- | --- |
| AC-01 | PASS | Every WorkItem field is written to the durable snapshot | T01 |
| AC-02 | PASS | A new repository instance restores saved WorkItems | T02 |
| AC-03 | PASS | A new repository instance restores all SyncMetadata | T03 |
| AC-04 | PASS | Source refresh updates source fields while retaining execution fields | T04 |
| AC-05 | PASS | Re-sync after repository recreation retains one source reference | T05 |
| AC-06 | PASS | Failed snapshot write publishes neither WorkItems nor metadata | T06 |
| AC-07 | PASS | Failure recording retains WorkItems and repository-controlled last success time | T07 |
| AC-08 | PASS | First open creates schema version 1 safely | T08 |
| AC-09 | PASS | Repeated initialization preserves data; unsupported versions stop explicitly | T09, unsupported-version test |
| AC-10 | PASS | Invalid/unwritable paths raise `DurableRepositoryError` with the path | T10 |
| AC-11 | PASS | Invalid JSON is reported and its original bytes remain unchanged | T11 |
| AC-12 | PASS | Environment override and production default are tested | T12 |
| AC-13 | PASS | Installer creates mode-0750 service-owned data directory and systemd grants only that write path | T13 |
| AC-14 | PASS | Existing LCC-001 suite passes unchanged with the in-memory test double retained | T14 (`test/issue-sync.test.ts`) |
| AC-15 | PASS | Complete test, typecheck, and production build commands pass | T15 verification commands |

Final verification on 2026-09-03:

- `npm test`: PASS (all five test files, including LCC-001 and LCC-002)
- `npm run typecheck`: PASS
- `npm run build`: PASS
