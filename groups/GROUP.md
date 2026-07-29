# Groups

Groups define how EnderCloud creates, routes and manages Minecraft server instances. Each YAML
file in this directory is loaded and validated when the orchestrator starts, then synchronized
to the database.

## Basic fields

```yaml
id: skywars-solo       # lowercase letters, numbers and hyphens
type: minigame         # hub or minigame
enabled: true          # defaults to true when omitted
```

The `id` must be unique. A template selects its group with `group` in `variant.yml`; a minigame
group must have at least one enabled, complete variant before it can accept players.

## Capacity and lifecycle

Both group types require these sections:

```yaml
capacity:
  minimum_instances: 0
  maximum_instances: 20
  minimum_warm_instances: 2
  maximum_warm_instances: 4

lifecycle:
  startup_timeout: 90s
  draining_timeout: 15m
  shutdown_timeout: 20s
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
```

The target must not exceed the maximum. It is a soft aggregate scale-out threshold: reaching the
combined target capacity of the active and starting instances requests another instance, up to
`maximum_instances`. Players already connected above the target stay in place, and new arrivals
continue toward the least-loaded hub until the strict maximum is reached. The `hub` group in
`hub.yml` is the default example and fallback destination used by the proxy.

## Minigame groups

Minigame groups match parties into sessions:

```yaml
matchmaking:
  minimum_players: 4
  maximum_players: 12
  team_count: 12
  team_size: 1
  waiting_timeout: 45s
  candidate_window: 20
  instance_wait_timeout: 45s
  maximum_waiting_timeout: 135s
  partial_start:
    minimum_players_per_team: 0
    maximum_team_spread: 1
```

The first ticket creates a `FORMING` session. Once `minimum_players` and the partial-start profile
constraints are satisfied, EnderCloud reserves an instance; only the game plugin's
`GAME_STARTING` event locks the session. `candidate_window` bounds the FIFO work per tick,
`instance_wait_timeout` covers capacity acquisition, and `maximum_waiting_timeout` bounds an
ineligible on-server lobby. Their defaults are respectively `20`, `waiting_timeout`, and three
times `waiting_timeout`.

The cap cannot exceed `team_count * team_size`; a party larger than `team_size` is rejected.
`minimum_players_per_team` defaults to `0` and `maximum_team_spread` defaults to `team_size`.
For a partial 4v4v4v4 mode with at least one player per team and a spread of at most two, use:

```yaml
matchmaking:
  minimum_players: 8
  maximum_players: 16
  team_count: 4
  team_size: 4
  waiting_timeout: 60s
  partial_start:
    minimum_players_per_team: 1
    maximum_team_spread: 2
```

## Adding or changing a group

1. Copy an existing YAML file and choose a unique `id`.
2. Use the schema for its `type` (`routing` for hubs or `matchmaking` for minigames).
3. Add or update a matching template `variant.yml`.
4. Make sure the map, server settings and required plugins are present in the template.
5. Set `enabled: true` only when the group is ready, then restart the orchestrator.

Configuration errors prevent startup. After changing a variant, increment its `revision`; do not
modify a template used by a running instance.
