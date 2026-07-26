# Server variants

Each immediate child directory containing a `variant.yml` is synchronized as one immutable
server variant. The directory is copied in full to `runtime/instances/<instance-id>` before
Docker mounts it at `/data`.

Example descriptor:

```yaml
id: skywars-solo-japan
group: skywars-solo
enabled: true
revision: 1
weight: 100

docker:
  image: itzg/minecraft-server:java25
  memory: 4G
  cpu: 2

environment:
  EULA: "TRUE"
  TYPE: PAPER
  VERSION: "26.2"
  ONLINE_MODE: "FALSE"
  MAP_ID: "japan"
```

The directory must also contain the complete world, server configuration and the shaded
`EnderCloud` Paper JAR in `plugins/`. Symlinks and the Docker tag `latest` are rejected.

## World

When copying world directory into the templates, you can delete the following unnecessary files:

```
players/
level.dat_old
session.lock
```
