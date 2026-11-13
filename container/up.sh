#!/usr/bin/env bash
# Container helper for the pi-agent RSI extension.
#
#   ./container/up.sh build     build the pi-agent image
#   ./container/up.sh run       start the container (detached)
#   ./container/up.sh shell     interactive shell inside the container
#   ./container/up.sh exec ...  run one command inside the container
#   ./container/up.sh pi ...    run pi inside the container
#   ./container/up.sh creds     copy the host's opencode-go key into container/.env
#   ./container/up.sh auth      copy the host's full ~/.pi/agent/auth.json into the container
#   ./container/up.sh down      stop and remove the container
#
# Kiri's Docker endpoint needs a Docker config without a credential helper;
# the repo-local container/.docker/config.json supplies one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/container/compose.yaml"
BASE_MIRROR_IMAGE="docker.m.daocloud.io/library/node:24-bookworm-slim"
BASE_LOCAL_IMAGE="node:24-bookworm-slim"

export DOCKER_CONFIG="${DOCKER_CONFIG:-$ROOT/container/.docker}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.kiri/run/docker.sock}"
DOCKER=(docker)
COMPOSE=("${DOCKER[@]}" compose -f "$COMPOSE_FILE" --env-file "$ROOT/container/.env")

ensure_base() {
  if ! "${DOCKER[@]}" image inspect "$BASE_LOCAL_IMAGE" >/dev/null 2>&1; then
    echo "==> pulling $BASE_MIRROR_IMAGE"
    "${DOCKER[@]}" pull "$BASE_MIRROR_IMAGE"
    "${DOCKER[@]}" tag "$BASE_MIRROR_IMAGE" "$BASE_LOCAL_IMAGE"
  fi
}

ensure_ssh() {
  if [[ ! -f "$ROOT/container/ssh/config" ]]; then
    "$ROOT/container/sync-ssh.sh" >/dev/null
  fi
}

bootstrap_container() {
  "${COMPOSE[@]}" exec -e "RSI_SUPERAGENT_POLICY=${RSI_SUPERAGENT_POLICY:-yolo}" \
    pi-agent /workspace/RSI/container/bootstrap.sh >/dev/null 2>&1 || true
}

ensure_env() {
  if [[ ! -f "$ROOT/container/.env" ]]; then
    echo "error: container/.env is missing." >&2
    echo "Create it from the host credential:" >&2
    echo "  ./container/up.sh creds    # copies ~/.pi/agent/auth.json opencode-go key" >&2
    echo "  or create container/.env from container/.env.example" >&2
    exit 1
  fi
}

cmd="${1:-run}"
shift || true

case "$cmd" in
  build)
    ensure_base
    "${COMPOSE[@]}" build \
      --build-arg "APT_PROXY=${APT_PROXY:-http://host.docker.internal:7890}" \
      --build-arg "NPM_PROXY=${NPM_PROXY:-http://host.docker.internal:7890}" \
      "$@"
    ;;
  run|up)
    ensure_base
    ensure_env
    ensure_ssh
    "${COMPOSE[@]}" up -d "$@"
    ;;
  shell)
    ensure_env
    ensure_ssh
    bootstrap_container
    exec "${COMPOSE[@]}" exec -e "RSI_SUPERAGENT_POLICY=${RSI_SUPERAGENT_POLICY:-yolo}" pi-agent bash
    ;;
  exec)
    ensure_env
    ensure_ssh
    bootstrap_container
    exec "${COMPOSE[@]}" exec -e "RSI_SUPERAGENT_POLICY=${RSI_SUPERAGENT_POLICY:-yolo}" pi-agent "$@"
    ;;
  pi)
    ensure_env
    ensure_ssh
    bootstrap_container
    exec "${COMPOSE[@]}" exec -e "RSI_SUPERAGENT_POLICY=${RSI_SUPERAGENT_POLICY:-yolo}" pi-agent pi "$@"
    ;;
  bootstrap)
    ensure_env
    ensure_ssh
    exec "${COMPOSE[@]}" exec pi-agent /workspace/RSI/container/bootstrap.sh
    ;;
  creds|credentials)
    exec "$ROOT/container/sync-credentials.sh" "$@"
    ;;
  auth)
    exec "$ROOT/container/sync-auth.sh" "$@"
    ;;
  ssh)
    exec "$ROOT/container/sync-ssh.sh" "$@"
    ;;
  logs)
    "${COMPOSE[@]}" logs "$@"
    ;;
  down)
    "${COMPOSE[@]}" down "$@"
    ;;
  *)
    echo "usage: $0 {build|run|shell|exec|pi|bootstrap|creds|auth|ssh|logs|down} ..." >&2
    exit 2
    ;;
esac
