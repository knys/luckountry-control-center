# Luckountry Control Center

Lightweight, read-only operations dashboard for Luckountry's products and the GTX1060 PC, TOBIE BOX, and TX66KWH. It listens on `0.0.0.0:3000`, refreshes the UI every five seconds, and caches GitHub metadata for 60 seconds.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

Open `http://localhost:3000`. API endpoints are `GET /health`, `GET /api/devices`, `GET /api/products`, and the backward-compatible `GET /api/system-status`.

## Product Control SSOT

`config/products.json` is the bounded Product policy manifest. Durable WorkItems and execution records are the runtime SSOT for the current Issue, state, actor, and run. The manifest selects a Product's primary Issue where a repository contains several products and preserves only genuine physical/subjective Human gates (`humanActionJa` and `humanGate`). `ProductService` deterministically materializes `issueNumber`, `issueUrl`, `relatedIssues`, `nextActionJa`, `humanActionJa`, `queuedActor`, `activeActor`, and `currentRun`; it never invokes an LLM during rendering. A `DEFINED` Issue is shown as queued for LCC rather than incorrectly assigning routine definition work to Human. `RUNNING` is emitted only for a matching durable ACTIVE execution.

The server supplements this state with default branch, HEAD SHA, open Issue/PR counts, repository URL, and repository update time through one read-only `gh api graphql` process per cache refresh. GitHub credentials never enter an API response or browser code. If GitHub is unavailable, the server returns its latest in-memory metadata with `stale: true`; product and device endpoints remain independent.

Valid statuses are `RUNNING`, `READY`, `WAITING`, `BLOCKED`, `ACCEPTANCE`, `DONE`, and `UNKNOWN`. Valid ball owners are `CHATGPT`, `CODEX`, `HUMAN`, `EXTERNAL`, `NONE`, and `UNKNOWN`. Multiple products may reference the same repository. Restart the service after changing the manifest.

## WorkItem issue sync foundation

LCC keeps GitHub Issue transport data separate from its execution state. `GitHubIssueAdapter` reads and validates open Issues, `IssueSyncService` maps a complete response to provider-neutral `WorkItem` records, and `WorkItemRepository` commits the records and successful sync metadata atomically. Failed fetches or validation preserve the last good records while recording a classified failure and attempt time.

`DurableWorkItemRepository` stores a versioned, atomic JSON snapshot using only Node.js 20 standard APIs. Its default production path is `/var/lib/luckountry-control-center/work-items.json`; override it with `WORK_ITEM_DATABASE_PATH`. Corrupt or unsupported storage fails explicitly and is never replaced with an empty snapshot. `InMemoryWorkItemRepository` remains the test double.

The production composition starts `IssuePollingRuntime` immediately and then polls each unique repository from the product manifest every 60 seconds without overlapping a repository. Override the interval with `WORK_ITEM_POLL_INTERVAL_MS` (minimum 10000). Runtime status is read-only at `GET /api/runtime`. GitHub authentication is injected from `GITHUB_TOKEN`; production may provide it through the optional root-managed `/etc/luckountry-control-center/environment` file. The token is never returned by the API.

WorkItem execution uses a deterministic Domain state machine. Newly discovered Issues start at `DEFINED` with the Human ball and a non-executable `DEFINE` action; they never become `READY` without an explicit definition-completed event. Execution transitions are atomically persisted, source polling cannot overwrite newer execution state, and read-only state is available at `GET /api/work-items`.

The LCC-005 execution gate requires the complete READY/CODEX/EXECUTE policy, declared capabilities, an explicit repository-to-workspace binding, an available worker, and no conflicting durable lease. Schema v3 stores execution leases and bounded history; restored ACTIVE leases are observable and are never automatically redispatched. `GET /api/executions` is read-only. This release includes only fake worker/executor infrastructure and never starts Codex, a shell command, or a remote transport.

LCC-006 adds an HMAC-authenticated Windows execution worker on loopback port 9200, explicit worker-local workspace allowlists, durable execution idempotency, remote adapters, and restart reconciliation. Automatic production execution remains fail-closed: `WORK_EXECUTION_ENABLED=false` is the default, and missing target, HMAC, worker, workspace, or safe Codex readiness prevents dispatch. See `docs/lcc-006-tdd.md` before configuring the worker or running its isolated fixture canary.

LCC-007 ingests normalized Acceptance Criteria from GitHub Issue bodies and turns allowlisted AUTO check IDs into fixed worker-local verification commands, durable criterion evidence, and deterministic state transitions. Production verification is independently fail-closed with `WORK_VERIFICATION_ENABLED=false`. Configure `WORK_VERIFICATION_TARGETS_JSON` on LCC and `WORKER_VERIFICATION_PROFILES_CONFIG` plus `WORKER_VERIFICATION_STATE_PATH` on the worker; executable paths in profiles are canonicalized and validated at startup. Run `npm run canary:verification` under the Windows worker account for the isolated AC-31/32 bridge described in `docs/lcc-007-tdd.md`.

LCC-008 adds a controlled one-Issue pilot. Dispatch requires `WORK_AUTOMATION_MODE=pilot`, both existing enable flags, one exact unexpired `WORK_PILOT_SCOPE_JSON`, a ready worker/profile, deterministic Issue definition markers, and both pilot labels. Candidate work is committed only on a worker-allowlisted `lcc/pilot/*` branch with push disabled; matching independent evidence ends in `WAITING_HUMAN`, never automatic promotion. Defaults remain disabled. See `config/pilot-scope.example.json`, `docs/lcc-008-tdd.md`, and run `npm run canary:pilot` before real acceptance.

LCC-010 extracts the persistent dispatcher from the production Self-Commissioning control surface. One authenticated start now keeps consuming the validated durable graph across whole CODEX_JOB boundaries, survives restart through the existing checkpoint store, and stops only at a terminal state, exact blocker, kill switch, or Human Gate. It adds no arbitrary job or shell API. See `docs/lcc-010-tdd.md` and run `npm run canary:dispatcher`.

A failed Pilot is never retried automatically. For a retryable pre-Codex infrastructure/setup failure only, a Human may set `WORK_PILOT_RECOVERY_ID` to the exact existing `cycleId`. LCC durably consumes that one-shot request, performs `FAILED -> RETRYING -> RUNNING`, and grants one additional dispatch without resetting history or counters. Remove the setting after consumption; it cannot be reused after restart.

After that Recovery has been consumed, a later Codex/postcondition failure requires a separate Human remediation approval: `WORK_PILOT_REMEDIATION_ID=<cycleId>:<latest-failed-executionId>`. It is exact, durable, one-shot, and adds at most one further dispatch without resetting either prior attempt. Pilot success requires a clean committed candidate descendant with the base unchanged; Codex final messages and failed git postconditions remain as bounded/redacted evidence. The Worker owns execution for 30 minutes and the Controller observes for 31 minutes before an execution-scoped cancel/final-status sequence.

## Remote device agents

The Control Center polls small read-only JSON agents over the LAN; it never runs SSH or remote commands. Configure endpoints without embedding host details in source:

```sh
DEVICE_GTX1060_URL=http://192.168.x.x:9100
DEVICE_TOBIE_URL=http://192.168.x.x:9100
```

`agents/tobie-agent.py` uses only the Python standard library. `agents/windows-agent.ps1` uses built-in PowerShell/CIM APIs. Both expose only `GET /health` and `GET /telemetry`; their optional `services` object is reserved for future DRAW/WALL/BATTLE/RACE status. They default to loopback. Bind each agent to its specific LAN address and restrict port 9100 to the local subnet with the host firewall. There is currently no authentication; the endpoint URL/provider boundary allows token authentication to be added later.

Fresh telemetry is `ONLINE`. CPU >= 85%, temperature >= 80°C, RAM >= 85%, disk >= 90%, or data older than 20 seconds is `WARNING`. Data older than 60 seconds, an unconfigured endpoint, or an endpoint with no prior successful response is `OFFLINE`.

## Production installation

Build first, then inspect and run the installer as root:

```sh
npm ci
npm run build
sudo ./ops/install.sh
```

The installer creates the unprivileged `luckountry` system account, installs the built application under `/opt`, enables `luckountry-control-center.service`, and grants only the fixed SMART wrapper permission to run as root. The API cannot choose a command or disk device.

```sh
systemctl status luckountry-control-center
journalctl -u luckountry-control-center -f
```
