#!/usr/bin/env bash

set -Eeuo pipefail

readonly SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly TEMPORARY_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf -- "$TEMPORARY_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'Test en échec: %s\n' "$*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "fichier manquant: $1"
}

assert_not_file() {
  [[ ! -e "$1" ]] || fail "fichier inattendu: $1"
}

assert_contains() {
  grep -Fqx -- "$2" "$1" >/dev/null || fail "ligne manquante dans $1: $2"
}

create_fake_docker() {
  local destination="$1"
  mkdir -p "$destination"
  cat > "$destination/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

case "${1:-}" in
  info) exit 0 ;;
  compose) exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$destination/docker"
  cat > "$destination/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Linux\n'
EOF
  chmod +x "$destination/uname"
}

run_case() {
  local name="$1"
  local answers="$2"
  local directory="$TEMPORARY_ROOT/$name"
  local fake_bin="$TEMPORARY_ROOT/bin-$name"

  mkdir -p "$directory/orchestrator" "$directory/dashboard" "$directory/groups" "$directory/templates"
  cp "$SOURCE_ROOT/install.sh" "$SOURCE_ROOT/compose.yml" "$directory/"
  create_fake_docker "$fake_bin"
  PATH="$fake_bin:$PATH" /usr/bin/env bash "$directory/install.sh" <<< "$answers" >/dev/null 2>&1
  printf '%s' "$directory"
}

master_directory="$(run_case master $'1\n10.20.0.10\n8080\n3000\nendercloud\nendercloud\nn\n')"
assert_file "$master_directory/deployment/compose.master.yml"
assert_file "$master_directory/deployment/master.env"
assert_not_file "$master_directory/deployment/compose.worker.yml"
assert_contains "$master_directory/deployment/master.env" 'ORCHESTRATOR_PUBLISH_ADDRESS=10.20.0.10'
if [[ "$(uname -s)" == "Linux" ]]; then
  [[ "$(stat -c '%a' "$master_directory/deployment/master.env")" == "600" ]] || fail 'master.env doit être privé'
fi

worker_directory="$(run_case worker $'2\ngame-paris-02\n10.20.0.12\n8090\n\n10.20.0.12\nhttp://10.20.0.10:8080\n8\n16\n25565\n25664\n\nn\n')"
assert_file "$worker_directory/deployment/compose.worker.yml"
assert_file "$worker_directory/deployment/worker.env"
assert_not_file "$worker_directory/deployment/compose.master.yml"
assert_contains "$worker_directory/deployment/worker.env" 'AGENT_ALLOCATABLE_MEMORY_BYTES=17179869184'
assert_contains "$worker_directory/deployment/worker.env" 'ORCHESTRATOR_URL=http://10.20.0.10:8080'

both_directory="$(run_case both $'3\n10.20.0.10\n8080\n3000\nendercloud\nendercloud\nprimary-host\n10.20.0.10\n8090\n\n10.20.0.10\n\n4\n8\n25565\n25664\n\nn\n')"
assert_file "$both_directory/deployment/compose.master.yml"
assert_file "$both_directory/deployment/compose.worker.yml"
assert_contains "$both_directory/deployment/worker.env" 'ORCHESTRATOR_URL=http://10.20.0.10:8080'

if PATH="$TEMPORARY_ROOT/bin-master:$PATH" /usr/bin/env bash "$master_directory/install.sh" </dev/null >/dev/null 2>&1; then
  fail 'une installation existante doit être refusée'
fi

printf 'Les tests de l installateur sont passes.\n'
