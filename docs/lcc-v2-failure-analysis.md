# LCC v2 failure analysis and replacement architecture

Issue #72 is the audit SSOT. This document records repository and production evidence without secret values.

## Root causes

1. Autonomous execution was deliberately fail-closed during LCC-005 through LCC-008. The shipped and installed unit still sets `WORK_EXECUTION_ENABLED=false`, `WORK_VERIFICATION_ENABLED=false`, and `WORK_AUTOMATION_MODE=disabled`. Later automation was added beside that path instead of replacing it.
2. `ProductService` projects every `DEFINED` WorkItem as queued for LCC. Q/A metrics come from `watcher.json`, which counts only commissioned Dispatcher runs. Consequently a product can show QUEUED/BALL=LCC while the real watcher reports Q0/A0.
3. BALL=LCC is inferred from a desired next actor, not a valid lease. It does not require a live process, PID, or heartbeat.
4. The Watcher does start Codex for a commissioned, labelled Issue, as journal evidence for #69 confirms. It does not start Codex for ordinary projected WorkItems because selection requires an open allowlisted Issue with the exact `lcc:commission` label, a new source revision, a Commission Inbox record, a registered Run, dispatch enabled, satisfied dependencies, and QUEUED status. Its service can additionally be blocked by a pause file, permissions, a dirty dedicated workspace, or stale/blocked durable state.
5. Responsibility is duplicated: the bootstrap starts an out-of-repository runner; the watcher discovers, queues, dispatches and reports liveness; the watchdog separately classifies and restarts; the dashboard service separately syncs and projects WorkItems. Each owns a different state file and none can atomically prove the whole lifecycle.
6. Issue selection ignores unlabelled executable Issues, while dashboard selection includes synced Issues. Completed revisions remain in the Inbox and GitHub closure is observed on a different polling path, leaving stale rows until separate reconciliation.
7. The Codex execution is one opaque blocking step. PID and child heartbeat are absent from the durable run; watcher heartbeat proves only the parent loop. Process loss is inferred from stale timestamps, while result recovery depends on a later store reopen.
8. Restart converts every RUNNING checkpoint to QUEUED without checking whether its actor survived. In-memory single-flight protection does not span processes; separate service loops can race and there is no database-enforced Issue uniqueness lease.
9. WAITING_HUMAN accepts one free-form string. It does not structurally require a question, reason, and machine-verifiable release condition, so automation failures can be misclassified as Human work.
10. GitHub completion, merge state, WorkItem sync, Commission completion, and product projection are independent eventual-consistency paths. There is no atomic `main SHA + PR + CI PASS -> COMPLETED` transition.

## v2 architecture

`luckountry-control-center-v2.service` contains one Supervisor, one versioned durable database, one execution slot, and the dashboard API. Every Issue has one stable GitHub node ID and one unique Job ID. Live states require an expiring Lease; ACTIVE additionally requires a real PID and fresh child heartbeat. On process loss or restart, the Supervisor clears the lease and performs at most three durable retries.

The state path is `DISCOVERED -> ELIGIBLE -> QUEUED -> LEASED -> ACTIVE -> VERIFYING -> MERGING -> COMPLETED`, with bounded failure states. COMPLETED is impossible without a PR number, CI PASS, and main merge SHA. The dashboard is derived only from this snapshot and an OS PID probe; it never invents queue or ball ownership from desired product metadata.

Production discovery uses the neutral `lcc:autonomous` eligibility label, not a per-Issue Commission command. The executor clones into a dedicated per-Job workspace, invokes Codex non-interactively, independently runs test/typecheck/build/diff checks, creates the PR, waits for CI, merges, verifies the merge commit, and closes the Issue. An empty slot immediately selects the oldest durable queued Issue.

Deployment is parallel and reversible. The installer preserves the old units, keeps v1 serving while a v2 canary runs on port 3001, switches port 3000 only after the canary passes, and disables old execution units only after v2 health succeeds. Rollback restores v1 without deleting v2 releases or state.
