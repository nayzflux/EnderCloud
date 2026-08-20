# Multi-host execution

EnderCloud runs one agent on every Docker host. PostgreSQL remains the source of truth and the
central orchestrator remains the only component allowed to place instances. Agents only execute
requested Docker operations, allocate ports and maintain local files.

## Network requirements

The MVP has no API authentication. Use a private routed network, VPN or overlay network between
the central host and every execution host.

- Agents must reach `ORCHESTRATOR_URL` for heartbeats, template downloads and Minecraft callbacks.
- The orchestrator must reach each `AGENT_PUBLIC_URL`.
- Velocity and players must reach `AGENT_GAME_ADDRESS` on the configured game-port range.
- PostgreSQL, Redis, Docker sockets and control ports must not be publicly reachable.

The standalone compose file publishes the agent API only on `AGENT_BIND_ADDRESS`. Set this to a
private interface, never `0.0.0.0` on an Internet-facing machine. The main compose binds the
orchestrator to loopback by default. Set `ORCHESTRATOR_BIND_ADDRESS` to its private interface when
remote agents need to reach it.

## Central host

Required agent settings in the root `.env`:

| Variable | Meaning |
| --- | --- |
| `AGENT_ID` | Stable lowercase host id. Do not change it after containers exist. |
| `AGENT_GAME_ADDRESS` | Private address returned in Minecraft endpoints. |
| `AGENT_CPU` | Allocatable vCPU advertised to the scheduler. |
| `AGENT_MEMORY_BYTES` | Allocatable memory advertised to the scheduler. |
| `RUNTIME_HOST_ROOT` | Absolute runtime directory as seen by the Docker daemon. |
| `AGENT_GAME_PORT_START` / `AGENT_GAME_PORT_END` | Inclusive published game-port range. |

Start the central stack with:

```powershell
docker compose up --build
```

The `agent` service uses the same image as the orchestrator but starts
`src/agent/index.ts`. It mounts the Docker socket, runtime directory and a persistent template
cache. The orchestrator does not mount any of them.

## Remote hosts

Copy `.env.agent.example` to `.env.agent` on the remote host, then adjust at least:

```dotenv
AGENT_ID=game-paris-02
AGENT_PUBLIC_URL=http://10.20.0.12:8090
AGENT_BIND_ADDRESS=10.20.0.12
AGENT_GAME_ADDRESS=10.20.0.12
AGENT_CPU=8
AGENT_MEMORY_BYTES=17179869184
ORCHESTRATOR_URL=http://10.20.0.10:8080
RUNTIME_HOST_ROOT=/srv/endercloud/runtime
RUNTIME_LOCAL_PATH=/srv/endercloud/runtime
AGENT_GAME_PORT_START=25565
AGENT_GAME_PORT_END=25664
```

Then start only the agent:

```powershell
docker compose --env-file .env.agent -f compose.agent.yml up --build -d
```

The configured Docker network must also be used by the Minecraft containers and exist on that
Docker host. The agent creates the network attachment but does not create cross-host routing.

## Placement and reservations

Only hosts in `ONLINE` health and `ACTIVE` administrative state receive new work. Placement is
serialized in PostgreSQL. It subtracts every physical reservation except confirmed `STOPPED`
instances, then chooses the host with the lowest dominant CPU or memory utilization. Host id is
the deterministic tie-breaker.

`STOPPING`, `FAILED` and `ORPHANED` instances keep their physical reservation until agent cleanup
is confirmed. They do not count toward a group's logical capacity, so replacements may run on a
different host without overcommitting the original one.

## Failure and recovery

Agents heartbeat every five seconds by default. A host becomes `OFFLINE` after 30 seconds without
a heartbeat or successful control call. These values are configured with
`AGENT_HEARTBEAT_INTERVAL_MS`, `HOST_RECONCILE_INTERVAL_MS` and `HOST_OFFLINE_AFTER_MS`.

When an agent returns, its host remains `RECOVERING`. The orchestrator inventories its containers,
removes owned orphans and resolves missing desired instances before marking it `ONLINE`. Pending
deletions are retained while the host is unreachable.

Template layers are cached under `layerId/checksum`. Downloads are streamed as gzip-compressed tar archives,
extracted into a temporary directory, checked for path traversal, verified with the canonical
checksum and renamed atomically. The MVP does not evict valid cached layers.

## Maintenance

The dashboard Hosts page exposes two confirmed actions:

1. **Drain host** immediately moves an `ACTIVE` host to `DRAINING`. It receives no new work.
2. Empty sessions are reassigned. Occupied games finish on the source.
3. Open hubs and warm instances are replaced one by one elsewhere. Each group gets at most one
   surge instance above `maximum_instances`, and the source drains only after its replacement is
   running.
4. If no replacement fits, the source stays active and maintenance waits.
5. Once no physical instance remains, the host enters `MAINTENANCE` and can be reactivated.

Reactivation puts the host back into `RECOVERING`. It becomes eligible for placement only after a
successful inventory reconciliation.

## Local two-agent scenario

`compose.multi-host.test.yml` adds a second agent to the main stack. It uses a separate runtime,
cache and game-port range while sharing the local Docker daemon. This validates the complete HTTP
path and ownership labels without requiring a second machine:

```powershell
docker compose -f compose.yml -f compose.multi-host.test.yml up --build
```

Set `SECONDARY_RUNTIME_HOST_ROOT` to the absolute host path for `runtime-secondary`. This scenario
is a deployment smoke test, not a substitute for validating private routing and firewalls between
two physical hosts.
