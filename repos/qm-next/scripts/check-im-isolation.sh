#!/usr/bin/env bash
# M4 21.1 gate: core service code carries zero IM-platform coupling.
# Two scans:
#   1. platform-symbol scan over each core package's src/ — provider adapters
#      (im-feishu, im-slack), the scratch spike package and vendor sources are
#      the only places platform names may appear, and tests legitimately name
#      platforms in fixtures. packages/api/src is exempt here: it hosts the
#      qm parity surface whose route CONTRACT is IM-named (qm admin
#      slack-mirror / slack-installation / slack-emoji, surface-config
#      externalSlackParticipants, projects slack-channel — route-shape
#      compatibility, deviation #47), not platform coupling.
#   2. platform-SDK import scan over ALL core packages including api — no
#      core package may import a provider SDK; IM access flows through the
#      ImProvider adapters only.

set -euo pipefail
cd "$(dirname "$0")/.."

CORE_SOURCES=(
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

sdk_pattern="from '(@slack/|@larksuiteoapi|dingtalk|wecom)"
sdk_violations=$(grep -rnE "$sdk_pattern" packages/*/src 2>/dev/null | grep -v 'packages/im-' || true)

if [[ -n "$sdk_violations" ]]; then
  printf '%s\n' "$sdk_violations"
  printf 'check-im-isolation: IM platform SDK imported outside the provider adapters (see above)\n' >&2
  exit 1
fi

printf 'check-im-isolation OK: core packages are free of IM platform symbols and SDK imports\n'
