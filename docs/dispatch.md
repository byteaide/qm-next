# Dispatch Plan — qm-next parity gap workers

**Created**: 2026-09-21
**Source artifacts**: `qm-next-parity-clearance-2026-09-21.md`, `qm-next-deploy-runtime-mvp.md`, `docs/briefs/`

This document is the dispatcher view. Active briefs are below; each links to a full worker-ready brief. Blocked briefs live in `docs/briefs/` but are marked not-dispatchable until their `Blocked by` condition resolves.

## Active execution queue

Three units run in parallel — recommended batch (Plan C from parity clearance):

| Unit | Engineer | Briefs | Worktree | Branch |
|---|---|---|---|---|
| **Engineer (cluster 1 MVP)** | Human / long-running agent | `qm-next-deploy-runtime-mvp.md` (1 PRD) | `~/Git/_worktrees/qm-next-deploy-runtime-mvp` (to create) | `feat/deploy-runtime-mvp` |
| **Worker A (cluster 2)** | Subagent or human | `qm-next-c2-s3-byte-store.md`, `qm-next-c2-pgboss-queue.md`, `qm-next-c2-emoji-upload.md` (3 briefs) | `~/Git/_worktrees/qm-next-cluster-2` (to create) | `chore/cluster-2-productionization` |
| **Worker B (cluster 3)** | Subagent or human | `qm-next-c3-secret-drop-requires-token.md`, `qm-next-c3-portal-identity-enforce.md`, `qm-next-c3-sandbox-digest-pin.md`, `qm-next-c3-pg-twins-migration.md` (4 briefs) | `~/Git/_worktrees/qm-next-cluster-3` (to create) | `chore/cluster-3-tails` |

**Sequencing inside each unit**: briefs run serially (small tickets, ~0.5-2 days each; avoid parallel edits in same package).

**Across-unit coordination**:
- Worker A owns `packages/{store,triggers,connectors}` (3-byte store, 3-pgboss, 3-emoji-upload)
- Worker B owns `packages/{auth,portal,store}` (3-secret-drop, 3-portal-identity, 3-sandbox-digest-pin, 3-pg-twins-migration)
- Engineer owns `packages/{types/deploy,deploy-runtime/,api/src/routes/deployment*,api/src/services/deployment-store.ts}`
- Overlap on `packages/store` (Worker A: byte-store; Worker B: pg-twins-migration) — coordinate via PR ordering: Worker A's byte-store PR merges first, then Worker B's pg-twins PR

## Per-brief dispatch decisions

| Brief | Tier | Blocked by | Initial commit message |
|---|---|---|---|
| `qm-next-deploy-runtime-mvp.md` | `tier:thinking` (architectural decisions remain: provider port surface, byte-store materializer hook) | none | `feat(deploy-runtime): Docker provider + /d/<slug> proxy MVP` |
| `qm-next-c2-s3-byte-store.md` | `tier:simple` | none | `feat(store): S3 DurableByteStore implementation` |
| `qm-next-c2-pgboss-queue.md` | `tier:simple` | none | `feat(triggers): pg-boss job queue sink` |
| `qm-next-c2-emoji-upload.md` | `tier:standard` | none | `feat(connectors): port emoji-upload-service (provider-neutral core)` |
| `qm-next-c3-secret-drop-requires-token.md` | `tier:simple` | none | `fix(secret-drop): bind capability token to drop URL (parity #47a)` |
| `qm-next-c3-portal-identity-enforce.md` | `tier:standard` | none | `fix(portal): enforce portal identity in production mode (parity #47b)` |
| `qm-next-c3-sandbox-digest-pin.md` | `tier:simple` | none | `chore(sandbox): digest-pin base images in fly/ and local/ Dockerfiles` |
| `qm-next-c3-pg-twins-migration.md` | `tier:standard` | none | `feat(migration): close PG twins gap (constructor-only stores → PG twins)` |

## Blocked briefs (do NOT dispatch)

| Brief | Blocked by | Resume trigger |
|---|---|---|
| `qm-next-c2-codex-device-login.md` | Codex auth credentials (CHATGPT_AUTH or subscription OAuth) | Credentials available + worker has codex binary |
| `qm-next-c2-monitor-poller.md` | Triggers/runs/identity/delivery/idempotency/sandbox surfaces exposed to `@qm/monitors` | Surfaces injected via composition root |
| `qm-next-c3-runs-aggregate.md` | Observability convergence seam (`sessionsByThreadRefs`) | Observability slice merged |
| `qm-next-c3-tool-ledger.md` | Runs/replay lane (`once()` seam) | Replay slice merged |

When a `Blocked by` resolves, edit the brief to remove the `⚠️ BATCH 2 — BLOCKED` banner and move from blocked table to active table.

## Verification gate (all units must pass before merge)

Each unit's PR must satisfy, before review request:

```bash
# 1. Type and lint
pnpm --filter @qm/<affected-packages> typecheck

# 2. Unit tests (memory leg)
pnpm --filter @qm/<affected-packages> test

# 3. PG contract tests (when code adds PG persistence)
pnpm test:pg

# 4. Architecture gate
pnpm check:im        # no IM platform symbols in core
pnpm check:parity    # if parity-deviations entry was closed

# 5. Rehearsal (when code touches migration paths)
pnpm rehearsal:migrate
```

PR title format: `<type>(<scope>): <subject>` — matches qm-next commit convention.

PR body must:
- Reference the brief file path (`docs/briefs/qm-next-c2-s3-byte-store.md` etc.)
- For closed parity entries: include `Refs docs/parity-deviations.md #NNN` (note: `Refs`, NOT `Resolves`/`Closes`)
- For new functionality: include acceptance criteria checklist (copy from brief)

## Setup script (network-dependent)

When network access to `byteaide/qm-next.git` is restored, the following script sets up all three worktrees from a single repo. Run from `~/Git/qm-next/` (or wherever the canonical checkout lives):

```bash
# Engineer worktree
git worktree add -b feat/deploy-runtime-mvp ../qm-next-deploy-runtime-mvp main

# Worker A worktree
git worktree add -b chore/cluster-2-productionization ../qm-next-cluster-2 main

# Worker B worktree
git worktree add -b chore/cluster-3-tails ../qm-next-cluster-3 main

# Migrate planning artifacts
mkdir -p ../qm-next-cluster-2/docs/qm-next-parity-clearance
mkdir -p ../qm-next-cluster-3/docs/qm-next-parity-clearance
mkdir -p ../qm-next-deploy-runtime-mvp/docs/qm-next-parity-clearance

cp docs/qm-next-deploy-runtime-mvp.md ../qm-next-deploy-runtime-mvp/docs/qm-next-parity-clearance/
cp docs/qm-next-parity-clearance-2026-09-21.md ../qm-next-{deploy-runtime-mvp,cluster-2,cluster-3}/docs/qm-next-parity-clearance/
cp docs/dispatch.md ../qm-next-{deploy-runtime-mvp,cluster-2,cluster-3}/docs/qm-next-parity-clearance/
cp -r docs/briefs ../qm-next-{deploy-runtime-mvp,cluster-2,cluster-3}/docs/qm-next-parity-clearance/

# Stage, commit, push per worktree (3 separate PRs)
```

For now, all artifacts live in this aa worktree (`/Users/wxd/Git/_worktrees/aa-parity-clearance-20260921`) on branch `chore/parity-clearance-2026-09-21`. Once network is restored, the `Setup script` block runs to fan out to qm-next's three worktrees.

## Dispatch checklist

For each unit, the dispatcher confirms before starting:

- [ ] Worktree exists and is on the right branch
- [ ] Latest `main` pulled into worktree base
- [ ] Brief files copied into `docs/qm-next-parity-clearance/briefs/`
- [ ] `pnpm install` clean (lockfile in sync)
- [ ] `pnpm typecheck` baseline green
- [ ] Unit opens first brief and starts at the "Implementation Steps" section

After completion of all briefs in a unit:

- [ ] All acceptance criteria green
- [ ] `parity-deviations.md` entries marked ✅ with commit links
- [ ] PR opened with correct title/body conventions
- [ ] Architect review requested
- [ ] PR merged; worker hands off next unit (or exits)

## Plan artefacts summary

| Path | Purpose |
|---|---|
| `qm-next-parity-clearance-2026-09-21.md` | Status inventory (✅/🟡/❌/⚪) |
| `qm-next-deploy-runtime-mvp.md` | Cluster 1 PRD (engineer consumes) |
| `dispatch.md` | This file — worker assignments + sequencing |
| `briefs/qm-next-c2-*.md` | Cluster 2 worker-ready briefs (5 files: 3 active + 2 blocked) |
| `briefs/qm-next-c3-*.md` | Cluster 3 worker-ready briefs (6 files: 4 active + 2 blocked) |