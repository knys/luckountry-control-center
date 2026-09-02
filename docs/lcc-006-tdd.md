# LCC-006 TDD, security, operations, and acceptance evidence

Issue #12 is the SSOT. The Windows execution worker is separate from `agents/windows-agent.ps1`; telemetry remains read-only on port 9100. The execution worker defaults to `127.0.0.1:9200` and exposes only health, descriptor, structured execution submission/status, and execution-scoped cancellation. There is no arbitrary-command endpoint.

## RED

On 2026-09-03, `npm test` compiled all source and tests, loaded the new module, and ran the existing LCC-001–005 eleven-suite regression successfully. The new suite alone failed at runtime with `LCC-006 execution scanner not implemented`. This is the valid behavioral RED; no compile/import/runner failure is counted.

During GTX1060 acceptance, Windows exposed a second valid RED: the original npm lifecycle used POSIX-only `rm`, `mkdir -p`, `cp`, and a shell-expanded test glob. A regression contract now rejects POSIX commands, shell chaining, and test globs in the required npm scripts. `tools/tasks.mjs` performs cleanup, asset copying, TypeScript invocation, recursive test discovery, and Node test invocation using Node.js 20 APIs and `spawn(..., shell:false)`.

## Security and runtime policy

Requests use HMAC-SHA256 over method, path, timestamp, nonce, and SHA-256 body digest. The worker enforces clock skew, one-time nonces, constant-time comparison, and a 64 KiB request limit. The shared secret exists only in protected environment configuration. Production execution is fail-closed and defaults to `WORK_EXECUTION_ENABLED=false` in systemd.

Worker workspaces come only from a versioned local allowlist. Preflight checks canonical directory, git root, origin, clean status, branch, HEAD, git, and Codex. It never resets or cleans a workspace. Codex uses `spawn(executable, argv)` with `shell:false`, a bounded environment allowlist, fixed stdin prompt, JSON events, workspace-write sandbox, and only a probed `--approve-for-me` policy. The dangerous bypass flag is rejected and never used as fallback.

Worker execution state is atomically persisted. `executionId` plus request digest provides idempotency, each workspace has one QUEUED/RUNNING execution, and stale processes become LOST after restart. LCC restores its v3 lease and queries the worker: running remains leased, terminal status completes through the State Machine, NOT_FOUND becomes WORKER_LOST/recovery-required without redispatch, and an offline worker leaves the lease intact.

## Windows worker setup

Run these commands in an elevated PowerShell after copying the built release to the GTX1060 machine. Use the same dedicated Windows account that will run the service.

```powershell
cd C:\Luckountry\luckountry-control-center
npm ci
npm run build
$env:WORKER_ID = "gtx1060"
$env:WORKER_HMAC_KEY_ID = "lcc-tx66kwh"
$env:WORKER_HMAC_SECRET = (Read-Host "HMAC secret")
$env:WORKER_WORKSPACES_CONFIG = "C:\ProgramData\Luckountry\workspaces.json"
$env:WORKER_STATE_PATH = "C:\ProgramData\Luckountry\worker-executions.json"
$env:WORKER_BIND_ADDRESS = "127.0.0.1"
$env:WORKER_PORT = "9200"
node .\dist\worker\server.js
```

After loopback validation, stop the process and set `WORKER_BIND_ADDRESS` to the GTX1060 LAN IPv4. Restrict ingress to the TX66KWH IPv4:

```powershell
.\ops\install-windows-worker.ps1 -InstallDirectory "C:\Luckountry\luckountry-control-center" -WorkspaceConfig "C:\ProgramData\Luckountry\workspaces.json" -StatePath "C:\ProgramData\Luckountry\worker-executions.json" -BindAddress "192.168.1.50" -Port 9200 -AllowedRemoteAddress "192.168.1.10"
```

Do not put the HMAC secret in the firewall script, repository, or service command line.

## Real canary gate

T34/T35 must run under the exact worker service account and non-TTY environment. They intentionally use a temporary git repository, never a product repository:

```powershell
cd C:\Luckountry\luckountry-control-center
codex --version
codex exec --help
npm run build
$env:GTX1060_CODEX_CANARY = "true"
npm run canary:worker
```

Expected final JSON contains `headlessSmoke:"PASS"`, `fixtureCanary:"PASS"`, and only `marker.txt` in `changedFiles`. Until this evidence is captured, `WORK_EXECUTION_ENABLED` must remain `false`.

## Acceptance status before real canary

AC-01–AC-33 and AC-36–AC-37 are covered by T01–T33 and the complete regression/verification commands. AC-34 and AC-35 are `WAITING_HUMAN`: this environment is not the GTX1060 Windows worker service account, so they must not be inferred from fake-process tests. Main merge is prohibited until both canaries pass.
