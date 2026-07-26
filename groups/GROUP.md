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

The target must not exceed the maximum. The `hub` group in `hub.yml` is the default example and
fallback destination used by the proxy.

## Minigame groups

Minigame groups match parties into sessions:

```yaml
matchmaking:
  minimum_players: 4
  maximum_players: 12
  team_count: 12
  team_size: 1
  waiting_timeout: 45s
```

`minimum_players` starts a session, while `maximum_players` caps its size. The cap cannot exceed
`team_count * team_size`; a party larger than `team_size` is rejected. `waiting_timeout` controls
how long a session waits for an available instance.

## Adding or changing a group

1. Copy an existing YAML file and choose a unique `id`.
2. Use the schema for its `type` (`routing` for hubs or `matchmaking` for minigames).
3. Add or update a matching template `variant.yml`.
4. Make sure the map, server settings and required plugins are present in the template.
5. Set `enabled: true` only when the group is ready, then restart the orchestrator.

Configuration errors prevent startup. After changing a variant, increment its `revision`; do not
modify a template used by a running instance.
