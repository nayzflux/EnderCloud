#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEPLOYMENT_DIRECTORY="$SCRIPT_DIRECTORY/deployment"
readonly GIBIBYTE=$((1024 * 1024 * 1024))

docker_command=(docker)
role=""
master_address=""
master_port=""
dashboard_port=""
database_name=""
database_user=""
agent_id=""
agent_bind_address=""
agent_port=""
agent_control_url=""
agent_game_address=""
orchestrator_url=""
agent_cpu=""
agent_memory_bytes=""
agent_game_port_start=""
agent_game_port_end=""
agent_runtime_directory=""

if [[ -t 1 && -t 2 && -z "${NO_COLOR:-}" ]]; then
  color_reset=$'\033[0m'
  color_primary=$'\033[38;5;129m'
  color_secondary=$'\033[38;5;141m'
  color_success=$'\033[38;5;78m'
  color_error=$'\033[38;5;203m'
  color_muted=$'\033[38;5;245m'
else
  color_reset=""
  color_primary=""
  color_secondary=""
  color_success=""
  color_error=""
  color_muted=""
fi

error() {
  printf '%s[x]%s %s\n' "$color_error" "$color_reset" "$*" >&2
  exit 1
}

info() {
  printf '%s%s%s\n' "$color_muted" "$*" "$color_reset"
}

success() {
  printf '%s[ok]%s %s\n' "$color_success" "$color_reset" "$*"
}

section() {
  printf '\n%s%s%s\n' "$color_primary" "$1" "$color_reset"
  printf '%s────────────────────────────────────────────────────────%s\n' "$color_secondary" "$color_reset"
}

print_banner() {
  printf '%s' "$color_primary"
  cat <<'EOF'
  _____           _            ____ _                 _
 | ____|_ __   __| | ___ _ __ / ___| | ___  _   _  __| |
 |  _| | '_ \ / _` |/ _ \ '__| |   | |/ _ \| | | |/ _` |
 | |___| | | | (_| |  __/ |  | |___| | (_) | |_| | (_| |
 |_____|_| |_|\__,_|\___|_|   \____|_|\___/ \__,_|\__,_|
EOF
  printf '%s%sInstalleur Linux%s\n' "$color_secondary" "$color_muted" "$color_reset"
}
ask() {
  local label="$1"
  local default_value="${2:-}"
  local value

  if [[ -n "$default_value" ]]; then
    read -r -p "${color_secondary}${label}${color_muted} [${default_value}]${color_reset}: " value
    printf '%s' "${value:-$default_value}"
    return
  fi

  read -r -p "${color_secondary}${label}${color_reset}: " value
  printf '%s' "$value"
}

ask_yes_no() {
  local label="$1"
  local answer

  while true; do
    read -r -p "${color_secondary}${label}${color_muted} [o/N]${color_reset}: " answer
    case "${answer,,}" in
      o|oui|y|yes) return 0 ;;
      ''|n|non|no) return 1 ;;
      *) info "Répondez par o ou n." ;;
    esac
  done
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_port() {
  is_positive_integer "$1" && (( $1 <= 65535 ))
}

is_ipv4() {
  local address="$1"
  local -a octets
  local octet

  IFS='.' read -r -a octets <<< "$address"
  [[ ${#octets[@]} -eq 4 ]] || return 1

  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

is_agent_id() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$ ]]
}

is_database_identifier() {
  [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]
}

is_url() {
  local authority
  local port

  [[ "$1" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$ ]] || return 1
  authority="${1#*://}"
  authority="${authority%%/*}"
  if [[ "$authority" == *:* ]]; then
    port="${authority##*:}"
    is_port "$port"
  fi
}

is_game_address() {
  [[ "$1" =~ ^[a-zA-Z0-9.-]+$ ]]
}

ask_ipv4() {
  local label="$1"
  local default_value="${2:-}"
  local value

  while true; do
    value="$(ask "$label" "$default_value")"
    if is_ipv4 "$value"; then
      printf '%s' "$value"
      return
    fi
    info "Saisissez une adresse IPv4 valide."
  done
}

ask_port() {
  local label="$1"
  local default_value="$2"
  local value

  while true; do
    value="$(ask "$label" "$default_value")"
    if is_port "$value"; then
      printf '%s' "$value"
      return
    fi
    info "Saisissez un port entre 1 et 65535."
  done
}

ask_non_empty() {
  local label="$1"
  local default_value="${2:-}"
  local value

  while true; do
    value="$(ask "$label" "$default_value")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
    info "Cette valeur est obligatoire."
  done
}

random_password() {
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

configure_docker_command() {
  if ! command -v docker >/dev/null 2>&1; then
    error "Docker est requis. Installez Docker Engine : https://docs.docker.com/engine/install/"
  fi

  if docker info >/dev/null 2>&1; then
    docker_command=(docker)
  elif sudo docker info >/dev/null 2>&1; then
    docker_command=(sudo docker)
    info "Docker requiert sudo dans cette session."
  else
    error "Le service Docker n'est pas accessible. Démarrez-le puis relancez ce script."
  fi

  if ! "${docker_command[@]}" compose version >/dev/null 2>&1; then
    error "Le plugin Docker Compose est requis. Installez-le : https://docs.docker.com/compose/install/linux/"
  fi
}

choose_role() {
  local choice

  section "Type d'installation"
  info "Sélectionnez les services à préparer sur cette machine."
  PS3="${color_secondary}Votre choix${color_reset}: "

  select choice in \
    "Master  | PostgreSQL, Redis, orchestrateur et dashboard" \
    "Worker  | Agent d'exécution" \
    "Les deux| Master et worker local" \
    "Quitter"; do
    case "$REPLY" in
      1) role="master"; return ;;
      2) role="worker"; return ;;
      3) role="both"; return ;;
      4) error "Installation annulée." ;;
      *) info "Choisissez un numéro entre 1 et 4." ;;
    esac
  done
}

prompt_master() {
  local default_master_address="127.0.0.1"

  if [[ "$role" == "both" ]]; then
    default_master_address=""
  fi

  section "Configuration du master"
  master_address="$(ask_ipv4 "Adresse IPv4 privée de l'orchestrateur" "$default_master_address")"
  master_port="$(ask_port "Port publié de l'orchestrateur" "8080")"
  dashboard_port="$(ask_port "Port publié du dashboard" "3000")"

  while true; do
    database_name="$(ask_non_empty "Nom de la base PostgreSQL" "endercloud")"
    is_database_identifier "$database_name" && break
    info "Utilisez des lettres, chiffres et underscores."
  done

  while true; do
    database_user="$(ask_non_empty "Utilisateur PostgreSQL" "endercloud")"
    is_database_identifier "$database_user" && break
    info "Utilisez des lettres, chiffres et underscores."
  done
}

default_agent_id() {
  local candidate
  candidate="$(hostname -s 2>/dev/null | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
  if is_agent_id "$candidate"; then
    printf '%s' "$candidate"
  else
    printf 'worker-host'
  fi
}

prompt_worker() {
  local memory_gib
  local default_orchestrator_url

  section "Configuration du worker"
  while true; do
    agent_id="$(ask_non_empty "Identifiant stable de l'agent" "$(default_agent_id)")"
    is_agent_id "$agent_id" && break
    info "L'identifiant doit contenir 2 à 63 lettres minuscules, chiffres ou tirets."
  done

  agent_bind_address="$(ask_ipv4 "Adresse IPv4 privée du worker" "127.0.0.1")"
  agent_port="$(ask_port "Port publié de l'agent" "8090")"

  agent_control_url="$(ask_non_empty "URL de contrôle annoncée" "http://$agent_bind_address:$agent_port")"
  is_url "$agent_control_url" || error "L'URL de contrôle doit commencer par http:// ou https://."

  agent_game_address="$(ask_non_empty "Adresse annoncée aux joueurs" "$agent_bind_address")"
  is_game_address "$agent_game_address" || error "L'adresse de jeu contient des caractères non pris en charge."

  if [[ "$role" == "both" ]]; then
    default_orchestrator_url="http://$master_address:$master_port"
  else
    default_orchestrator_url=""
  fi
  orchestrator_url="$(ask_non_empty "URL privée de l'orchestrateur" "$default_orchestrator_url")"
  is_url "$orchestrator_url" || error "L'URL de l'orchestrateur doit commencer par http:// ou https://."

  while true; do
    agent_cpu="$(ask_non_empty "vCPU alloués à EnderCloud" "4")"
    is_positive_integer "$agent_cpu" && break
    info "Saisissez un nombre entier positif."
  done

  while true; do
    memory_gib="$(ask_non_empty "Mémoire allouée à EnderCloud en Gio" "8")"
    is_positive_integer "$memory_gib" && break
    info "Saisissez un nombre entier positif."
  done
  agent_memory_bytes=$((memory_gib * GIBIBYTE))

  agent_game_port_start="$(ask_port "Premier port Minecraft" "25565")"
  agent_game_port_end="$(ask_port "Dernier port Minecraft" "25664")"
  (( agent_game_port_end >= agent_game_port_start )) || error "Le dernier port Minecraft doit être supérieur ou égal au premier."

  agent_runtime_directory="$(ask_non_empty "Répertoire absolu du runtime" "$DEPLOYMENT_DIRECTORY/worker-runtime")"
  [[ "$agent_runtime_directory" == /* ]] || error "Le répertoire du runtime doit être absolu."
}

write_master_compose() {
  cat > "$DEPLOYMENT_DIRECTORY/compose.master.yml" <<'EOF'
name: endercloud-master

x-service-defaults: &service-defaults
  restart: unless-stopped
  init: true
  stop_grace_period: 20s
  networks:
    - endercloud

services:
  postgres:
    <<: *service-defaults
    image: postgres:18.1-alpine
    environment:
      POSTGRES_DB: ${POSTGRES_DB:?Set POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER:?Set POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    <<: *service-defaults
    image: redis:8.4.0-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

  orchestrator:
    <<: *service-defaults
    build:
      context: ../orchestrator
    environment:
      DATABASE_URL: ${DATABASE_URL:?Set DATABASE_URL}
      REDIS_URL: redis://redis:6379
      ORCHESTRATOR_LISTEN_PORT: 8080
      ORCHESTRATOR_GROUPS_DIRECTORY: /data/groups
      ORCHESTRATOR_TEMPLATES_DIRECTORY: /data/templates
    volumes:
      - ../groups:/data/groups:ro
      - ../templates:/data/templates:ro
    ports:
      - "${ORCHESTRATOR_PUBLISH_ADDRESS}:${ORCHESTRATOR_PUBLISH_PORT}:8080"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "bun", "-e", "const r=await fetch('http://localhost:8080/health/ready');process.exit(r.ok?0:1)"]
      interval: 10s
      timeout: 3s
      retries: 12

  dashboard:
    <<: *service-defaults
    build:
      context: ../dashboard
    environment:
      ORCHESTRATOR_URL: http://orchestrator:8080
      DASHBOARD_MOCK_DATA: "false"
    ports:
      - "127.0.0.1:${DASHBOARD_PUBLISH_PORT}:3000"
    depends_on:
      orchestrator:
        condition: service_healthy

volumes:
  postgres-data:

networks:
  endercloud:
    name: endercloud
EOF
}

write_worker_compose() {
  cat > "$DEPLOYMENT_DIRECTORY/compose.worker.yml" <<'EOF'
name: endercloud-worker

services:
  agent:
    build:
      context: ../orchestrator
    command: ["bun", "src/agent/index.ts"]
    restart: unless-stopped
    init: true
    stop_grace_period: 20s
    environment:
      AGENT_ID: ${AGENT_ID:?Set AGENT_ID}
      AGENT_VERSION: ${AGENT_VERSION:-0.1.0}
      AGENT_LISTEN_PORT: 8090
      AGENT_ADVERTISED_CONTROL_URL: ${AGENT_ADVERTISED_CONTROL_URL:?Set AGENT_ADVERTISED_CONTROL_URL}
      AGENT_ADVERTISED_GAME_ADDRESS: ${AGENT_ADVERTISED_GAME_ADDRESS:?Set AGENT_ADVERTISED_GAME_ADDRESS}
      AGENT_ALLOCATABLE_CPU: ${AGENT_ALLOCATABLE_CPU:?Set AGENT_ALLOCATABLE_CPU}
      AGENT_ALLOCATABLE_MEMORY_BYTES: ${AGENT_ALLOCATABLE_MEMORY_BYTES:?Set AGENT_ALLOCATABLE_MEMORY_BYTES}
      AGENT_GAME_PORT_START: ${AGENT_GAME_PORT_START:?Set AGENT_GAME_PORT_START}
      AGENT_GAME_PORT_END: ${AGENT_GAME_PORT_END:?Set AGENT_GAME_PORT_END}
      ORCHESTRATOR_URL: ${ORCHESTRATOR_URL:?Set ORCHESTRATOR_URL}
      AGENT_DOCKER_SOCKET: /var/run/docker.sock
      AGENT_DOCKER_NETWORK: ${AGENT_DOCKER_NETWORK:-endercloud}
      AGENT_RUNTIME_DIRECTORY: /data/runtime
      AGENT_RUNTIME_HOST_DIRECTORY: ${AGENT_RUNTIME_HOST_DIRECTORY:?Set AGENT_RUNTIME_HOST_DIRECTORY}
      AGENT_TEMPLATE_CACHE_DIRECTORY: /data/template-cache
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${AGENT_RUNTIME_LOCAL_DIRECTORY:?Set AGENT_RUNTIME_LOCAL_DIRECTORY}:/data/runtime
      - agent-template-cache:/data/template-cache
    ports:
      - "${AGENT_PUBLISH_ADDRESS}:${AGENT_PUBLISH_PORT}:8090"
    healthcheck:
      test: ["CMD", "bun", "-e", "const r=await fetch('http://localhost:8090/health/ready');process.exit(r.ok?0:1)"]
      interval: 10s
      timeout: 3s
      retries: 12
    networks:
      - endercloud

volumes:
  agent-template-cache:

networks:
  endercloud:
    name: ${AGENT_DOCKER_NETWORK:-endercloud}
EOF
}

write_master_environment() {
  local password
  password="$(random_password)"

  {
    printf 'POSTGRES_DB=%s\n' "$database_name"
    printf 'POSTGRES_USER=%s\n' "$database_user"
    printf 'POSTGRES_PASSWORD=%s\n' "$password"
    printf 'DATABASE_URL=postgres://%s:%s@postgres:5432/%s\n' "$database_user" "$password" "$database_name"
    printf 'ORCHESTRATOR_PUBLISH_ADDRESS=%s\n' "$master_address"
    printf 'ORCHESTRATOR_PUBLISH_PORT=%s\n' "$master_port"
    printf 'DASHBOARD_PUBLISH_PORT=%s\n' "$dashboard_port"
  } > "$DEPLOYMENT_DIRECTORY/master.env"
}

write_worker_environment() {
  {
    printf 'AGENT_ID=%s\n' "$agent_id"
    printf 'AGENT_ADVERTISED_CONTROL_URL=%s\n' "$agent_control_url"
    printf 'AGENT_ADVERTISED_GAME_ADDRESS=%s\n' "$agent_game_address"
    printf 'AGENT_ALLOCATABLE_CPU=%s\n' "$agent_cpu"
    printf 'AGENT_ALLOCATABLE_MEMORY_BYTES=%s\n' "$agent_memory_bytes"
    printf 'AGENT_GAME_PORT_START=%s\n' "$agent_game_port_start"
    printf 'AGENT_GAME_PORT_END=%s\n' "$agent_game_port_end"
    printf 'ORCHESTRATOR_URL=%s\n' "$orchestrator_url"
    printf 'AGENT_RUNTIME_LOCAL_DIRECTORY=%s\n' "$agent_runtime_directory"
    printf 'AGENT_RUNTIME_HOST_DIRECTORY=%s\n' "$agent_runtime_directory"
    printf 'AGENT_PUBLISH_ADDRESS=%s\n' "$agent_bind_address"
    printf 'AGENT_PUBLISH_PORT=%s\n' "$agent_port"
    printf 'AGENT_DOCKER_NETWORK=endercloud\n'
  } > "$DEPLOYMENT_DIRECTORY/worker.env"
}

validate_compose() {
  if [[ "$role" == "master" || "$role" == "both" ]]; then
    "${docker_command[@]}" compose --env-file "$DEPLOYMENT_DIRECTORY/master.env" -f "$DEPLOYMENT_DIRECTORY/compose.master.yml" config --quiet
  fi

  if [[ "$role" == "worker" || "$role" == "both" ]]; then
    "${docker_command[@]}" compose --env-file "$DEPLOYMENT_DIRECTORY/worker.env" -f "$DEPLOYMENT_DIRECTORY/compose.worker.yml" config --quiet
  fi
}

start_services() {
  if [[ "$role" == "master" || "$role" == "both" ]]; then
    "${docker_command[@]}" compose --env-file "$DEPLOYMENT_DIRECTORY/master.env" -f "$DEPLOYMENT_DIRECTORY/compose.master.yml" up --build -d
  fi

  if [[ "$role" == "worker" || "$role" == "both" ]]; then
    "${docker_command[@]}" compose --env-file "$DEPLOYMENT_DIRECTORY/worker.env" -f "$DEPLOYMENT_DIRECTORY/compose.worker.yml" up --build -d
  fi
}

main() {
  [[ "$(uname -s)" == "Linux" ]] || error "Cet installateur cible Linux."
  [[ -f "$SCRIPT_DIRECTORY/compose.yml" && -d "$SCRIPT_DIRECTORY/orchestrator" && -d "$SCRIPT_DIRECTORY/dashboard" ]] || error "Exécutez ce script depuis un clone EnderCloud complet."
  [[ ! -e "$DEPLOYMENT_DIRECTORY" ]] || error "Le répertoire $DEPLOYMENT_DIRECTORY existe déjà. Aucun fichier n'a été modifié."

  print_banner
  configure_docker_command
  choose_role

  if [[ "$role" == "master" || "$role" == "both" ]]; then
    prompt_master
  fi
  if [[ "$role" == "worker" || "$role" == "both" ]]; then
    prompt_worker
  fi

  umask 077
  mkdir -p "$DEPLOYMENT_DIRECTORY"
  if [[ "$role" == "master" || "$role" == "both" ]]; then
    write_master_compose
    write_master_environment
  fi
  if [[ "$role" == "worker" || "$role" == "both" ]]; then
    mkdir -p "$agent_runtime_directory"
    write_worker_compose
    write_worker_environment
  fi

  validate_compose

  section "Configuration créée"
  success "Fichiers écrits dans $DEPLOYMENT_DIRECTORY"
  if [[ "$role" == "master" || "$role" == "both" ]]; then
    info "Orchestrateur : http://$master_address:$master_port"
    info "Dashboard : http://127.0.0.1:$dashboard_port"
  fi
  if [[ "$role" == "worker" || "$role" == "both" ]]; then
    info "Agent : $agent_control_url"
    info "Ports Minecraft : $agent_game_port_start-$agent_game_port_end"
  fi

  if ask_yes_no "Démarrer les services maintenant ?"; then
    start_services
    success "Les services ont été démarrés."
  else
    info "La configuration est prête. Relancez ce script dans un nouveau terminal si Docker vient d'être installé."
  fi
}

main "$@"
