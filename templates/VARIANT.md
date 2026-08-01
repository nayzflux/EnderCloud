# Layered server variants

Every immediate child containing `variant.yml` is a reusable template layer. A layer becomes a
final, instantiable variant only when a group references its id. Groups own `enabled` and `weight`;
descriptors no longer contain `group`, `enabled` or `weight`.

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

`variant.yml` files are control-plane metadata and are not copied into instance data. All other
content is materialized into `runtime/instances/<instance-id>` before Docker mounts it at `/data`.

## World

World layers may omit generated player state and locks:

```text
players/
level.dat_old
session.lock
```
