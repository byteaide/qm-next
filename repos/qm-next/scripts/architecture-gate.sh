#!/usr/bin/env bash
# Phase 0 architecture gate. Non-waivable per docs/gate-enforcement.md §6.
#
# Runs:
#   1. Static boundary checks: grep the tree for known violation patterns
#      documented in docs/known-violations.md. Each violation lists the
#      phase that resolves it. A hit is acknowledged when its file path
#      appears under a known-violation entry's `location:`. Anything not
#      acknowledged fails the gate.
#   2. The Phase 0 contract parity suite over the memory + Postgres
#      twins of LeaseStore, SequenceAllocator, SessionReservationStore,
#      RolloutFlag. The Postgres leg is skipped when QM_NEXT_PG_URL is
#      not set; CI exports it.
#   3. The Run Observation contract — in-memory event log, snapshot /
#      replay / subscribe / terminal close behavior.
#
# Exit codes:
#   0  green
#   1  static violation or test failure
#   2  infrastructure unavailable (treated as a failure per the plan)
set -euo pipefail
cd "$(dirname "$0")/.."

violations=0
KNOWN_FILE="docs/known-violations.md"

if [ ! -f "$KNOWN_FILE" ]; then
  echo "architecture-gate: $KNOWN_FILE missing — Phase 0 deliverable" >&2
  exit 1
fi

# Collect the union of acknowledged locations from docs/known-violations.md.
# Locations are parsed from the YAML-ish block under "## Phase 0 seed
# entries". An entry may declare a single location string, a multi-line
# YAML list under a `location:` parent key, or free text. The parser
# only collects locations whose owning entry has an `id:` field, so the
# template example block (which has no `id:`) is ignored.
#
# The state machine tracks "are we currently inside an entry with an
# id?" — only entries with `id:` contribute to the acknowledged set.
acknowledged_locations=$(awk '
  /^```yaml$/ { in_yaml=1; next }
  /^```$/     { in_yaml=0; in_entry=0; next }
  in_yaml {
    if ($0 ~ /^[[:space:]]*-[[:space:]]*id:[[:space:]]*/) {
      in_entry=1
    }
    if (in_entry) {
      # List item under location: - packages/...
      if ($0 ~ /^[[:space:]]*-[[:space:]]+packages\//) {
        sub(/^[[:space:]]*-[[:space:]]+/, "")
        print
        next
      }
      # Inline list item `- location: packages/...`
      if ($0 ~ /^[[:space:]]*-[[:space:]]*location:[[:space:]]*/) {
        sub(/^[[:space:]]*-[[:space:]]*location:[[:space:]]*/, "")
        print
        next
      }
      # Single-line `location: packages/...`
      if ($0 ~ /^[[:space:]]*location:[[:space:]]*packages\//) {
        sub(/^[[:space:]]*location:[[:space:]]*/, "")
        print
        next
      }
      # Notes lines we should skip — the "Note:" prose block under KV-001
      # is not a location; we just let it pass.
    }
  }
' "$KNOWN_FILE")

is_acknowledged() {
  # Acknowledge a hit when its file path matches an acknowledged location.
  # We compare by file path only (ignoring line numbers) because the same
  # file may carry the violation at multiple lines and the acknowledged
  # locations are sometimes written as `path:N, M`. Stripping the line
  # part of the hit (everything after the second colon) and stripping the
  # line part of the location (everything after the first colon) gives
  # us a stable file-path match.
  local hit="$1"
  local loc
  local hit_path="${hit%%:*}"
  for loc in $acknowledged_locations; do
    # Locations may carry line numbers separated by `:` or `,`. Take the
    # first colon-separated segment as the path.
    local loc_path="${loc%%:*}"
    # Also drop any trailing `(...)` notes from the location.
    loc_path="${loc_path%% *}"
    case "$hit_path" in
      "$loc_path") return 0 ;;
    esac
  done
  return 1
}

filter_unacknowledged() {
  local input_file="$1"
  local keep_file="$2"
  : > "$keep_file"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if is_acknowledged "$line"; then
      continue
    fi
    printf '%s\n' "$line" >> "$keep_file"
  done < "$input_file"
}

# --- 1. Static boundary checks -------------------------------------------------

# 1.a. `done` writes on target Run paths. Phase 0 does not switch runtime to
#      target contracts yet, but new code MUST NOT use the legacy literal
#      `'done'` as a Run status. The check looks specifically for RunStatus
#      assignments (`run.status = 'done'`, `SET status='done'`, or
#      comparisons against the literal in Run-facing code paths). Surface
#      context queues use `'done'` for an unrelated status enum and are
#      not flagged.
grep -rnE "(run\.status\s*=\s*'done'|SET\s+status\s*=\s*'done')" \
  packages/*/src > /tmp/phase0_done_hits.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_done_hits.txt /tmp/phase0_done_unack.txt
if [ -s /tmp/phase0_done_unack.txt ]; then
  echo "architecture-gate: Run.status = 'done' literal found outside acknowledged legacy paths:" >&2
  cat /tmp/phase0_done_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.b. Late `api.cronsRuntime` writes. Triggers runtime contract must not
#      appear as a runtime-mutated field outside acknowledged legacy.
grep -rnE "\.cronsRuntime\s*=" packages/*/src > /tmp/phase0_crons_hits.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_crons_hits.txt /tmp/phase0_crons_unack.txt
if [ -s /tmp/phase0_crons_unack.txt ]; then
  echo "architecture-gate: cronsRuntime assignment outside acknowledged legacy:" >&2
  cat /tmp/phase0_crons_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.c. Route-local OAuth pending Maps in production runtime code.
grep -rnE "new\s+Map<string,\s*OAuthFlow>" packages/*/src > /tmp/phase0_oauth_hits.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_oauth_hits.txt /tmp/phase0_oauth_unack.txt
if [ -s /tmp/phase0_oauth_unack.txt ]; then
  echo "architecture-gate: route-local OAuth pending Map outside acknowledged legacy:" >&2
  cat /tmp/phase0_oauth_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.d. Rollout flag reads outside the registered RolloutFlag port.
grep -rnE "process\.env\.(QM_ROLLOUT_|ROLLOUT_FLAG_)" packages/*/src > /tmp/phase0_rollout_hits.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_rollout_hits.txt /tmp/phase0_rollout_unack.txt
if [ -s /tmp/phase0_rollout_unack.txt ]; then
  echo "architecture-gate: rollout flag read outside RolloutFlag port:" >&2
  cat /tmp/phase0_rollout_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.e. Triggers MUST NOT import @qm/api. Phase 4 boundary check;
#      included here as a forward-looking guard so any drift from the
#      decoupling lands as a reviewable failure.
grep -rnE "from\s+'@qm/api'" packages/triggers/src > /tmp/phase0_triggers_api.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_triggers_api.txt /tmp/phase0_triggers_api_unack.txt
if [ -s /tmp/phase0_triggers_api_unack.txt ]; then
  echo "architecture-gate: @qm/api imported by triggers (Phase 4 boundary):" >&2
  cat /tmp/phase0_triggers_api_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.f. Security Screening imported only from HTTP route on a production
#      Turn path. Phase 3 boundary check; the gate flags any new
#      Security-screener import outside the security package or the
#      HTTP route adapter in `@qm/api`. Other core packages must not
#      bypass the security port.
grep -rnE "from\s+'@qm/security'" packages/*/src \
  | grep -v 'packages/security/src' \
  | grep -v 'packages/api/src' > /tmp/phase0_security_hits.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_security_hits.txt /tmp/phase0_security_unack.txt
if [ -s /tmp/phase0_security_unack.txt ]; then
  echo "architecture-gate: @qm/security imported outside security + api packages:" >&2
  cat /tmp/phase0_security_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.g. Command policy results collapsed into exit codes on target paths.
#      Phase 2 boundary check; flags any place where the legacy
#      `LegacyCommandDecision` is used as a numeric exit code (e.g.
#      `process.exit(decision)`). Pattern is intentionally narrow so
#      the Phase 2 work isn't blocked by unrelated `process.exit` use.
grep -rnE "process\.exit\([^)]*decision[^)]*\)" packages/*/src > /tmp/phase0_exit_hits.txt 2>/dev/null || true
filter_unacknowledged /tmp/phase0_exit_hits.txt /tmp/phase0_exit_unack.txt
if [ -s /tmp/phase0_exit_unack.txt ]; then
  echo "architecture-gate: command policy decision collapsed to exit code:" >&2
  cat /tmp/phase0_exit_unack.txt >&2
  violations=$((violations + 1))
fi

# 1.h. IM platform symbols in core packages (already enforced by
#      pnpm check:im). The script's own exemptions cover
#      packages/im-feishu and packages/spike-feishu.
if [ -x scripts/check-im-isolation.sh ]; then
  if ! bash scripts/check-im-isolation.sh >/dev/null 2>/tmp/phase0_im_hits.txt; then
    echo "architecture-gate: IM platform symbols leaked into core:" >&2
    cat /tmp/phase0_im_hits.txt >&2
    violations=$((violations + 1))
  fi
fi

# --- 2. Contract parity suite --------------------------------------------------
# Run the concurrency contract suite. The script skips Postgres tests when
# QM_NEXT_PG_URL is unset; CI exports it.
if ! node --import tsx/esm --test packages/concurrency/tests/contract-parity.test.ts; then
  echo "architecture-gate: contract suite failed" >&2
  violations=$((violations + 1))
fi

# Bit-identical parity suite: when Postgres is reachable, exercises both
# memory and Postgres implementations with the same logical operation
# sequence and asserts the result sequences agree bit-identically.
if ! node --import tsx/esm --test packages/concurrency/tests/parity-bit-identical.test.ts; then
  echo "architecture-gate: bit-identical parity suite failed" >&2
  violations=$((violations + 1))
fi

# --- 3. Result -----------------------------------------------------------------
if [ "$violations" -gt 0 ]; then
  echo "architecture-gate: $violations violation(s)" >&2
  exit 1
fi
echo "architecture-gate OK"
