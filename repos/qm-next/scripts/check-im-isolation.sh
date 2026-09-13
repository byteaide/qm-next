#!/usr/bin/env bash
# M4 21.1 gate: core service code carries zero IM-platform symbols.
# Scanned: each core package's src/ only — provider adapters (im-feishu,
# im-slack), the scratch spike package and vendor sources are the only
# places platform names may appear, and tests legitimately name platforms
# in fixtures (surface keys like "feishu" there are contract values, not
# coupling). Web-ui app/ is the byte-level SPA port; its src is covered.

set -euo pipefail
cd "$(dirname "$0")/.."

CORE_SOURCES=(
  packages/api/src
  packages/approvals/src
  packages/boot/src
  packages/demo/src
  packages/directory/src
  packages/im-bridge/src
  packages/im-core/src
  packages/memory/src
  packages/orchestrator/src
  packages/reach/src
  packages/skills/src
  packages/store/src
  packages/triggers/src
  packages/types/src
  packages/web-ui/src
)

pattern='[Ss]lack|[Ff]eishu|[Ll]ark|[Ww]e[Cc]om|[Dd]ing[Tt]alk'

violations=$(grep -rnE "$pattern" "${CORE_SOURCES[@]}" 2>/dev/null || true)

if [[ -n "$violations" ]]; then
  printf '%s\n' "$violations"
  printf 'check-im-isolation: IM platform symbols found in core packages (see above)\n' >&2
  exit 1
fi

printf 'check-im-isolation OK: core packages are free of IM platform symbols\n'
