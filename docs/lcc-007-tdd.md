# LCC-007 Acceptance / Verification TDD Matrix

Issue #14 is the SSOT and Coding Ready is YES. `WORK_VERIFICATION_ENABLED=false` remains the merge gate until AC-31 and AC-32 have real non-TTY evidence.

| Tests | Acceptance contract |
|---|---|
| V01-V06 | AC-01..06 body ingestion, section boundaries, checked-state neutrality, deterministic AUTO/HUMAN parsing, malformed/duplicate/empty fail-closed, resync preservation |
| V07-V10 | AC-07..10 plan dedupe/unknown rejection, fixed worker profile, non-injectable process boundary, shell false/timeout/bounds/redaction |
| V11-V14 | AC-11..14 HMAC/replay/body limit, idempotency/conflict, worker restart LOST, schema v1-v3 migration |
| V15-V17 | AC-15..17 eligibility, execution association, exclusive lease, default-off scanner/no busy loop |
| V18-V23 | AC-18..23 durable evidence before state decision, AUTO failure, HUMAN remainder, no prose/checkbox inference, evidence mapping, safe read-only API |
| V24-V27 | AC-24..27 LCC reconciliation, NOT_FOUND/OFFLINE safety, workspace exclusion, scoped cancellation |
| existing suite + gates | AC-28..30 typecheck/build and LCC-001..006 regression |
| GTX1060 canaries | AC-31..32 HUMAN: fixed non-TTY checks and isolated RUNNING→VERIFYING→DONE |

State integrity rules: missing/invalid Acceptance never reaches DONE; infrastructure errors retain VERIFYING; verification commands are worker-local fixed specifications and are never derived from Issue/remote executable, argv, cwd, environment, or shell text.
