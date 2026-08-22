# Template layers and server variants

Each immediate child directory of `templates/` that contains `variant.yml` is a template layer.
The directory may contain any regular files needed under a Minecraft server's `/data` directory.

A layer becomes an instantiable final variant only when a group references its ID. Reusable parent
layers and final variants use the same descriptor format, but final variants have extra
requirements.

## Directory model

This example composes a shared server, a game mode, and one map:

```text
templates/
  skywars/
    variant.yml
    server.jar
    plugins/
      EnderCloudPaper-0.1.0.jar
      SkyWars.jar
  skywars-solo/
    variant.yml
    plugins/
      SkyWars/
        solo.yml
  skywars-solo-japan/
    variant.yml
    world/
      level.dat
      region/
```

The final descriptor lists all reusable parents in order:

```yaml
id: sw-1s-japan
revision: 2
parents:
  - skywars
  - skywars-solo

environment:
  MAP_ID: japan
```

The resolved stack is `skywars`, `skywars-solo`, then `sw-1s-japan`.

## Descriptor fields

```yaml
id: skywars

docker:
  image: itzg/minecraft-server:java25
  memory: 2G
  cpu: 2

environment:
  EULA: true
  TYPE: CUSTOM
  CUSTOM_SERVER: /data/server.jar
```

| Field | Required | Rules |
| --- | :---: | --- |
| `id` | Yes | Unique ID with 2 to 63 lowercase letters, digits, or dashes |
| `revision` | Final variants only | Positive integer controlled by the operator |
| `parents` | No | Ordered, unique array of reusable layer IDs |
| `docker.image` | In resolved final stack | Image with an explicit tag or SHA-256 digest. `latest` is rejected |
| `docker.memory` | In resolved final stack | Positive byte integer or value ending in `K`, `M`, or `G` |
| `docker.cpu` | In resolved final stack | Positive number of vCPU |
| `environment` | No | Map of string, number, or boolean YAML scalars |

The directory name does not technically define the layer ID. Keep them equal so operators can
find layers by ID without opening every descriptor.

Groups own traffic settings. `group`, `enabled`, and `weight` are invalid in `variant.yml`.

## Parent rules

Inheritance is intentionally flat:

- A final variant may list any number of parent layers.
- A parent layer cannot declare parents of its own.
- A final variant cannot parent itself.
- A parent ID cannot appear twice.
- Every parent ID must exist.

Flat inheritance makes the complete order visible in the final descriptor. It also prevents a
change in a distant nested layer from being hard to trace.

## Merge behavior

Layers are materialized from first to last. The final layer is always last.

- Directories merge recursively.
- A later file replaces an earlier file at the same path.
- A path cannot be a file in one layer and a directory in another.
- Docker fields use the last value declared in the stack.
- Environment keys use the last value declared in the stack.
- `variant.yml` is control-plane metadata and is never copied into instance data.

For example:

```yaml
# skywars/variant.yml
environment:
  MODE_ID: default
  VIEW_DISTANCE: 10
```

```yaml
# skywars-solo/variant.yml
environment:
  MODE_ID: solo
```

The resolved environment contains `MODE_ID=solo` and `VIEW_DISTANCE=10`. EnderCloud converts
numbers and booleans to Docker strings after parsing YAML.

## Runtime requirements

A final stack must resolve all three Docker settings:

```yaml
docker:
  image: itzg/minecraft-server:java25
  memory: 2G
  cpu: 2
```

`memory` accepts a positive integer byte count or a binary suffix. Examples are `524288000`,
`512M`, and `4G`.

Use a fixed image tag or digest. Floating `latest` tags make an unchanged revision produce a
different runtime on another host, so the configuration loader rejects them.

The resolved environment is passed to Docker before the agent adds:

- `ENDERCLOUD_INSTANCE_ID`
- `ENDERCLOUD_ORCHESTRATOR_URL`

If a template declares either key, the agent's generated value wins.

## Checksums and revisions

EnderCloud calculates one SHA-256 checksum per layer from sorted relative paths and file bytes.
The checksum includes `variant.yml`. A final variant checksum is derived from every ordered layer
ID and layer checksum.

The dashboard displays both revision and effective checksum. They answer different questions:

- The checksum identifies exact content.
- The revision identifies an operator-approved release of a final variant.

After changing any file or descriptor in a final variant's effective stack:

1. Increment the final layer's `revision`.
2. Restart the orchestrator so it validates and synchronizes the new content.
3. Confirm the new revision and checksum in the dashboard.
4. Watch the first startup attempt and retry policy.

Existing instances keep their already materialized files. EnderCloud does not mutate a running
server to match a new checksum.

Repeated failures before `SERVER_READY` are tracked for one group, variant, and revision. A new
revision gets a fresh startup history after cleanup of the old retained failure runtime.

## Agent distribution

Agents do not need a copy of the central `templates/` tree. For each instance, the orchestrator
sends the ordered layer IDs and checksums. The selected agent downloads missing archives from the
orchestrator and stores them under:

```text
<template-cache>/<layer-id>/<checksum>/
```

The agent rejects unsafe archive paths and recomputes the checksum before making a download
visible. It then materializes the layers under:

```text
<runtime-directory>/instances/<instance-id>/
```

The cache is persistent. Instance runtime directories are disposable.

## File rules

The loader accepts regular files and directories. It rejects symbolic links anywhere in a layer.
This restriction keeps checksums stable and prevents template archives from escaping their root
on a remote agent.

Avoid committing generated or player-specific world state. Common exclusions include:

```text
players/
stats/
advancements/
session.lock
level.dat_old
logs/
crash-reports/
```

Whether `playerdata/` should be omitted depends on the server version and world layout. Inspect a
test materialization before publishing a map layer.

Keep secrets out of templates. Variant environment and files are stored in the control plane,
downloaded by agents, and visible to anyone with access to the managed container.

## Add a reusable layer

1. Create one immediate child directory under `templates/`.
2. Add `variant.yml` with a unique ID.
3. Add only the files and runtime fields owned by that layer.
4. Reference the ID in a final variant's ordered `parents` array.
5. Increment each affected final variant revision.
6. Restart the orchestrator and check synchronization.

## Add a final variant

1. Create one immediate child directory and add its map or final overrides.
2. Add `variant.yml` with a unique ID and positive revision.
3. List reusable parents from broadest to most specific.
4. Ensure the stack resolves image, memory, and CPU.
5. Reference the final ID from a group with `enabled` and a positive `weight`.
6. Restart the orchestrator.

See [the group reference](../groups/GROUP.md) for traffic and capacity policy.
