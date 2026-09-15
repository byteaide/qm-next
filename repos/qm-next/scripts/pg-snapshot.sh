#!/usr/bin/env bash
# Production PG snapshot (p002 P5 20.3, operations.md §6): pg_dump custom
# format plus a tar of the file-bytes directory — the two halves of a
# consistent restore point (metadata lives in PG, bytes under filesDir).
#
# Usage:
#   bash scripts/pg-snapshot.sh --database-url $URL --output-dir /backups [--files-dir ./data/files]
#   QM_NEXT_PG_URL=... bash scripts/pg-snapshot.sh --output-dir /backups
#
# Exit non-zero on any failure; prints the snapshot paths on success.
set -euo pipefail

DATABASE_URL="${QM_NEXT_PG_URL:-}"
FILES_DIR=""
OUTPUT_DIR=""
STAMP="$(date +%Y%m%d-%H%M%S)"

usage() {
  echo "usage: pg-snapshot.sh --database-url <url> --output-dir <dir> [--files-dir <dir>]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --files-dir) FILES_DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$DATABASE_URL" ] || usage
[ -n "$OUTPUT_DIR" ] || usage
command -v pg_dump >/dev/null 2>&1 || { echo "pg-snapshot: pg_dump not found in PATH" >&2; exit 1; }

mkdir -p "$OUTPUT_DIR"

SNAPSHOT="$OUTPUT_DIR/qm-next-$STAMP.dump"
pg_dump "$DATABASE_URL" --format=custom --file="$SNAPSHOT"
echo "pg-snapshot: database snapshot: $SNAPSHOT ($(wc -c < "$SNAPSHOT" | tr -d ' ') bytes)"

if [ -n "$FILES_DIR" ] && [ -d "$FILES_DIR/files" ]; then
  BYTES="$OUTPUT_DIR/qm-next-files-$STAMP.tar"
  tar -C "$FILES_DIR" -cf "$BYTES" files
  echo "pg-snapshot: file bytes archive: $BYTES ($(wc -c < "$BYTES" | tr -d ' ') bytes)"
elif [ -n "$FILES_DIR" ]; then
  echo "pg-snapshot: --files-dir given but $FILES_DIR/files does not exist yet; skipping bytes archive"
fi

echo "pg-snapshot: done (restore with pg_restore --clean --if-exists --no-owner)"
