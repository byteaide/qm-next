#!/usr/bin/env bash
# Assert the vendored tree carries no @deepseek-ai references in code surfaces.
# Prose in README/docs intentionally keeps upstream names (see vendor/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

count=$(grep -r '@deepseek-ai' vendor --include='*.ts' --include='*.js' --include='*.json' | wc -l | tr -d ' ')
if [ "$count" != "0" ]; then
  echo "rescope-check FAILED: $count @deepseek-ai references remain"
  grep -rn '@deepseek-ai' vendor --include='*.ts' --include='*.js' --include='*.json'
  exit 1
fi
echo "rescope-check OK: no @deepseek-ai references in vendor code surfaces"
