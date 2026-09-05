# Issue #96 — Manifest Hot Reload Acceptance/TDD

| Acceptance | Behavioral evidence |
| --- | --- |
| Startup and current repository registry | `startup, add, remove, change and idempotent reload` |
| Add/remove/change without restart | Same test plus dynamic discovery test |
| Last Known Good on JSON/validation failure | `invalid JSON and validation failure retain last known good` |
| Atomic replacement and debounce | `atomic replacement is detected and duplicate events are debounced` |
| Dynamic Issue polling and isolated GitHub failure | `dynamic registry adds and removes repositories...` |
| ACTIVE/QUEUED durability | ManifestManager has no V2Store mutation capability; full v2 restart/regression suites verify store invariants |
| API/log observability | `/health` and `/api/v2` expose bounded manifest status/products; event fixtures assert STARTED/SUCCEEDED/FAILED |
| Production | One final ACTIVE=0 deployment followed by a PID-stable, restart-count-stable canonical-manifest canary |

No reload path deletes durable state, terminates an actor, accepts a caller command,
or changes automation policy.
