#!/usr/bin/env bash
# qm-soul gate (M-Soul-5.1, ADR-0018): the dev placeholder prompt is banned.
# The soul layer composes real protocol frames for every turn; the one-line
# dev placeholder ("You are qm" + "-next.") must never re-enter the repo
# (source, tests, configs). Generated golden fixtures are excluded — they
# are qm baselines, not qm-next source.
set -euo pipefail
cd "$(dirname "$0")/.."

placeholder='You are qm'"-next."
hits=$(grep -rnF "$placeholder" . \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.json' --include='*.md' --include='*.yml' --include='*.yaml' --include='*.sh' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=lib --exclude-dir=.codebase-memory \
  --exclude-dir=golden \
  2>/dev/null || true)

if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits"
  printf 'check:soul: dev placeholder prompt found — the soul layer composes real protocol frames (ADR-0018)\n' >&2
  exit 1
fi

printf 'check-soul OK: zero dev placeholder prompts (ADR-0018)\n'
