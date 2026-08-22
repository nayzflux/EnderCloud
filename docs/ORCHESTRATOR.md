# Orchestrator

The orchestrator is EnderCloud's central control-plane process. It is the only component that
chooses hosts, changes lifecycle state, forms sessions, writes transfer commands, or interprets
group policy. Run one active orchestrator against a PostgreSQL database.

The entry point is `orchestrator/src/index.ts`.

## Responsibilities

The orchestrator:

- migrates the database and synchronizes group and template configuration;
- maintains group capacity and warm pools;
- forms minigame sessions from atomic parties;
- reserves CPU and memory on one eligible execution host;
- records durable create commands and dispatches them to agents;
- processes Paper readiness, presence, assignment, and game lifecycle events;
- persists and retries Velocity transfer commands;
- renews hubs, drains instances, and coordinates host maintenance;
- reconciles desired state with agent container inventories;
- aggregates monitoring samples and tracks operational incidents;
- exposes private HTTP and OpenAPI endpoints for agents, plugins, and the dashboard.

It does not mount a Docker socket, read remote host files, allocate game ports, or connect players
to Minecraft servers. Those jobs belong to agents and Velocity.

## Startup sequence

The process performs these steps before readiness returns HTTP 200:

1. Parse and validate every orchestrator environment variable.
2. Create the configured group and template directories if they are missing.
3. Apply pending SQL migrations.
4. Reject an unsafe multi-host migration if an active legacy instance has no `host_id`.
5. Parse, validate, checksum, and synchronize groups and template layers.
6. Connect the Redis event bus.
7. Recover interrupted instance-start commands.
8. Reconcile variant startup policy, host inventory, capacity, transfers, and incidents once.
9. Start the API and periodic control loops.

`GET /health/live` reports that the process can serve HTTP. `GET /health/ready` reports that the
startup sequence completed. Compose depends on readiness, not only liveness.

The orchestrator reads group and template files only during startup. Restart it after editing
YAML or template content.

## Run it

The normal deployment starts the whole stack from the repository root:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

For a development process, first make PostgreSQL and Redis reachable, then run:

```powershell
cd orchestrator
bun install --frozen-lockfile
bun run dev
```

`bun run dev` watches TypeScript files. `bun run start` starts the same entry point without watch
mode.

## Control loops

Each named loop refuses to overlap with its previous run. A slow tick is skipped instead of
running the same controller twice.

| Loop | Frequency | Work |
| --- | --- | --- |
| Capacity | `SCHEDULER_CAPACITY_INTERVAL` | Create or drain instances to match group capacity |
| Instance start worker | 250 ms | Claim and execute durable create commands with bounded concurrency |
| Matchmaking | `SCHEDULER_MATCHMAKING_INTERVAL` | Select queued parties and form or fill sessions |
| Sessions | `SCHEDULER_MATCHMAKING_INTERVAL` | Advance transfers, deadlines, cancellation, and completion |
| Transfers | `SCHEDULER_MATCHMAKING_INTERVAL` | Retry durable Velocity commands until completion or expiry |
| Reconciliation | `SCHEDULER_RECONCILIATION_INTERVAL` | Reconcile hosts, containers, and desired instances |
| Host maintenance | `SCHEDULER_CAPACITY_INTERVAL` | Replace and drain instances on hosts under maintenance |
| Incidents | `SCHEDULER_INCIDENT_INTERVAL` | Detect, update, and resolve operational incidents |
| Variant startup policy | `SCHEDULER_RECONCILIATION_INTERVAL` | Process retry backoff, blocks, and reset cleanup |
| Monitoring retention | 1 hour | Remove expired monitoring buckets |
| Incident retention | 1 hour | Remove resolved incidents older than the retention policy |

## HTTP API

The generated OpenAPI page is available at `/openapi`. Treat it as the request and response
schema reference. The route groups are:

| Prefix | Caller | Purpose |
| --- | --- | --- |
| `/health/*` | Compose and operators | Liveness and readiness |
| `/api/v1/hosts/*` | Agents and dashboard | Heartbeats, drain, and activation |
| `/api/v1/template-layers/*` | Agents | Checksum-bound template archive download |
| `/api/v1/proxy/*` | Velocity | Registry snapshot and disconnect reporting |
| `/api/v1/queue/*` | Paper integrations | Enqueue and remove atomic parties |
| `/api/v1/instances/*` | Paper integrations | Events, hub transfers, assignments, and acknowledgements |
| `/api/v1/dashboard/*` | Dashboard server routes | Cluster, group, queue, instance, session, monitoring, and incident reads |
| `/api/v1/groups/*/startup-retry` | Dashboard server routes | Reset a blocked variant revision |

Every request receives an `x-request-id`. If the caller provides one, the orchestrator keeps it.
Durable work also adds a command identifier to logs and agent calls.

The API has no authentication in the current MVP. Bind it to loopback or a private interface.

## Environment variables

This table lists every variable read by the orchestrator process. Defaults come from
`orchestrator/src/config.ts`, not from Compose.

Durations require an integer and one of `ms`, `s`, `m`, `h`, or `d`. A bare number is invalid.
Paths are resolved against the process working directory.

| Variable | Required | Default | Validation and purpose |
| --- | :---: | --- | --- |
| `DATABASE_URL` | Yes | None | `postgres:` or `postgresql:` URL with an explicit password. PostgreSQL source of truth |
| `REDIS_URL` | No | `redis://localhost:6379` | `redis:` or `rediss:` URL for proxy events |
| `ORCHESTRATOR_LISTEN_PORT` | No | `8080` | Integer from 1 to 65535. Internal HTTP listen port |
| `ORCHESTRATOR_GROUPS_DIRECTORY` | No | `../groups` | Directory containing group YAML files |
| `ORCHESTRATOR_TEMPLATES_DIRECTORY` | No | `../templates` | Directory containing immediate template-layer directories |
| `ORCHESTRATOR_LOG_LEVEL` | No | `info` | One of `debug`, `info`, `warn`, or `error` |
| `INSTANCE_START_CONCURRENCY` | No | `4` | Integer from 1 to 64. Maximum concurrent claimed create commands |
| `INSTANCE_START_RETRY_LIMIT` | No | `5` | Integer from 0 to 20. Number of counted failures allowed to enter backoff. The next failure blocks the revision |
| `INSTANCE_START_RETRY_BASE_DELAY` | No | `1s` | Positive duration. Base of exponential startup backoff |
| `SCHEDULER_CAPACITY_INTERVAL` | No | `5s` | Duration of at least 100 ms. Capacity and maintenance cadence |
| `SCHEDULER_MATCHMAKING_INTERVAL` | No | `1s` | Duration of at least 100 ms. Matchmaking, session, and transfer cadence |
| `SCHEDULER_RECONCILIATION_INTERVAL` | No | `5s` | Duration of at least 1 second. Host reconciliation and startup-policy cadence |
| `SCHEDULER_INCIDENT_INTERVAL` | No | `5s` | Duration of at least 1 second. Incident detection cadence |
| `HOST_OFFLINE_TIMEOUT` | No | `30s` | Duration of at least 5 seconds without heartbeat or successful control contact |
| `EXECUTOR_PROBE_TIMEOUT` | No | `3s` | Duration of at least 100 ms for agent inventory and inspection calls |
| `EXECUTOR_OPERATION_TIMEOUT` | No | `10m` | Duration of at least 1 second for long agent create, stop, and delete calls |
| `INCIDENT_BLOCKED_AFTER` | No | `30s` | Duration of at least 1 second before a blocked condition becomes incident evidence |
| `INCIDENT_FAILURE_THRESHOLD` | No | `3` | Positive integer count for repeated-failure incidents |
| `INCIDENT_FAILURE_WINDOW` | No | `15m` | Duration of at least 1 second in which repeated failures are counted |
| `INCIDENT_HOST_RECOVERY_AFTER` | No | `1m` | Duration of at least 1 second before a recovering host is considered stuck |
| `INCIDENT_HISTORY_RETENTION` | No | `90d` | Duration of at least 1 minute for resolved incident history |

The root `compose.yml` sets internal ports and configuration paths explicitly. It forwards the
startup, scheduler, host, executor, and log settings shown in its `orchestrator.environment`
section. Docker Compose only passes declared values into the container. If you tune an incident
variable that is not declared there, add the same variable to that environment section or run the
orchestrator outside that Compose service.

## Compose-only variables

These values are consumed by Docker Compose or the PostgreSQL image. The orchestrator process does
not read them directly.

| Variable | Default in `compose.yml` | Purpose |
| --- | --- | --- |
| `POSTGRES_DB` | `endercloud` | Database created by the PostgreSQL image |
| `POSTGRES_USER` | `endercloud` | PostgreSQL role created by the image |
| `POSTGRES_PASSWORD` | Required | Password created by the image. Keep it in sync with `DATABASE_URL` |
| `ORCHESTRATOR_PUBLISH_ADDRESS` | `127.0.0.1` | Host interface that publishes the orchestrator API |
| `ORCHESTRATOR_PUBLISH_PORT` | `8080` | Host port mapped to internal port 8080 |

`ORCHESTRATOR_PUBLISH_ADDRESS` does not change the URL used inside the Compose network. The primary
agent uses `http://orchestrator:8080`. Remote agents need a private address that resolves to the
published central host.

## Database migrations

Startup applies migrations automatically. To apply them without starting the API:

```powershell
cd orchestrator
$env:DATABASE_URL = "postgres://endercloud:change-me@localhost:5432/endercloud"
bun run db:migrate
```

Generate a migration after changing `src/db/schema.ts`:

```powershell
bun run db:generate
```

Review generated SQL before committing it. Do not edit an already deployed migration.

## Logging and diagnosis

The orchestrator emits one JSON object per line. Common context fields include `service`,
`component`, `requestId`, `commandId`, `task`, `runId`, `hostId`, `instanceId`, `groupId`, and
`variantId`. URL credentials and environment values whose names contain password, secret, token,
key, or credential are redacted.

Use `debug` only during diagnosis because scheduler and HTTP completion events are noisy at that
level. Startup failures appear through the bootstrap logger even when full configuration cannot
load.

For lifecycle problems, correlate the instance detail in the dashboard with structured logs,
the durable command, the host health state, and any active incident. For a blocked variant,
inspect the retained log tail and runtime before requesting a retry.

See [Environment configuration](ENVIRONMENT.md) for removed names and [Agent](AGENT.md) for the
execution-side settings.
