#!/usr/bin/env bash
# One-off postgres:16 container for the whole-repo PG parity run (17.0).
# Boots an ephemeral server, points QM_NEXT_PG_URL at it, runs the test suite
# with file concurrency 1 (packages reset shared schema tables per file),
# and always tears the container down. Requires docker.
#
# Usage:
#   pnpm test:pg              # ephemeral container, full suite
#   KEEP=1 pnpm test:pg       # keep the container running for debugging
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="postgres:16-alpine"
USER_="qm"
PASSWORD="qm"
DB="qm"
NAME="qm-next-pg-$(date +%s)-$$"
READY_TIMEOUT_SECONDS=30

log() { echo "run-pg: $*"; }
die() { echo "run-pg: ERROR: $*" >&2; exit 1; }

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    log "KEEP=1: container '$NAME' left running — stop it with: docker rm -f $NAME"
    return 0
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

command -v docker >/dev/null 2>&1 || die "docker CLI not found; install Docker Desktop or a compatible engine"
docker info >/dev/null 2>&1 || die "docker daemon unreachable; start Docker and retry"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "pulling $IMAGE"
  docker pull "$IMAGE" >/dev/null
fi

trap cleanup EXIT INT TERM

log "starting ephemeral container '$NAME' ($IMAGE)"
docker run --rm -d -P --name "$NAME" \
  -e "POSTGRES_USER=$USER_" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=$DB" \
  "$IMAGE" >/dev/null

# pg_isready can succeed against the initdb throwaway server before the real
# postmaster restarts (first-boot init restarts once). A suite file that probes
# during that window sees connection refused and silently skips its PG cases.
# Require a real query to succeed twice, a second apart, before handing the
# URL to the suite.
wait_settled() {
  local waited=0 hits=0
  while [ "$waited" -lt "$READY_TIMEOUT_SECONDS" ]; do
    if docker exec "$NAME" psql -U "$USER_" -d "$DB" -c 'SELECT 1' >/dev/null 2>&1; then
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

export QM_NEXT_PG_URL="postgres://${USER_}:${PASSWORD}@127.0.0.1:${port}/${DB}"
log "postgres ready at $QM_NEXT_PG_URL"

[ -d node_modules ] || { log "installing workspace deps"; pnpm install --frozen-lockfile; }
[ -d vendor/cordis/lib ] || { log "building vendored packages"; pnpm build; }

log "running full test suite against PG16 (file concurrency 1)"
pnpm test -- --test-concurrency=1
