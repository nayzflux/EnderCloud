# Layered server variants

Every immediate child directory containing `variant.yml` is a reusable template layer. A layer
becomes a final, instantiable variant only when a group references its id. Groups own `enabled`
and `weight`; a descriptor containing `group`, `enabled` or `weight` is rejected.

Shared layer:

```yaml
id: skywars

docker:
  image: itzg/minecraft-server:java25
  memory: 2G
  cpu: 2

environment:
  TYPE: CUSTOM
  CUSTOM_SERVER: /data/server.jar
```

Final variant:

```yaml
id: sw-1s-japan
revision: 1
parents:
  - skywars
  - skywars-solo

environment:
  MAP_ID: japan
```

Parents are listed from the broadest to the most specific layer. The final layer is applied last.
Files merge recursively and later files replace earlier files at the same path. Docker fields and
environment variables follow the same last-layer-wins rule. File/directory conflicts, symlinks,
missing parents, recursive inheritance and the Docker tag `latest` are rejected.

Inheritance is deliberately flat. A final variant can list several parents, but those parents
cannot list parents of their own. Parent order is significant and duplicate parent ids are
rejected.

Only a final layer referenced by a group must declare `revision`, as a positive integer. Its
resolved stack must provide `docker.image`, `docker.memory` and `docker.cpu`. Memory accepts a
positive byte count or a value such as `512M` or `4G`. Environment values must be YAML strings,
numbers or booleans; EnderCloud converts them to strings before creating the container.

`variant.yml` files are control-plane metadata and are not copied into instance data. All other
content is materialized into `runtime/instances/<instance-id>` before Docker mounts it at `/data`.
Changing a layer changes its checksum, but existing instances keep their materialized files.
Increment the final layer's `revision`, then restart the orchestrator to synchronize the change.

## Files commonly omitted from worlds

World layers should omit generated player state and locks:

```text
players/
level.dat_old
session.lock
```
