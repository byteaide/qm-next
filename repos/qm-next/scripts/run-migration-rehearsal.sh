#!/usr/bin/env bash
# qm → qm-next migration rehearsal (p002 P5 19.3): ephemeral postgres:16
# container with two databases — `qm` (source, seeded qm-shaped data) and
# `qmnext` (target, schema ensured by the rehearsal driver) — then drives
# scripts/migration-rehearsal.ts through dry-run → commit → verify → rollback.
# Requires docker.
#
# Usage:
#   bash scripts/run-migration-rehearsal.sh
#   KEEP=1 bash scripts/run-migration-rehearsal.sh   # keep container for debugging
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="postgres:16-alpine"
USER_="qm"
PASSWORD="rehearsal-not-a-secret"
NAME="qm-migrate-pg-$(date +%s)-$$"
READY_TIMEOUT_SECONDS=30

log() { echo "run-migration-rehearsal: $*"; }
die() { echo "run-migration-rehearsal: ERROR: $*" >&2; exit 1; }

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
  -e "POSTGRES_USER=$USER_" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=qm" \
  "$IMAGE" >/dev/null

wait_settled() {
  local waited=0 hits=0
  while [ "$waited" -lt "$READY_TIMEOUT_SECONDS" ]; do
    if docker exec "$NAME" pg_isready -U "$USER_" -d qm >/dev/null 2>&1; then
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

docker exec "$NAME" psql -U "$USER_" -d qm -c 'CREATE DATABASE qmnext' >/dev/null

export QM_MIGRATE_SOURCE_URL="postgres://${USER_}:${PASSWORD}@127.0.0.1:${port}/qm"
export QM_MIGRATE_TARGET_URL="postgres://${USER_}:${PASSWORD}@127.0.0.1:${port}/qmnext"
log "source: $QM_MIGRATE_SOURCE_URL"
log "target: $QM_MIGRATE_TARGET_URL"

node --import tsx/esm scripts/migration-rehearsal.ts
