# LCC-009 Acceptance / TDD Matrix

SSOT: GitHub Issue #18. This matrix is fixed before implementation. Tests use
observable behavior and preserve all prior LCC-008 durable state and history.

## Contract boundaries

- No claim of ongoing work without an actual actor.
- Routine diagnostics, fixed build/restart/migration/reconcile, and evidence
  collection are autonomous operations, not Human Gates.
- Human Gates are limited to security-boundary changes, budget expansion,
  destructive operations, credential provisioning that cannot be automated,
  and promotion/merge decisions.
- Maintenance accepts typed allowlisted operations only. Callers cannot supply
  commands, shells, working directories, environments, or unrestricted paths.
- All retries, output, evidence, timeouts, and histories are bounded and durable.
- Failure is closed. Existing execution, verification, pilot, and candidate
  branch history is never reset, deleted, or rewritten to make a retry pass.
- Product deployment/release, automatic main merge, and Issue close are out of
  scope.

## Acceptance matrix

Attempt3 timeout recovery is fail-closed: the original `TIMED_OUT` record remains
immutable, a fixed Worker verification must pass all allowlisted checks at the
candidate HEAD, and only then may an atomic `INDEPENDENTLY_VERIFIED` recovery
record advance the WorkItem to normal verification. The source execution,
candidate branch, base HEAD, and full prior Pilot history remain durable.

| AC | First behavioral test | Required observable outcome | Evidence |
|---|---|---|---|
| AC-01 | `L009-01 durable run resumes from checkpoint after reopen` | Run/session, completed steps, active step, retry budget, and history survive restart; completed idempotent steps are not repeated. | Store reopen test and synthetic restart canary. |
| AC-02 | `L009-02 nonterminal run always owns an explicit disposition` | Every nonterminal run has exactly one meaningful disposition: active actor/execution, queued actor/step, blocker, or Human Gate. | Domain invariant/property cases. |
| AC-03 | `L009-03 idle and blocked cannot serialize as ongoing` | Ongoing wording/status is rejected unless a live actor or durably assigned executor exists; IDLE/BLOCKED expose an exact reason. | API and AI-summary contract tests. |
| AC-04 | `L009-04 TX maintenance rejects arbitrary process input` | Only typed `TX_*` operations execute fixed executable/argv/cwd policy; command/cwd/env input and unknown operations fail closed. | Policy and adapter tests. |
| AC-05 | `L009-05 GTX maintenance rejects shell and command input` | Only typed `GTX_*` operations are accepted; PowerShell/cmd/bash or caller argv are impossible/rejected. | Worker HTTP/auth/policy tests. |
| AC-06 | `L009-06 exact-ref update build restart is idempotent and bounded` | Idempotency replay returns durable result; timeouts/output/retries have hard limits. | Fake runner clock/output tests. |
| AC-07 | `L009-07 worker update preserves protected state and workspace` | Update/restart does not delete or rewrite execution history, verification history, runtime state, or product workspace. | Sentinel filesystem/store test. |
| AC-08 | `L009-08 migration and reconcile require no JSON mutation` | Typed migration/reconcile atomically upgrade/reconcile durable state through repository APIs. | Legacy fixture migration and interrupted-run reconcile tests. |
| AC-09 | `L009-09 controller collects authenticated worker evidence` | Controller obtains bounded/redacted controller + worker + git/status evidence directly over authenticated transport. | Two-end transport test. |
| AC-10 | `L009-10 recoverable failure repairs and resumes checkpoint` | Policy-permitted failure collects/classifies evidence, invokes bounded Codex repair, rebuilds/restarts, and resumes without repeating completed steps. | End-to-end fake repair test. |
| AC-11 | `L009-11 non-policy failure stops at exact gate or blocker` | Terminal/nondelegated failure becomes WAITING_HUMAN or BLOCKED with exact reason and no further dispatch. | Orchestrator classification test. |
| AC-12 | `L009-12 retry budget is durable and cannot loop` | Attempts are persisted before dispatch; exhaustion blocks; restart cannot replenish budget. | Restart/budget exhaustion test. |
| AC-13 | `L009-13 API and evidence redact secrets paths and environment` | Tokens, credentials, full environment, unsafe absolute paths, and unbounded logs never leave adapters/API/reporting. | Adversarial payload test. |
| AC-14 | `L009-14 kill switch prevents new dispatch and keeps history` | Disable immediately rejects new work while existing durable records remain unchanged. | Mid-run/next-step dispatch test. |
| AC-15 | `L009-15 self update deploys disabled before readiness enable` | Exact-ref self-update orders build/test -> deploy disabled -> health/readiness; enable is scoped and impossible before readiness. | Ordered operation trace test. |
| AC-16 | `L009-16 GitHub receives bounded idempotent run evidence` | Issue/PR comments are posted automatically, bounded/redacted, and duplicate-safe without Human relay. | Fake GitHub API/report ledger test. |
| AC-17 | `L009-17 promotion merge remains Human Gate` | Promotion/merge/security/budget expansion cannot be autonomously dispatched; routine maintenance does not request Human input. | Policy table test. |
| AC-18 | Existing LCC-001..008 suites | All prior suites and pilot canary remain green with history semantics unchanged. | Full test suite. |
| AC-19 | TypeScript typecheck | `npm run typecheck` passes. | Command transcript. |
| AC-20 | Production build | `npm run build` passes from clean output. | Command transcript. |
| AC-21 | Real run: LCC-008 AC-32..35 | One self-commissioning run completes remaining real acceptance from actual durable state. | Durable run + controller/worker/GitHub evidence. |
| AC-22 | Real run Human action ledger | At most initial approval/start and genuine final promotion decision; no command/log copy transport. | Run history actor/gate ledger. |
| AC-23 | Real run actor timeline | Every observed state accurately names active/queued actor, execution, next gate, or no-actor reason. | Timestamped actor/run evidence. |
| AC-24 | `production-self-commissioning` behavioral suite | The authenticated fixed control surface creates only `LCC008_REAL_ACCEPTANCE`, observes a real actor after start, rejects duplicate start, persists cancel/restart truth, and cannot accept arbitrary execution input. | Production wiring suite and deterministic production-path canary. |

## Implementation and RED order

1. Freeze manual LCC-008 attempt3. Add `L009-02` and `L009-03` as the
   first valid behavioral RED for the Actor/Run truth model.
2. Implement the durable Actor/Run model and its safe read-only representation.
3. RED/green `L009-04`, then TX66KWH fixed maintenance profiles.
4. RED/green `L009-05` through `L009-07`, then GTX1060 fixed Worker profiles.
5. RED/green `L009-01`, `L009-08`, `L009-11`, `L009-12`, `L009-14`,
   `L009-15`, and `L009-17`, then the durable orchestrator/checkpoint graph.
6. RED/green `L009-09` and `L009-13`, then machine-to-machine evidence.
7. RED/green `L009-16`, then idempotent GitHub evidence reporting.
8. RED/green `L009-10`, then the bounded Codex repair loop.
9. Run a synthetic self-commissioning canary including restart, recoverable
   repair, kill switch, terminal Human Gate, and actor-truth assertions.
10. Run the required clean/full verification commands, then use LCC-009 for the
    real LCC-008 AC-32..35 acceptance without manual attempt3 bridging.

## Merge and completion policy

- LCC-009 remains unmerged until real Human Acceptance passes.
- LCC-008 manual bridge-heavy completion is not a substitute for LCC-009.
- Neither Issue #18 nor Issue #16 is automatically closed.
- No product repository is deployed or released.
