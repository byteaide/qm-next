#!/usr/bin/env bash
# Build vendored framework packages: tsc emits JS + d.ts into lib/types,
# then runtime JS is synced into lib/ (the package.json main entry target).
# Single-stage simplification of dsh's tsdown two-stage pipeline.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[build-vendor] tsc project build (reference order resolved by -b)"
pnpm exec tsc -b vendor/cosmokit vendor/schemastery vendor/cordis vendor/loader vendor/include vendor/timer

for pkg in cosmokit schemastery cordis loader include timer; do
  echo "[build-vendor] sync runtime js: $pkg"
  rsync -a --include='*/' --include='*.js' --include='*.js.map' --exclude='*' "vendor/$pkg/lib/types/" "vendor/$pkg/lib/"
done

echo "[build-vendor] done"
