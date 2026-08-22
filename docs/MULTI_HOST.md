# Multi-host execution

EnderCloud runs one agent on every Docker host. The central orchestrator remains the only process
that places instances and changes durable lifecycle state. Agents execute Docker operations,
allocate local ports, cache templates, and report runtime inventory.

PostgreSQL and Redis stay central. Remote agents do not connect to either service.

## Network requirements

The current MVP has no API authentication. Connect hosts through a private routed network, VPN,
or overlay network and restrict each control port with a firewall.

| Source | Destination | Purpose |
| --- | --- | --- |
| Agent | `ORCHESTRATOR_URL` | Heartbeats and template archives |
| Managed Paper container | `ORCHESTRATOR_URL` | Readiness, presence, assignments, and game events |
| Orchestrator | `AGENT_ADVERTISED_CONTROL_URL` | Inventory, create, inspect, logs, stop, and delete |
| Velocity | `AGENT_ADVERTISED_GAME_ADDRESS` and game-port range | Backend Minecraft connections |
| Velocity | Central Redis and orchestrator | Registry events, transfers, and HTTP snapshot |
| Dashboard server | Orchestrator | Operational reads and confirmed actions |

PostgreSQL, Redis, Docker sockets, agent control APIs, and the orchestrator API must not be
Internet-facing. Only Velocity's public listener normally needs public player access. Backend game
ports still need private reachability from Velocity.

The standalone agent publishes its API only on `AGENT_PUBLISH_ADDRESS`. Never set it to
`0.0.0.0` on an Internet-facing host. The root stack publishes the orchestrator and dashboard on
`127.0.0.1` by default. Set `ORCHESTRATOR_PUBLISH_ADDRESS` to a private interface when remote
agents need it. Remote agents do not need dashboard access.

## Address meanings

Several variables describe different sides of the same connection:

| Variable | Who must reach it |
| --- | --- |
| `ORCHESTRATOR_URL` | The agent and every managed Paper container on that host |
| `AGENT_ADVERTISED_CONTROL_URL` | The central orchestrator |
| `AGENT_ADVERTISED_GAME_ADDRESS` | Velocity on the path to published Minecraft ports |
| `AGENT_PUBLISH_ADDRESS` | Host interface where standalone Compose binds the control API |
| `ORCHESTRATOR_PUBLISH_ADDRESS` | Central host interface where Compose binds the orchestrator API |

An advertised URL is part of application protocol. A publish address is a Compose host binding.
They often contain the same IP on a remote Linux host, but they are not interchangeable.

## Central host

The root `compose.yml` starts:

- PostgreSQL;
- Redis;
- the central orchestrator;
- the primary execution agent;
- the dashboard.

Required primary-agent values in the root `.env` are:

```dotenv
AGENT_ID=primary-host
AGENT_ADVERTISED_GAME_ADDRESS=10.20.0.10
AGENT_ALLOCATABLE_CPU=8
AGENT_ALLOCATABLE_MEMORY_BYTES=17179869184
AGENT_RUNTIME_LOCAL_DIRECTORY=./runtime
AGENT_RUNTIME_HOST_DIRECTORY=/srv/endercloud/runtime
```

The main stack fixes the primary agent's internal control URL to `http://agent:8090` and its
orchestrator URL to `http://orchestrator:8080`. These Docker service names work only inside the
central Compose network.

Start the central stack:

```powershell
docker compose up --build -d
```

If remote agents must reach the orchestrator, publish it on the central machine's private
interface:

```dotenv
ORCHESTRATOR_PUBLISH_ADDRESS=10.20.0.10
ORCHESTRATOR_PUBLISH_PORT=8080
```

Allow inbound TCP 8080 only from execution hosts, managed server networks, Velocity, and operator
networks that need the API.

## Remote host

Copy the repository or the required build context and Compose file to the execution host. Create
`.env.agent` from the example:

```powershell
Copy-Item .env.agent.example .env.agent
```

A Linux host at `10.20.0.12` could use:

```dotenv
AGENT_ID=game-paris-02
AGENT_VERSION=0.1.0
AGENT_ADVERTISED_CONTROL_URL=http://10.20.0.12:8090
AGENT_ADVERTISED_GAME_ADDRESS=10.20.0.12
AGENT_ALLOCATABLE_CPU=8
AGENT_ALLOCATABLE_MEMORY_BYTES=17179869184
AGENT_RUNTIME_LOCAL_DIRECTORY=/srv/endercloud/runtime
AGENT_RUNTIME_HOST_DIRECTORY=/srv/endercloud/runtime
AGENT_PUBLISH_ADDRESS=10.20.0.12
AGENT_PUBLISH_PORT=8090
AGENT_DOCKER_NETWORK=endercloud
AGENT_GAME_PORT_START=25565
AGENT_GAME_PORT_END=25664
ORCHESTRATOR_URL=http://10.20.0.10:8080
```

Start only the agent:

```powershell
docker compose --env-file .env.agent -f compose.agent.yml up --build -d
```

Check its local readiness:

```powershell
Invoke-RestMethod http://10.20.0.12:8090/health/ready
```

The host should first appear as `RECOVERING`, then `ONLINE` after inventory reconciliation.

## Docker networks do not span hosts

`AGENT_DOCKER_NETWORK` names a network local to one Docker daemon. The standalone Compose file may
create a bridge with the same name on several machines, but those bridges are unrelated.

Do not use a Docker service name from another host in an advertised address. Use a DNS name or IP
that the private routed network resolves and carries between machines.

Managed containers also receive the agent's `ORCHESTRATOR_URL`. Confirm that the selected Docker
network can route to that address, not only the agent container itself.

## Runtime paths

Two path variables refer to the same underlying directory from different viewpoints:

- `AGENT_RUNTIME_LOCAL_DIRECTORY` is the host path that Compose mounts into the agent.
- `AGENT_RUNTIME_HOST_DIRECTORY` is the path the Docker daemon uses when the agent asks it to bind
  an instance directory into a Minecraft container.

On native Linux they are normally identical. With Docker Desktop or a remote daemon, the daemon
may see a different path. A wrong host path lets the agent create files but causes the child
container to mount an empty or missing directory.

After deployment, start one test instance and verify that its `/data` contains the expected
materialized template before enabling production traffic.

## Placement and reservations

Only hosts with health `ONLINE` and administration state `ACTIVE` receive new work. Placement runs
inside a PostgreSQL transaction and uses durable CPU and memory reservations.

For each eligible host, EnderCloud computes CPU utilization and memory utilization after current
reservations. It compares the larger of the two values, called dominant utilization, and chooses
the smallest. Host ID breaks ties.

Instances in `STOPPING`, `FAILED`, or `ORPHANED` keep physical reservations until the agent
confirms cleanup. They no longer count toward logical group capacity, which allows a replacement
on another host without pretending the original resources are free.

Set allocatable resources below the machine's physical total when the operating system, Docker,
Velocity, monitoring, or other services need reserved headroom.

## Heartbeat, failure, and recovery

Agents heartbeat every five seconds by default. The orchestrator marks a host `OFFLINE` after 30
seconds without a heartbeat or successful control call. The relevant settings are:

```text
AGENT_HEARTBEAT_INTERVAL
SCHEDULER_RECONCILIATION_INTERVAL
HOST_OFFLINE_TIMEOUT
```

While a host is offline:

- it receives no new placement;
- pending cleanup remains durable;
- the orchestrator may replace logical capacity elsewhere;
- physical reservations stay on the offline host until reconciliation proves the runtime gone.

When the agent returns, the host enters `RECOVERING`. The orchestrator inventories containers
carrying EnderCloud ownership labels, removes exact owned orphans, and resolves desired instances
whose containers are missing. Only a successful pass changes health to `ONLINE`.

The agent cache stores template layers under `layerId/checksum`. Missing layers are downloaded and
verified during create. Valid cache entries are not evicted automatically, so include the cache
volume in disk monitoring.

## Host maintenance

The dashboard exposes confirmed drain and activate actions.

Drain proceeds in this order:

1. Change administration state from `ACTIVE` to `DRAINING` so placement stops immediately.
2. Reassign empty sessions when possible. Occupied games finish on the source host.
3. Replace open hubs and warm instances one at a time on other hosts.
4. Wait for each replacement to reach `RUNNING` before draining its source.
5. Enter `MAINTENANCE` only after no physical instance remains.

Each group gets at most one maintenance replacement above `maximum_instances`. If no other host
has enough resources, the source instance remains available and maintenance waits. EnderCloud
does not sacrifice live capacity to make the dashboard look drained.

Activation changes the host back to `RECOVERING`. It becomes eligible for placement only after a
fresh successful inventory pass.

## Local two-agent scenario

`compose.multi-host.test.yml` adds a second agent to the main stack. Both agents share the local
Docker daemon but use separate runtime directories, cache volumes, host IDs, and port ranges.

Set these values in the root `.env`:

```dotenv
SECONDARY_AGENT_GAME_ADDRESS=192.0.2.11
SECONDARY_AGENT_CPU=4
SECONDARY_AGENT_MEMORY_BYTES=8589934592
SECONDARY_RUNTIME_HOST_ROOT=/absolute/path/to/EnderCloud/runtime-secondary
```

Start the combined files:

```powershell
docker compose -f compose.yml -f compose.multi-host.test.yml up --build
```

The primary uses ports 25565 through 25664 by default. The secondary uses 25665 through 25764.
Both advertised game addresses must be reachable by the Velocity process used for the test.

Stop the same file set:

```powershell
docker compose -f compose.yml -f compose.multi-host.test.yml down
```

This scenario tests the complete HTTP control path and ownership labels. It does not test routing,
latency, firewall rules, MTU, or failure between physical machines.

## Deployment checklist

- Every agent has a unique stable ID.
- The central orchestrator is reachable from agents and managed Paper containers.
- The orchestrator can reach every advertised agent control URL.
- Velocity can reach every advertised game address and port range.
- Agent control ports accept traffic only from the orchestrator network.
- PostgreSQL, Redis, and Docker sockets are not exposed between untrusted hosts.
- Runtime local and Docker-daemon paths resolve to the same data.
- Port ranges do not overlap for agents sharing a Docker daemon or host address.
- Allocatable CPU and memory leave operating-system headroom.
- Agent cache and runtime disks have monitoring and enough free space.
- A real instance reaches `RUNNING` on each host before production placement is enabled.
- Drain and activation have been tested without terminating an occupied game.

See [Agent](AGENT.md) for the complete variable reference and [Tests](TEST.md) for the local smoke
test.
