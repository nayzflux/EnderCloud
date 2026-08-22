# Environment configuration

EnderCloud validates project-owned environment variables at process startup. Removed names cause
an error that names their replacement, which prevents an old deployment setting from being
silently ignored.

This page explains which process owns each setting. The complete validation rules and defaults
are in [Orchestrator](ORCHESTRATOR.md) and [Agent](AGENT.md).

## Environment files

| File | Use |
| --- | --- |
| `.env.example` | Minimal values required by the root Compose stack |
| `.env.advanced.example` | Central stack example with optional scheduler, retry, incident, and logging settings |
| `.env.agent.example` | Standalone remote-agent values for `compose.agent.yml` |
| `dashboard/.env.example` | Dashboard development values |
| `.env` | Local root Compose values. Create it from an example and do not commit secrets |
| `.env.agent` | Optional local remote-agent file passed with `--env-file` |
| `dashboard/.env.local` | Local Next.js dashboard development values |

Docker Compose automatically reads `.env` in the project directory. It does not merge
`.env.advanced.example` into an existing file. Copy the example you want, then edit the copy.

```powershell
Copy-Item .env.example .env
Copy-Item dashboard/.env.example dashboard/.env.local
```

For a standalone agent:

```powershell
Copy-Item .env.agent.example .env.agent
docker compose --env-file .env.agent -f compose.agent.yml up --build -d
```

## Variable ownership

Environment values pass through three different layers:

1. Compose reads substitution variables from the host and builds service environments, mounts,
   and port mappings.
2. The orchestrator, agent, and dashboard read only variables declared in their process
   environments.
3. The agent combines variant environment with generated EnderCloud variables for each Minecraft
   container.

A variable present in `.env` does not automatically reach a container. `compose.yml` must declare
it under that service's `environment` section.

## Orchestrator variables

The orchestrator process reads:

```text
DATABASE_URL
REDIS_URL
ORCHESTRATOR_LISTEN_PORT
ORCHESTRATOR_GROUPS_DIRECTORY
ORCHESTRATOR_TEMPLATES_DIRECTORY
ORCHESTRATOR_LOG_LEVEL
INSTANCE_START_CONCURRENCY
INSTANCE_START_RETRY_LIMIT
INSTANCE_START_RETRY_BASE_DELAY
SCHEDULER_CAPACITY_INTERVAL
SCHEDULER_MATCHMAKING_INTERVAL
SCHEDULER_RECONCILIATION_INTERVAL
SCHEDULER_INCIDENT_INTERVAL
HOST_OFFLINE_TIMEOUT
EXECUTOR_PROBE_TIMEOUT
EXECUTOR_OPERATION_TIMEOUT
INCIDENT_BLOCKED_AFTER
INCIDENT_FAILURE_THRESHOLD
INCIDENT_FAILURE_WINDOW
INCIDENT_HOST_RECOVERY_AFTER
INCIDENT_HISTORY_RETENTION
```

See [the orchestrator environment table](ORCHESTRATOR.md#environment-variables) for requirements,
defaults, minimum values, and behavior.

The root Compose file currently forwards the variables explicitly declared in its orchestrator
service. If you add optional incident tuning to `.env`, add the same keys to that service
environment so the container can read them.

## Agent variables

The agent process reads:

```text
ORCHESTRATOR_URL
AGENT_ID
AGENT_VERSION
AGENT_LISTEN_PORT
AGENT_ADVERTISED_CONTROL_URL
AGENT_ADVERTISED_GAME_ADDRESS
AGENT_ALLOCATABLE_CPU
AGENT_ALLOCATABLE_MEMORY_BYTES
AGENT_HEARTBEAT_INTERVAL
AGENT_DOCKER_SOCKET
AGENT_DOCKER_NETWORK
AGENT_RUNTIME_DIRECTORY
AGENT_RUNTIME_HOST_DIRECTORY
AGENT_TEMPLATE_CACHE_DIRECTORY
AGENT_GAME_PORT_START
AGENT_GAME_PORT_END
AGENT_LOG_LEVEL
```

See [the agent environment table](AGENT.md#environment-variables) for requirements, defaults, and
path semantics.

## Compose-only variables

The following project variables control Compose interpolation. They are not read by the
orchestrator or agent TypeScript configuration loaders.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `POSTGRES_DB` | `compose.yml` | Database created by PostgreSQL |
| `POSTGRES_USER` | `compose.yml` | Role created by PostgreSQL |
| `POSTGRES_PASSWORD` | `compose.yml` | PostgreSQL password. Keep `DATABASE_URL` in sync |
| `ORCHESTRATOR_PUBLISH_ADDRESS` | `compose.yml` | Host bind interface for the orchestrator API |
| `ORCHESTRATOR_PUBLISH_PORT` | `compose.yml` | Host port for the orchestrator API |
| `DASHBOARD_PUBLISH_ADDRESS` | `compose.yml` | Host bind interface for the dashboard |
| `DASHBOARD_PUBLISH_PORT` | `compose.yml` | Host port for the dashboard |
| `AGENT_RUNTIME_LOCAL_DIRECTORY` | Root and standalone agent Compose | Host path mounted into the agent runtime directory |
| `AGENT_PUBLISH_ADDRESS` | `compose.agent.yml` | Private bind interface for a standalone agent API |
| `AGENT_PUBLISH_PORT` | `compose.agent.yml` | Host port for a standalone agent API |

The local two-agent smoke test adds:

```text
SECONDARY_AGENT_GAME_ADDRESS
SECONDARY_AGENT_CPU
SECONDARY_AGENT_MEMORY_BYTES
SECONDARY_RUNTIME_HOST_ROOT
```

These values configure only `compose.multi-host.test.yml`.

## Dashboard variables

The dashboard server reads two project variables:

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `ORCHESTRATOR_URL` | No | `http://localhost:8080` | Server-side base URL for dashboard proxy routes |
| `DASHBOARD_MOCK_DATA` | No | Disabled | Serve a deterministic synthetic cluster instead of calling the orchestrator |

`DASHBOARD_MOCK_DATA` is enabled by `1`, `true`, `yes`, or `on`, ignoring case and surrounding
spaces. The variable is server-side. Browser code calls the dashboard's own `/api` routes.

For local dashboard development, set `ORCHESTRATOR_URL=http://localhost:8080`. The root Compose
stack overrides it with the internal service URL.

## Managed Minecraft variables

The agent injects these values into every managed container after resolving the variant
environment:

| Variable | Required | Purpose |
| --- | :---: | --- |
| `ENDERCLOUD_INSTANCE_ID` | Generated | Stable instance identity used by the Paper bridge |
| `ENDERCLOUD_ORCHESTRATOR_URL` | Generated | Private callback URL used by Paper and server plugins |

The Paper bridge also reads:

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `ENDERCLOUD_REPORTED_ENDPOINT` | No | Agent-allocated endpoint | Override the endpoint sent with `SERVER_READY` |

Velocity is normally deployed outside managed Paper containers. Its plugin reads:

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `ENDERCLOUD_ORCHESTRATOR_URL` | No | `http://localhost:8080` | Registry snapshot and proxy callbacks |
| `ENDERCLOUD_REDIS_URL` | No | `redis://localhost:6379` | Registry and transfer subscriptions |

Both values must point to private services reachable by the Velocity process.

## Test variables

Orchestrator integration tests read optional `TEST_DATABASE_URL`. When it is absent, the tests
start a disposable PostgreSQL container through Testcontainers. When it is present, tests use the
provided database and may create or alter EnderCloud tables there. Use a dedicated test database.

Dashboard tests set `DASHBOARD_MOCK_DATA` as needed. The Playwright configuration starts a built
dashboard with synthetic data on port 3100.

## Duration formats

Orchestrator and agent environment durations accept a positive integer followed by `ms`, `s`,
`m`, `h`, or `d`. Examples:

```dotenv
SCHEDULER_CAPACITY_INTERVAL=500ms
HOST_OFFLINE_TIMEOUT=30s
EXECUTOR_OPERATION_TIMEOUT=10m
INCIDENT_HISTORY_RETENTION=90d
```

Group YAML durations accept only `ms`, `s`, `m`, or `h`. See
[the timeout reference](TIMEOUTS.md).

## Removed environment names

Remove old names instead of defining both old and new values.

| Removed name | Replacement |
| --- | --- |
| `ORCHESTRATOR_PORT` | `ORCHESTRATOR_LISTEN_PORT` |
| `GROUPS_ROOT` | `ORCHESTRATOR_GROUPS_DIRECTORY` |
| `TEMPLATES_ROOT` | `ORCHESTRATOR_TEMPLATES_DIRECTORY` |
| `CAPACITY_INTERVAL_MS` | `SCHEDULER_CAPACITY_INTERVAL` |
| `MATCHMAKING_INTERVAL_MS` | `SCHEDULER_MATCHMAKING_INTERVAL` |
| `HOST_RECONCILE_INTERVAL_MS` | `SCHEDULER_RECONCILIATION_INTERVAL` |
| `RECONCILE_INTERVAL_MS` | `SCHEDULER_RECONCILIATION_INTERVAL` |
| `HOST_OFFLINE_AFTER_MS` | `HOST_OFFLINE_TIMEOUT` |
| `AGENT_PROBE_TIMEOUT_MS` | `EXECUTOR_PROBE_TIMEOUT` |
| `AGENT_OPERATION_TIMEOUT_MS` | `EXECUTOR_OPERATION_TIMEOUT` |
| `INCIDENT_RECONCILE_INTERVAL_MS` | `SCHEDULER_INCIDENT_INTERVAL` |
| `INCIDENT_BLOCKED_AFTER_MS` | `INCIDENT_BLOCKED_AFTER` |
| `INCIDENT_FAILURE_WINDOW_MS` | `INCIDENT_FAILURE_WINDOW` |
| `INCIDENT_HOST_RECOVERY_AFTER_MS` | `INCIDENT_HOST_RECOVERY_AFTER` |
| `INCIDENT_HISTORY_RETENTION_MS` | `INCIDENT_HISTORY_RETENTION` |
| `TRANSFER_TIMEOUT_MS` | `timeouts.transfer` in each group |
| `CANCELLED_DRAIN_TIMEOUT_MS` | `timeouts.cancelled_drain` in each group |
| `MAX_INSTANCE_RETRIES` | `INSTANCE_START_RETRY_LIMIT` |
| `LOG_LEVEL` | `ORCHESTRATOR_LOG_LEVEL` or `AGENT_LOG_LEVEL` |
| `AGENT_PORT` | `AGENT_LISTEN_PORT` |
| `AGENT_PUBLIC_URL` | `AGENT_ADVERTISED_CONTROL_URL` |
| `AGENT_GAME_ADDRESS` | `AGENT_ADVERTISED_GAME_ADDRESS` |
| `AGENT_CPU` | `AGENT_ALLOCATABLE_CPU` |
| `AGENT_MEMORY_BYTES` | `AGENT_ALLOCATABLE_MEMORY_BYTES` |
| `AGENT_HEARTBEAT_INTERVAL_MS` | `AGENT_HEARTBEAT_INTERVAL` |
| `DOCKER_SOCKET` | `AGENT_DOCKER_SOCKET` |
| `DOCKER_NETWORK` | `AGENT_DOCKER_NETWORK` |
| `RUNTIME_ROOT` | `AGENT_RUNTIME_DIRECTORY` |
| `RUNTIME_HOST_ROOT` | `AGENT_RUNTIME_HOST_DIRECTORY` |
| `TEMPLATE_CACHE_ROOT` | `AGENT_TEMPLATE_CACHE_DIRECTORY` |

Group YAML also rejects the removed `lifecycle` block and old matchmaking timeout aliases. Use
the fields documented in [Server group configuration](../groups/GROUP.md).

## Windows paths

A Bun agent running directly on Windows defaults to the Docker named pipe
`//./pipe/docker_engine`. Managed Minecraft servers must still be Linux containers.

With Docker Desktop, `AGENT_RUNTIME_LOCAL_DIRECTORY` may be a Windows path such as
`C:/EnderCloud/runtime`. `AGENT_RUNTIME_HOST_DIRECTORY` must be the same directory as seen by the
Linux Docker daemon, often `/run/desktop/mnt/host/c/EnderCloud/runtime`.

## Secrets

Keep `.env`, `.env.agent`, and dashboard local environment files out of version control. Use a
unique PostgreSQL password and URL-encode special characters inside `DATABASE_URL`.

The orchestrator and agent APIs do not authenticate callers. Environment values cannot compensate
for an unsafe bind address. Use loopback or private interfaces and enforce network access outside
the application.
