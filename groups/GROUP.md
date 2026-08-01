# Groups

Groups define how EnderCloud creates, routes and manages Minecraft server instances. Each YAML
file in this directory is loaded and validated when the orchestrator starts, then synchronized
to the database.

## Basic fields

```yaml
id: skywars-solo       # lowercase letters, numbers and hyphens
type: minigame         # hub or minigame
enabled: true          # defaults to true when omitted

variants:
  - id: skywars-solo-japan
    enabled: true
    weight: 60
  - id: skywars-solo-dome
    enabled: true
    weight: 40
```

The `id` must be unique. A group references final variants directly and owns their selection
state and weight. A group enabled for traffic must have at least one enabled, complete variant.
The same final variant may be referenced by several groups with different weights.

## Capacity and timeouts

Both group types require these sections:

```yaml
capacity:
  minimum_instances: 0
  maximum_instances: 20
  minimum_warm_instances: 2
  maximum_warm_instances: 4

timeouts:
  startup: 90s
  drain: 15m
  cancelled_drain: 10s
  shutdown: 20s
  transfer: 20s
  player_stale: 30s
```

`minimum_instances` and `maximum_instances` bound the total number of instances. Warm instances
are ready instances kept available for new work. The limits must satisfy:

```text
minimum_instances <= maximum_instances
minimum_warm_instances <= maximum_warm_instances <= maximum_instances
```

Durations use `ms`, `s`, `m` or `h`, for example `500ms`, `45s` or `5m`.

## Hub groups

Hub groups route players to shared lobby servers:

```yaml
routing:
  maximum_players_per_instance: 100
  target_players_per_instance: 70

timeouts:
  instance_lifetime: 4h
```

The target must not exceed the maximum. It is a soft aggregate scale-out threshold: reaching the
combined target capacity of the active and starting instances requests another instance, up to
`maximum_instances`. Players already connected above the target stay in place, and new arrivals
continue toward the least-loaded hub until the strict maximum is reached. The `hub` group in
`hub.yml` is the default example and fallback destination used by the proxy.

`instance_lifetime` defaults to `4h`. Once a hub reaches that persisted deadline, EnderCloud
starts a replacement using the current variant selection and drains the old hub only after the
replacement is ready. `maximum_instances` remains a strict limit: if the group is full, the
expired hub stays open until a slot becomes available. Only one renewal runs per group at a time.

## Minigame groups

Minigame groups match parties into sessions:

```yaml
matchmaking:
  minimum_players: 4
  maximum_players: 12
  team_count: 12
  team_size: 1
  candidate_window: 20
  team_balance:
    minimum_players_per_team: 0
    maximum_team_spread: 1
```

The first ticket creates a `FORMING` session. Once `minimum_players` and the team-balance profile
constraints are satisfied, EnderCloud reserves an instance. The game plugin has sole authority
to emit `GAME_STARTING`; the orchestrator does not impose a partial-start deadline.
`candidate_window` bounds the FIFO work per tick.
Minigame groups add their matchmaking deadlines to `timeouts`:

```yaml
  instance_acquisition: 45s
  lobby_stale: 135s
```

They respectively bound capacity acquisition and cancel a lobby that never progresses to
`GAME_STARTING`. See [the timeout reference](../docs/TIMEOUTS.md) for every deadline.

The cap cannot exceed `team_count * team_size`; a party larger than `team_size` is rejected.
`minimum_players_per_team` defaults to `0` and `maximum_team_spread` defaults to `team_size`.
For a 4v4v4v4 formation with at least one player per team and a spread of at most two, use:

```yaml
matchmaking:
  minimum_players: 8
  maximum_players: 16
  team_count: 4
  team_size: 4
  team_balance:
    minimum_players_per_team: 1
    maximum_team_spread: 2
```

## Adding or changing a group

1. Copy an existing YAML file and choose a unique `id`.
2. Use the schema for its `type` (`routing` for hubs or `matchmaking` for minigames).
3. Add the final variant id to `variants` with a positive weight.
4. Add or update its ordered template layers and make sure their resolved content is complete.
5. Set `enabled: true` only when the group is ready, then restart the orchestrator.

Configuration errors prevent startup. After changing a final variant, increment its `revision`;
changing a parent automatically changes every dependent effective checksum. Running instances
keep their already-materialized data.
