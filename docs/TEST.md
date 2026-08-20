# Tests

Install each dependency set once before running the checks:

```powershell
cd orchestrator
bun install --frozen-lockfile

cd ../dashboard
bun install --frozen-lockfile

cd ..
```

## Orchestrator

Run the fast checks from `orchestrator/`. These do not start Docker:

```powershell
bun run typecheck
bun run test:unit
```

The integration suite starts a disposable PostgreSQL container with Testcontainers. It covers
matchmaking, concurrent placement, two fake HTTP agents, host recovery, maintenance, hub renewal,
monitoring and a 50-player simulation:

```powershell
bun run test:integration
```

Docker Desktop or another Testcontainers-compatible runtime must be available. On Windows, use
WSL when Testcontainers cannot reach the native Docker socket. `bun test` runs both unit and
integration tests, so it also needs Docker.

## Java plugins

From `plugins/`, run the Java tests and produce the three documented artifacts without invoking
the project-specific copy tasks attached to `build`:

```powershell
.\gradlew.bat :core:build :paper:check :velocity:check :paper:shadowJar :velocity:shadowJar
```

On Linux or macOS, use `./gradlew` with the same tasks. The output JARs are under each module's
`build/libs/` directory. Paper and Velocity produce shaded JARs. Core produces the compile-time
API and client JAR.

## Dashboard

Run the dashboard checks from `dashboard/`:

```powershell
bun run typecheck
bun run lint
bun test
bun run build
```

Install Chromium once before the browser suite, then run it:

```powershell
npx playwright install chromium
bun run test:e2e
```

Playwright builds the dashboard itself and starts it on port `3100` with
`DASHBOARD_MOCK_DATA=true`. It does not need the orchestrator or Docker.

## Deployment smoke test

After the automated checks pass, validate a real local two-agent control path with the Compose
scenario in [`MULTI_HOST.md`](MULTI_HOST.md). Run it from the repository root. This test creates
containers and published game ports. Stop the stack when the check is complete:

```powershell
docker compose -f compose.yml -f compose.multi-host.test.yml down
```
