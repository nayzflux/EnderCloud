#!/bin/sh
set -eu
umask 077
for password in "$REDIS_PUBLISHER_PASSWORD" "$REDIS_PROXY_PASSWORD"; do
  case "$password" in ''|*[!A-Za-z0-9_-]*) echo 'Redis passwords must be URL-safe random strings' >&2; exit 1;; esac
  [ "${#password}" -ge 32 ] || { echo 'Redis passwords must contain at least 32 characters' >&2; exit 1; }
done
{
  printf 'user default off\n'
  printf 'user orchestrator on >%s resetkeys resetchannels &minecraft:proxy:registry &minecraft:proxy:transfers -@all +ping +hello +info +client|setinfo +client|setname +publish\n' "$REDIS_PUBLISHER_PASSWORD"
  printf 'user proxy on >%s resetkeys resetchannels &minecraft:proxy:registry &minecraft:proxy:transfers -@all +ping +hello +info +client|setinfo +client|setname +subscribe +unsubscribe\n' "$REDIS_PROXY_PASSWORD"
} > /tmp/endercloud-users.acl
exec redis-server --save '' --appendonly no --aclfile /tmp/endercloud-users.acl
