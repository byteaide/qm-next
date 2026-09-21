# Cluster 1 — Deploy Runtime Interface Status Memo

**Worktree**: `~/Git/_worktrees/qm-next-deploy-runtime-mvp` · branch `feat/deploy-runtime-mvp`
**Date**: 2026-09-21
**Audience**: cluster-1 engineer (Docker provider + /d/<slug>)

## TL;DR

- `DeploymentStore` interface + in-memory impl exist but have **zero provider hooks** — deploy/redeploy/archive/rollback mutate Map entries only, no `provider.apply()`/`destroy()` calls
- `DurableByteStore` has memory + local-FS legs (no `list()` method, no S3); ready for `materialize` hook
- `packages/types/src/deploy.ts` **does not exist** — must be created per PRD
- `/d/<slug>` public proxy route **does not exist**; no reverse-proxy route anywhere in the codebase
- `service.ts` line 888 constructs `createMemoryDeploymentStore({ grants })` with no provider/materializer injection — the wiring seam must be added
- `architecture.md` has **no deploy-runtime section** — engineer creates it from scratch

## 1. Current `DeploymentStore` shape

**Interface** (`deployment-store.ts:85-100`):

```typescript
interface DeploymentStore {
  deploy(input: DeployInput): Promise<DeploymentRecord>
  list(): Promise<DeploymentRecord[]>
  listForViewer(viewer: string): Promise<ViewerDeployment[]>
  getByIdOrName(idOrName: string): Promise<DeploymentRecord | null>
  canManage(id: string, principalId: string): Promise<boolean>
  rollback(id: string, version: number): Promise<void>
  redeploy(id: string, input: { entrypoint: string; files: unknown[] }): Promise<DeploymentRecord>
  archive(id: string): Promise<void>
  restore(id: string): Promise<DeploymentRecord>
  rename(id: string, name: string): Promise<DeploymentRecord>
  setDisplayName(id: string, displayName: string): Promise<DeploymentRecord>
  share(id: string, targetScope: string, permission: 'read' | 'write' | null, opts: { createdBy: string }): Promise<...>
  logsFor(id: string, viewer: string, opts: { tailLines: number }): Promise<{ status: 'ok' | 'missing'; logs: string | null }>
  reach(id: string, viewer: string): Promise<{ status: 'ok' | 'missing' }>
}
```

**Constructor** (`deployment-store.ts:102`):

```typescript
export function createMemoryDeploymentStore(deps: { grants: GrantLedger }): DeploymentStore
```

| Method | Current behaviour |
|--------|-------------------|
| `deploy()` | **real** — creates record, v1; no `provider.apply()` (lines 109-122) |
| `redeploy()` | **real** — bumps version; no `provider.apply()` (lines 154-163) |
| `archive()` | **real** — sets `status='archived'`; no `provider.destroy()` (lines 164-168) |
| `rollback()` | **real** — sets `currentVersion`/`appliedVersion`; no `provider.apply()` (lines 147-153) |
| `restore()` | **real** — sets `status='live'`; no `provider.apply()` (lines 169-174) |
| `getByIdOrName()` | **real** — Map lookup by id or name (lines 137-140) |
| `logsFor()` | **stub** — returns `{ status: 'ok', logs: null }` (lines 212-216) |
| `list()` / `listForViewer()` | **real** — Map iteration + grant check |
| `canManage()` / `share()` / `reach()` | **real** — grant-ledger backed |
| `rename()` / `setDisplayName()` | **real** — field mutation |

## 2. Current route surface (`deployment-routes.ts`)

Self-doc comment at line 1-6:

```typescript
/**
 * /v1/deployments — qm deployment management lane. Shapes and error
 * ladders mirror repos/qm/src/api/routes/deployments.ts; the public proxy
 * lane (/d/<slug>, admin proxy, git http backend) and live fetch/logs
 * need the deployment runtime, which lands with the 13.0 im-bridge.
 */
```

| Method | Path | Auth | Handler | Current behaviour |
|--------|------|------|---------|-------------------|
| POST | `/v1/deployments` | source | `createDeployment` | real — `store.deploy()` |
| GET | `/v1/deployments` | either | `listDeployments` | real — `store.list()/listForViewer()` |
| GET | `/v1/deployments/:id` | either | `getDeployment` | real — `store.getByIdOrName()` |
| GET | `/v1/deployments/:id/fetch` | either | `fetchDeployment` | **502 stub** — `upstream_unreachable` (line 103) |
| GET | `/v1/deployments/:id/logs` | either | `deploymentLogs` | partial — `store.logsFor()` returns `{logs:null}` |
| GET | `/v1/deployments/:id/git-url` | either | `deploymentGitUrl` | **403 stub** — capability token required (line 123) |
| GET | `/v1/deployments/:id/owner-url` | source | `deploymentOwnerUrl` | **503 stub** — `DEPLOY_APPS_DOMAIN` unwired (line 140) |
| POST | `/v1/deployments/:id/share` | either | `shareDeployment` | **403 stub** — capability token required (line 145) |
| POST | `/v1/deployments/:id/rollback` | source | `rollbackDeployment` | real — `store.rollback()` |
| POST | `/v1/deployments/:id/redeploy` | source | `redeployDeployment` | real — `store.redeploy()` |
| POST | `/v1/deployments/:id/archive` | either | `archiveDeployment` | real — `store.archive()` |
| POST | `/v1/deployments/:id/restore` | either | `restoreDeployment` | real — `store.restore()` |
| POST | `/v1/deployments/:id/name` | either | `renameDeployment` | real — `store.rename()` |
| POST | `/v1/deployments/:id/display-name` | either | `setDeploymentDisplayName` | real — `store.setDisplayName()` |

## 3. `DurableByteStore` matrix (file: `packages/store/src/byte-store.ts`)

**Interface** (line 26-30):

```typescript
interface DurableByteStore {
  put(bytes: Uint8Array, opts?: { maxBytes?: number }): Promise<PutBytesResult>
  open(blobKey: string): Promise<{ bytes: Buffer; sizeBytes: number } | null>
  delete(blobKey: string): Promise<void>
}
```

- **`list()` is NOT defined** — no enumeration capability; `materialize` must use known blob keys
- **Memory leg** (`createMemoryByteStore`, line 41): `Map<string, Buffer>`, content-addressed `files/<sha256>`
- **Local-FS leg** (`createLocalByteStore`, line 61): `files/<sha256>` on disk, atomic write-rename, `createReadStream` on open
- **S3 leg**: explicitly absent — line 5 comment: "S3 stays out of v1 — parity deviation"

## 4. `packages/types/src/deploy.ts` — does it exist?

**No.** The `packages/types/src/` directory has 23 `.ts` files (turn.ts, run.ts, harness.ts, credentials.ts, etc.) but **no `deploy.ts`**. The PRD's `DeployProvider`, `DeployEndpoint`, `DeployProfile`, and `DeployMaterializer` interfaces must be created here from scratch.

## 5. Composition root wiring (`packages/api/src/service.ts`)

**Byte-store wiring** (lines 872-880):

```typescript
let byteStore: DurableByteStore | undefined
if (this.config.files || this.config.blobs) {
  if (this.config.filesDir) {
    byteStore = createLocalByteStore(this.config.filesDir)
  } else {
    if (databaseUrl) this.ctx.logger.warn('api: databaseUrl set but filesDir missing — file bytes stay in RAM')
    byteStore = createMemoryByteStore()
  }
}
```

**DeploymentStore construction** (line 888):

```typescript
const deploymentStore = this.config.deployments
  ? createMemoryDeploymentStore({ grants: grantLedger! })
  : undefined
```

Only `{ grants: grantLedger }` is passed — **no `deployProvider` or `materializer` injection**. The PRD's proposed signature adds these optional deps.

**Route registration** (lines 1184-1191): `deploymentStore` passed to `deploymentRoutes()` deps with optional `deployAppsDomain`. Also passed to admin service at line 1212.

## 6. `/d/<slug>` public proxy path

**Does not exist.** No route matching `/d/:slug/*` is registered anywhere in `packages/api/src/routes/`. The nearest analogue is `deploymentOwnerUrl` (line 126-141), which references `/d/${slug}/` inside a 503 error message:

```typescript
message: `app subdomains are not configured — this app is reachable signed-in at /d/${slug}/; set DEPLOY_APPS_DOMAIN (with AWS_DEPLOY_GATE_SECRET) to enable per-app subdomains and live editing`,
```

No reverse-proxy or static-serve route exists to model the new `deployment-proxy-routes.ts` on.

## 7. Existing architecture decisions relevant to deploy

From `docs/architecture.md` (274 lines, Chinese-primary):

- **No DeployProvider / DeploymentStore / materialize discussion exists.** The doc covers Run lifecycle, Admission, Command Gate, Approval, IM intake, Trigger, Connector OAuth, configuration, events, process topology, security, gates.
- Single-process topology (§10): "M0-M2 单进程" — the Docker provider must fit this model
- Plugin architecture (§1): all capabilities are Cordis plugins; `ctx.effect()`/`ctx.on()` registration
- Store pattern (§2): "Postgres + 内存双实现" — DeploymentStore follows this dual-impl pattern
- No ADR addresses deploy runtime

## 8. Parity deviations to close

**parity-deviations.md #45b** (lines 349-354):

```
(b) the deployment proxy lane (`/d/<slug>/**`, the admin proxy, and the
git http-backend routes) is not registered — it needs the deploy runtime
and gate (13.0); `/v1/deployments/:id/fetch` answers `502 upstream_unreachable`
and logs answer `{logs:null}` (no live runtime); `git-url` keeps the qm
capability 403 and `owner-url` the unwired-`DEPLOY_APPS_DOMAIN` 503;
```

**`deployment-routes.ts:4` self-doc** (line 4-5):

```
 * lane (/d/<slug>, admin proxy, git http backend) and live fetch/logs
 * need the deployment runtime, which lands with the 13.0 im-bridge.
```

## 9. Risks & gotchas for the engineer

1. **No `list()` on `DurableByteStore`** — `materialize` must receive explicit blob keys from the DeployInput `files[]` array; cannot enumerate the store
2. **`deployProvider` / `materializer` are not in `createMemoryDeploymentStore`'s deps** — the constructor signature must be extended (PRD shows optional fields); verify all call sites in `service.ts` and tests
3. **No reverse-proxy precedent** — `deployment-proxy-routes.ts` is net-new; the framework's `Route` type and `sendJson` helper are the only building blocks (see `routes/framework.ts`)
4. **`logsFor()` returns `{status:'ok', logs:null}`** — the store stub is "honest unavailable"; wiring `provider.logs()` must preserve the `{status, logs}` shape
5. **`deploymentOwnerUrl` already mentions `/d/${slug}/`** in a 503 message — ensure the new proxy route doesn't conflict with this handler's user-facing messaging
6. **`archive()` sets status but doesn't call `provider.destroy()`** — container leaks are possible if archive succeeds but destroy fails; consider try/catch + status rollback
7. **`rollback()` sets `appliedVersion` without `provider.apply()`** — the old version's workspace dir may no longer exist; `materialize` must be re-callable for old versions
8. **Architecture doc has no deploy section** — add one in the same PR to document the provider port and materializer hook

## 10. Suggested implementation order

1. **Port + types** (0.5 day) — create `packages/types/src/deploy.ts` with `DeployProvider`, `DeployEndpoint`, `DeployProfile`, `DeployMaterializer`; export from `packages/types/src/index.ts`
2. **Docker provider impl** (1-2 days) — create `packages/deploy-runtime/src/docker.ts` (`createDockerDeployProvider`); port qm's 165-line docker provider; mock `dockerExec` for tests
3. **Materializer + byteStore hook** (0.5 day) — create `packages/deploy-runtime/src/materialize.ts` (`materializeDeployment`); reads blobs via `DurableByteStore.open()` → writes tmp workspace dir
4. **Deployment-store hook** (1 day) — extend `createMemoryDeploymentStore` deps with optional `deployProvider`/`materializer`; wire `deploy`/`redeploy` → `provider.apply()`; `archive` → `provider.destroy()`; `rollback` → `provider.apply()` with old version
5. **`/d/<slug>` proxy route** (1-2 days) — create `packages/api/src/routes/deployment-proxy-routes.ts`; `ALL /d/:slug/*` with `either` auth; resolve deployment → `provider.resolveEndpoint()` → HTTP forward to `127.0.0.1:port`
6. **Tests** (1 day) — `packages/deploy-runtime/tests/docker.test.ts` (mock); `materialize.test.ts` (in-memory round-trip); `e2e.test.ts` (real container, opt-in via `DOCKER_HOST`)
7. **Docs + demo** (0.5 day) — `packages/deploy-runtime/README.md`; local `pnpm dev` demo script; update `deployment-routes.ts:4` self-doc to remove the "lands with 13.0" note