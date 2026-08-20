# EnderCloud

EnderCloud is a modular monolithic orchestrator for disposable Minecraft servers. PostgreSQL
stores every durable decision, Redis broadcasts ephemeral proxy events, and one Bun agent per
execution host manages Docker, local ports, runtimes and template caches.

![Overview](./images/dashboard/overview_tab.png)

![Instances Tab](./images/dashboard/instances_tab.png)

Docker containers use `endercloud-<variant-id>-<instance-id>`; Velocity registers them as
`ec-<variant-id>-<instance-id>`.

## Repository layout

- `orchestrator/`: the central Bun orchestrator and the host-agent entry point.
- `dashboard/`: console Next.js, React Flow, TanStack Query et shadcn/ui.
- `plugins/core`: platform-neutral Java 25 client, contracts and integration APIs.
- `plugins/velocity`: dynamic server registry, transfers and hub fallback.
- `plugins/paper`: readiness, player presence and game lifecycle bridge.
- `groups/`: logical matchmaking and capacity policies loaded at startup.
- `templates/`: complete immutable server variants.
- `runtime/`: disposable per-instance copies; never commit its contents.

The provided groups are intentionally disabled because the repository does not ship a playable
Minecraft map or game plugin.

## Build and test

Requirements are Bun 1.3+, JDK 25, Docker and Docker Compose.

```powershell
cd orchestrator
bun install --frozen-lockfile
bun run typecheck
bun test

cd ../plugins
./gradlew build

cd ../dashboard
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
```

The platform JARs are produced as:

- `plugins/core/build/libs/EnderCloudCore-0.1.0.jar`
- `plugins/paper/build/libs/EnderCloudPaper-0.1.0.jar`
- `plugins/velocity/build/libs/EnderCloudVelocity-0.1.0.jar`

Both are shaded. Platform APIs themselves remain `compileOnly`.

## Run the infrastructure

Stop every managed instance before applying the multi-host migration. Startup rejects any active
legacy instance that has no `host_id`.

Copy `.env.example` to `.env`, configure the primary agent's explicit CPU and memory limits, and
set `RUNTIME_HOST_ROOT` to the absolute runtime path seen by the Docker daemon. With Docker
Desktop this may be a VM mount such as `/run/desktop/mnt/host/c/...`, rather than a Windows path.
`AGENT_GAME_ADDRESS` must be the private address used by Velocity and players to reach the
published game-port range.

```powershell
docker compose up --build
```

The dashboard is available on `http://localhost:3000`, or the port configured with
`DASHBOARD_PORT`. Its server proxy exposes the dashboard read routes and the confirmed host
maintenance actions, then reaches the orchestrator through `ORCHESTRATOR_URL`.

Pour le développement local, lancer l'orchestrateur puis :

```powershell
cd dashboard
Copy-Item .env.example .env.local
bun run dev
```

Pour travailler sur l'interface sans lancer l'orchestrateur, Docker ni PostgreSQL, activer
`DASHBOARD_MOCK_DATA=true` dans `dashboard/.env.local` : le dashboard sert alors un cluster
synthétique. Voir `dashboard/README.md`.

The orchestrator, its local agent and the internal services remain on the `endercloud` network.
The orchestrator no longer mounts the Docker socket. Even the primary host is controlled through
the agent API. Attach Velocity to the same network and keep PostgreSQL, Redis and every control
port private. Only the configured game-port range should be exposed to players.

To add a remote Docker host, copy the repository and an agent environment file to that host, then
run `docker compose -f compose.agent.yml up --build`. The private network must allow both directions:
the agent downloads templates and sends heartbeats to the orchestrator, while the orchestrator
calls the agent's control URL. See [`docs/MULTI_HOST.md`](docs/MULTI_HOST.md) for all variables,
recovery behavior and maintenance semantics.

## Enable a group

1. Build the Paper bridge and place its shaded JAR in a shared template layer's `plugins/` directory.
2. Add mode-specific configuration and map layers as needed.
3. Add a final `variant.yml` with its ordered `parents`, following `templates/VARIANT.md`.
4. Reference the final id from the group with `enabled` and `weight`, then enable the group.
5. Restart the orchestrator so it validates and synchronizes the YAML.

Never modify a template used by a running orchestrator. Increment `revision` after changing a
variant. Images must use an explicit tag or digest; `latest` is rejected.

## Plugin integration

Paper-side plugins obtain the service through Bukkit:

```java
EnderCloudPaperApi cloud = Bukkit.getServicesManager()
    .load(EnderCloudPaperApi.class);
```

Use it to enqueue an atomic party, leave a queue, read the current anonymous team profiles and report
`GAME_STARTING`, `GAME_STARTED`, `GAME_CANCELLED` or `GAME_FINISHED`. A cancellation immediately
unregisters the minigame, durably transfers its connected players to available hubs and enforces the
short per-group `timeouts.cancelled_drain` safety deadline. EnderCloud deliberately adds no player commands
and no game-specific behavior.

Paper plugins can also call `sendToHub(UUID)` or `sendToHub(Collection<UUID>)`. Accepted players are
durably scheduled across the least-loaded running hubs; the returned future does not wait for their
arrival. `target_players_per_instance` is a soft autoscaling target, while
`maximum_players_per_instance` is the strict routing limit.

The Velocity plugin instance implements `EnderCloudVelocityApi`. Another Velocity plugin can
retrieve the `endercloud` plugin container, obtain its instance, cast it to that interface and
request a hub transfer. Ordinary initial routing and kicked-server fallback are automatic.

## Internal protocol

OpenAPI is available at `/openapi` inside the private network. Important routes include:

- `GET /api/v1/proxy/servers`
- `GET /api/v1/dashboard/cluster`
- `GET /api/v1/dashboard/monitoring/summary`
- `GET /api/v1/dashboard/groups/{groupId}/monitoring?range=1h|6h|24h|7d`
- `GET /api/v1/dashboard/groups/{groupId}/queue`
- `GET /api/v1/dashboard/instances/{instanceId}`
- `GET /api/v1/dashboard/sessions/{sessionId}`
- `PUT /api/v1/hosts/{hostId}/heartbeat`
- `POST /api/v1/hosts/{hostId}/drain`
- `POST /api/v1/hosts/{hostId}/activate`
- `GET /api/v1/template-layers/{layerId}/archive?checksum=...`
- `POST /api/v1/queue/entries`
- `POST /api/v1/proxy/players/{uuid}/disconnected`
- `POST /api/v1/instances/{id}/events`
- `POST /api/v1/instances/{id}/hub-transfers`
- `GET /api/v1/instances/{id}/assignment`

Paper heartbeats may include `tps.oneMinute`, `tps.fiveMinutes` and
`tps.fifteenMinutes`. The field remains optional for older plugin versions.
The orchestrator aggregates these samples per minute and retains seven days of
monitoring history.

Redis uses `minecraft:proxy:registry` and `minecraft:proxy:transfers`. Subscribers connect before
loading their HTTP snapshot and reload it after any malformed event or reconnection.

The orchestrator and agent APIs are intentionally unauthenticated for the MVP. Bind their ports
only to private addresses. Never publish PostgreSQL, Redis, the Docker socket or a control port to
an untrusted network.

See [`docs/TIMEOUTS.md`](docs/TIMEOUTS.md) for the complete list of business deadlines,
group configuration keys and infrastructure timeouts.
