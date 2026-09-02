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

`config/products.json` is the allowlisted product manifest. Humans or ChatGPT maintain the semantic fields (`summary`, `status`, `ball`, and `nextAction`). The server supplements those fields with the default branch, HEAD SHA, open Issue/PR counts, repository URL, and repository update time through one read-only `gh api graphql` process per cache refresh. GitHub credentials never enter an API response or browser code. If GitHub is unavailable, the server returns its latest in-memory metadata with `stale: true`; product and device endpoints remain independent.

Valid statuses are `RUNNING`, `READY`, `WAITING`, `BLOCKED`, `ACCEPTANCE`, `DONE`, and `UNKNOWN`. Valid ball owners are `CHATGPT`, `CODEX`, `HUMAN`, `EXTERNAL`, `NONE`, and `UNKNOWN`. Multiple products may reference the same repository. Restart the service after changing the manifest.

## WorkItem issue sync foundation

LCC keeps GitHub Issue transport data separate from its execution state. `GitHubIssueAdapter` reads and validates open Issues, `IssueSyncService` maps a complete response to provider-neutral `WorkItem` records, and `WorkItemRepository` commits the records and successful sync metadata atomically. Failed fetches or validation preserve the last good records while recording a classified failure and attempt time.

`DurableWorkItemRepository` stores a versioned, atomic JSON snapshot using only Node.js 20 standard APIs. Its default production path is `/var/lib/luckountry-control-center/work-items.json`; override it with `WORK_ITEM_DATABASE_PATH`. Corrupt or unsupported storage fails explicitly and is never replaced with an empty snapshot. `InMemoryWorkItemRepository` remains the test double.

The production composition starts `IssuePollingRuntime` immediately and then polls each unique repository from the product manifest every 60 seconds without overlapping a repository. Override the interval with `WORK_ITEM_POLL_INTERVAL_MS` (minimum 10000). Runtime status is read-only at `GET /api/runtime`. GitHub authentication is injected from `GITHUB_TOKEN`; production may provide it through the optional root-managed `/etc/luckountry-control-center/environment` file. The token is never returned by the API.

WorkItem execution uses a deterministic Domain state machine. Newly discovered Issues start at `DEFINED` with the Human ball and a non-executable `DEFINE` action; they never become `READY` without an explicit definition-completed event. Execution transitions are atomically persisted, source polling cannot overwrite newer execution state, and read-only state is available at `GET /api/work-items`.

The LCC-005 execution gate requires the complete READY/CODEX/EXECUTE policy, declared capabilities, an explicit repository-to-workspace binding, an available worker, and no conflicting durable lease. Schema v3 stores execution leases and bounded history; restored ACTIVE leases are observable and are never automatically redispatched. `GET /api/executions` is read-only. This release includes only fake worker/executor infrastructure and never starts Codex, a shell command, or a remote transport.

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
