# Tests

Run the fast orchestrator checks from `orchestrator/`:

```powershell
bun run typecheck
bun test test/unit
```

The PostgreSQL integration suite starts a disposable database with Testcontainers and includes
atomic placement, two fake HTTP agents, host expiry/recovery and maintenance coverage:

```powershell
bun test test/integration
```

Docker Desktop or another Testcontainers-compatible runtime must be available. On Windows, use
WSL when the native Docker socket is unavailable.

Run the dashboard checks from `dashboard/`:

```powershell
bun run typecheck
bun run lint
bun test
bun run build
bun run test:e2e
```

Finally, validate a real local two-agent control path with the compose smoke scenario documented
in [`MULTI_HOST.md`](MULTI_HOST.md).
