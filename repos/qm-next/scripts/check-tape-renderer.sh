#!/usr/bin/env bash
# M-Tape-3 byte-parity gate (2026-09-26): `fold(tape) ≈ forRender(tape).entries`
# over a canonical fixture; memory-backed by default, Postgres-backed when
# `QM_NEXT_PG_URL` is set (CI). Exit 0 on pass; 1 on first divergence.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm exec tsx scripts/check-tape-renderer.ts