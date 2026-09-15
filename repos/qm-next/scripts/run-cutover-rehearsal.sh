#!/usr/bin/env bash
# Cutover rehearsal (p002 P5 21.0): ephemeral postgres:16 container with a
# single `qmnext` database, then drives scripts/rehearsal-cutover.ts
# through 灰度双跑 → blue-green handoff → worker-process split + crash
# takeover. Requires docker.
#
# Usage:
#   bash scripts/run-cutover-rehearsal.sh
#   KEEP=1 bash scripts/run-cutover-rehearsal.sh   # keep container for debugging
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="postgres:16-alpine"
USER_="qm"
PASSWORD="rehearsal-not-a-secret"
NAME="qm-cutover-pg-$(date +%s)-$$"
READY_TIMEOUT_SECONDS=30

log() { echo "run-cutover-rehearsal: $*"; }
die() { echo "run-cutover-rehearsal: ERROR: $*" >&2; exit 1; }

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    log "KEEP=1: container '$NAME' left running — stop it with: docker rm -f $NAME"
    return 0
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

command -v docker >/dev/null 2>&1 || die "docker CLI not found"
docker info >/dev/null 2>&1 || die "docker daemon unreachable; start Docker and retry"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "pulling $IMAGE"
  docker pull "$IMAGE" >/dev/null
fi

trap cleanup EXIT INT TERM

log "starting ephemeral container '$NAME' ($IMAGE)"
docker run --rm -d -P --name "$NAME" \
  -e "POSTGRES_USER=$USER_" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=qmnext" \
  "$IMAGE" >/dev/null

wait_settled() {
  local waited=0 hits=0
  while [ "$waited" -lt "$READY_TIMEOUT_SECONDS" ]; do
    if docker exec "$NAME" pg_isready -U "$USER_" -d qmnext >/dev/null 2>&1; then
      hits=$((hits + 1))
      if [ "$hits" -ge 2 ]; then
        return 0
      fi
    else
      hits=0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

if ! wait_settled; then
  docker logs "$NAME" 2>&1 | tail -20 || true
  die "postgres not settled within ${READY_TIMEOUT_SECONDS}s"
fi

port_line=$(docker port "$NAME" 5432/tcp | grep '^0.0.0.0:' || true)
[ -n "$port_line" ] || die "could not resolve published port for $NAME"
port=${port_line##*:}

export QM_CUTOVER_PG_URL="postgres://${USER_}:${PASSWORD}@127.0.0.1:${port}/qmnext"
log "target: $QM_CUTOVER_PG_URL"

node --import tsx/esm scripts/rehearsal-cutover.ts
