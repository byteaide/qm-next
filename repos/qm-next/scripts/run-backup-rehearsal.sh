#!/usr/bin/env bash
# PG snapshot + restore rehearsal (p002 P5 20.3): ephemeral postgres:16
# container — seed rows, take a pg_dump custom-format snapshot, destroy
# data, restore into a fresh database, and assert row counts come back.
# Exercises the operations.md §6 restore order end-to-end. Requires docker.
#
# Usage:
#   pnpm rehearsal:backup
#   KEEP=1 pnpm rehearsal:backup   # keep container for debugging
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="postgres:16-alpine"
USER_="qm"
PASSWORD="[redacted-credential]"
NAME="qm-backup-pg-$(date +%s)-$$"
READY_TIMEOUT_SECONDS=30

log() { echo "rehearsal:backup: $*"; }
die() { echo "rehearsal:backup: ERROR: $*" >&2; exit 1; }

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    log "KEEP=1: container '$NAME' left running — stop it with: docker rm -f $NAME"
    return 0
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" 2>/dev/null || true
}

command -v docker >/dev/null 2>&1 || die "docker CLI not found"
docker info >/dev/null 2>&1 || die "docker daemon unreachable; start Docker and retry"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "pulling $IMAGE"
  docker pull "$IMAGE" >/dev/null
fi

trap cleanup EXIT INT TERM

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qm-backup-XXXXXX")"

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

wait_settled || die "postgres never became ready"

PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
HOST="127.0.0.1"
export PGPASSWORD="$PASSWORD"
PSQL="docker exec $NAME psql -U $USER_ -d qm -v ON_ERROR_STOP=1 -q"

log "seeding production-shaped rows"
$PSQL -c "CREATE TABLE operations_check(id TEXT PRIMARY KEY, payload TEXT NOT NULL)" \
       -c "INSERT INTO operations_check SELECT 'row-' || g, 'seed-' || g FROM generate_series(1, 100) g"

log "taking snapshot (pg_dump custom format)"
SNAPSHOT="$WORK_DIR/qm-snapshot.dump"
docker exec "$NAME" pg_dump -U "$USER_" -d qm --format=custom > "$SNAPSHOT"
SIZE=$(wc -c < "$SNAPSHOT" | tr -d ' ')
[ "$SIZE" -gt 1000 ] || die "snapshot suspiciously small ($SIZE bytes)"
log "snapshot written ($SIZE bytes)"

log "simulating data loss (truncate + drop)"
$PSQL -c "TRUNCATE operations_check" -c "DROP TABLE operations_check"
ROWS_AFTER_LOSS=$($PSQL -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_name = 'operations_check'")
[ "$ROWS_AFTER_LOSS" = "0" ] || die "loss simulation failed — table still present"

log "restoring snapshot into the same database"
docker exec -i "$NAME" pg_restore -U "$USER_" -d qm --clean --if-exists --no-owner < "$SNAPSHOT"

log "verifying restore"
ROWS=$($PSQL -t -A -c "SELECT count(*) FROM operations_check")
[ "$ROWS" = "100" ] || die "row count mismatch after restore: expected 100, got $ROWS"
SUM=$($PSQL -t -A -c "SELECT count(*) FROM operations_check WHERE payload = 'seed-' || substring(id from 5)")
[ "$SUM" = "100" ] || die "payload integrity mismatch after restore"

log "PASS: snapshot → loss → restore → verify (100/100 rows intact)"
