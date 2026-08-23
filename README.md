# EnderCloud

EnderCloud is an open-source Minecraft server orchestrator and autoscaler for on-demand game
servers. It keeps warm capacity ready, matches parties into minigame sessions, starts Paper
servers across Docker hosts, and moves players through Velocity without making game plugins
manage infrastructure.

The project uses a modular monolith for the central control plane. PostgreSQL stores durable
state. Redis carries short-lived proxy events. A small agent runs on each execution host and owns
Docker, local runtime files, template caching, and game-port allocation.

![EnderCloud dashboard overview](./images/dashboard/overview_tab.png)

## What EnderCloud does

- Maintains minimum and maximum instance counts for hub and minigame groups.
- Keeps a configurable warm pool so matchmaking does not wait for every server to boot.
- Enqueues whole parties and builds team-compatible sessions without splitting a party.
- Selects weighted server variants and resolves their ordered template layers.
- Places instances across Docker hosts according to reserved CPU and memory.
- Registers and unregisters Paper servers in Velocity through Redis events and HTTP snapshots.
- Persists transfers, lifecycle deadlines, assignments, incidents, and retry state in PostgreSQL.
- Reconciles database state with the containers reported by each host agent.
- Drains hosts for maintenance and replaces open capacity before removing the source instance.
- Exposes a Next.js operations dashboard for groups, hosts, instances, sessions, queues,
  topology, monitoring, and incidents.
- Provides Paper and Velocity integration APIs for game plugins and proxy plugins.

## Repository map

| Path | Contents |
| --- | --- |
| `orchestrator/` | Bun and TypeScript control plane, host-agent entry point, migrations, and tests |
| `dashboard/` | Next.js operations console and its browser-facing proxy routes |
| `web/` | Public Next.js landing page and local Fumadocs documentation snapshot |
| `plugins/core/` | Java contracts, HTTP client, and public Paper and Velocity APIs |
| `plugins/paper/` | Paper bridge for readiness, presence, assignments, and game events |
| `plugins/velocity/` | Dynamic server registry, player transfers, and hub fallback |
| `groups/` | Group policy files loaded and validated at orchestrator startup |
| `templates/` | Ordered server layers and final variant descriptors |
| `contracts/` | Shared JSON fixtures used by TypeScript and Java tests |
| `runtime/` | Generated instance data. Its contents are disposable and must not be committed |

## How the pieces fit

Velocity and Paper plugins call the orchestrator over the private control network. The
orchestrator makes every placement and lifecycle decision, writes it to PostgreSQL, then asks the
selected agent to carry out the Docker operation. Agents never choose where an instance runs and
do not write control-plane state directly.

Each agent downloads immutable template layers from the orchestrator, verifies their checksums,
materializes them under its local runtime directory, and starts a constrained Minecraft
container. The container is named `endercloud-<variant-id>-<instance-id>`. Velocity registers it
as `ec-<variant-id>-<instance-id>`.

Read [the architecture guide](docs/ARCHITECTURE.md) for component boundaries and request flows.
Read [the concepts guide](docs/CONCEPTS.md) for groups, variants, instances, sessions, warm
capacity, assignments, deadlines, and incidents.

## Requirements

- Bun 1.3 or newer
- JDK 25
- Docker with Docker Compose
- A Docker runtime compatible with Testcontainers for integration tests

The Compose stack supplies PostgreSQL and Redis. A manual orchestrator process needs access to
both services.

## Quick start

On Linux, the interactive installer can create a local master, worker, or both configurations:

```bash
bash install.sh
```

It writes generated Compose files and private environment files to `deployment/`. The directory is
ignored by Git. The installer checks Docker, asks for the private network addresses and agent
resources, validates the generated Compose configuration, then asks before starting services.

### Install Docker on Linux

Install Docker Engine with the procedure for your distribution in the [official Docker
documentation](https://docs.docker.com/engine/install/). Then install the [Docker Compose
plugin](https://docs.docker.com/compose/install/linux/) if it is not included by your Docker
package.

Confirm both commands work before starting the EnderCloud installer:

```bash
docker --version
docker compose version
```

Copy the minimal environment example and set the required host values:

```powershell
Copy-Item .env.example .env
```

At minimum, replace the PostgreSQL password, set the game address reachable by Velocity, declare
allocatable CPU and memory, and set `AGENT_RUNTIME_HOST_DIRECTORY` to the absolute runtime path as
seen by the Docker daemon.

Then start the central stack:

```powershell
docker compose up --build
```

The default published endpoints are:

| Service | URL |
| --- | --- |
| Dashboard | `http://127.0.0.1:3000` |
| Orchestrator API | `http://127.0.0.1:8080` |
| OpenAPI reference | `http://127.0.0.1:8080/openapi` |

The APIs have no authentication in the current MVP. Keep the dashboard, orchestrator, agents,
PostgreSQL, Redis, and Docker sockets on trusted networks. Publish only the Minecraft game-port
ranges to players.

The repository includes complete example server files under `templates/`. Treat them as local
deployment assets. Change a final variant's `revision` after modifying any effective layer so the
new content is distinct from running instances.

## Build and test

Install and validate each part from its own directory:

```powershell
cd orchestrator
bun install --frozen-lockfile
bun run typecheck
bun run test:unit

cd ../plugins
.\gradlew.bat :core:build :paper:check :velocity:check :paper:shadowJar :velocity:shadowJar

cd ../dashboard
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build

cd ../web
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build
bun run test:e2e
```

The orchestrator integration suite needs Docker:

```powershell
cd orchestrator
bun run test:integration
```

See [the development guide](docs/DEVELOPMENT.md) for local services, migrations, watch mode,
build artifacts, and common workflows. See [the test reference](docs/TEST.md) for every validation
command and the scope of each suite.

## Configure groups and variants

A group defines capacity, routing or matchmaking, lifecycle timeouts, and the final variants it
may use. A template layer contains files and an optional runtime patch. A final variant declares
a positive revision and may compose several parent layers in order.

The orchestrator reads `groups/` and `templates/` once during startup. Any invalid descriptor,
missing parent, unsafe file, inconsistent limit, or unresolved runtime setting stops startup.
Restart the orchestrator after a configuration change.

- [Group configuration reference](groups/GROUP.md)
- [Template and variant reference](templates/VARIANT.md)
- [Timeout and deadline reference](docs/TIMEOUTS.md)
- [Minigame plugin integration](docs/MINIGAME_PLUGIN_INTEGRATION.md)

## Documentation

| Guide | Purpose |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Components, boundaries, data ownership, and main control flows |
| [Concepts](docs/CONCEPTS.md) | Domain vocabulary and state machines |
| [Orchestrator](docs/ORCHESTRATOR.md) | Startup, control loops, API groups, and every orchestrator variable |
| [Agent](docs/AGENT.md) | Docker execution, cache behavior, recovery, and every agent variable |
| [Environment](docs/ENVIRONMENT.md) | Project-wide environment files, Compose-only values, and renamed variables |
| [Multi-host](docs/MULTI_HOST.md) | Private networking, remote agents, placement, recovery, and maintenance |
| [Dashboard](dashboard/README.md) | Console routes, mock data, local development, and validation |
| [Development](docs/DEVELOPMENT.md) | Tooling, commands, migrations, and contribution workflow |
| [Tests](docs/TEST.md) | Unit, integration, Java, dashboard, and deployment checks |
