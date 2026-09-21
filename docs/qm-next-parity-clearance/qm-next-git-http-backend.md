# Git HTTP Backend — Cluster 1 Phase 2

**Cluster**: 1 follow-up (parity #45b remaining slice)
**Status**: Approved plan, awaiting engineering execution
**Target**: 1 engineer, serial, ~5-7 days

## Context

Cluster 1 MVP (`ea6303f` on main) shipped the Docker provider + `/d/<slug>/**` reverse proxy but explicitly deferred the git HTTP backend slice:

> (b) the deployment proxy lane (`/d/<slug>/**`, the **admin proxy, and the git http-backend routes**) is not registered — it needs the deploy runtime and gate (13.0); `/v1/deployments/:id/fetch` answers `502 upstream_unreachable` and logs answer `{logs:null}` (no live runtime); `git-url` keeps the qm capability 403 and `owner-url` the unwired-`DEPLOY_APPS_DOMAIN` 503;

Today the remaining stub is `deploymentGitUrl` returning `403 forbidden` ("a git URL requires an agent capability token"). The smart-HTTP transport that git clients use to clone / push lives one route layer deeper and is fully absent. This PRD closes the git slice.

qm-side shape (from `repos/qm/src/api/routes/deployments.ts:946-1100` and `repos/qm/src/deploy/deploy-git-store.ts`):

- Path shape: `/v1/deployments/:id/git/info/refs?service=git-upload-pack|git-receive-pack` (GET, advertises refs)
- Path shape: `/v1/deployments/:id/git/git-upload-pack` (POST, fetch)
- Path shape: `/v1/deployments/:id/git/git-receive-pack` (POST, push)
- Auth: bearer capability token or HTTP basic with the same token as the password (git clients can't set arbitrary headers)
- Implementation: spawn `git http-backend` CGI subprocess with `GIT_PROJECT_ROOT=/repoRoot/<deploymentId>` and `PATH_INFO=/<deploymentId>.git/<tail>`
- Storage: per-deployment bare repo at `<repoRoot>/<safeRepoName(deploymentId)>.git`, refs/heads/current tracks the deployed version

qm-next currently has **zero** references to `git-upload-pack` or `info/refs`. The storage backend, the route table, and the capability token issuance are all missing.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Repo storage | Bare git repos under `<repoRoot>/<safeRepoName(id)>.git` per deployment | Matches qm's `deploy-git-store.ts:80`; safe for concurrent reads, no checkout overhead |
| HTTP transport | Spawn `git http-backend` CGI subprocess (same as qm) | One well-tested upstream binary, no need to reimplement the smart-HTTP protocol |
| Auth | Capability token via `Authorization: Bearer` or HTTP Basic (password=token) | git clients can't set arbitrary headers; capability tokens already exist in `12.0` |
| Initial commit | Created on `deploy()` from `DeployInput.files` via `git -c http.receivepack=true ...` | Bridges the lane-A `DeployInput.files` shape with the git tree model |
| Migration story | `git-url` route now returns `200 { url, capability }` (real token) — previously a 403 stub | Closes the qm capability-token-only gate (parity-deviations.md #45b) |
| Repo root | `${tmpdir}/qm-next-deploy-git` by default; configurable via `ApiConfig.deployGitRepoRoot` | Same pattern as `deployWorkspaceRoot` |
| Lane-A fallback | Without `deployRuntime` (or when `gitBin` missing), `git-url` keeps returning `403` and the `/git/*` routes are not registered | Lane-A keeps the in-memory shape unchanged |

## Scope

**IN**

- `DeployGitStore` port (in `@qm/types/deploy.ts`): `commit`, `treeOf`, `filesOf`, `diff`, `bundle`, `setRef`, `deleteRef`, `refOf`, `blob`, `repoUrl`
- `createDeployGitStore({ repoRoot, gitBin, archiveStore?, archiveBytes? })` in `@qm/deploy-runtime` (memory + git-CLI backed); ports `qm/src/deploy/deploy-git-store.ts` (379 lines)
- `commitDeploymentFiles(input)` helper — turns `DeployInput.files` into a commit; mirrors qm's `deploy-service.ts:342-355`
- HTTP routes in `packages/api/src/routes/deployment-git-routes.ts`:
  - `GET /v1/deployments/:id/git/info/refs` (advertises refs)
  - `POST /v1/deployments/:id/git/git-upload-pack` (clone / fetch)
  - `POST /v1/deployments/:id/git/git-receive-pack` (push)
- `git-url` route in `deployment-routes.ts`: replace 403 stub with `200 { url, capability }` minted via `mintCapabilityToken({ aud: DEPLOY_GIT_AUD, ... })`
- `createMemoryDeploymentStore.deploy()` calls `gitStore.commit()` after `materializer.materialize()` and stores the resulting `commit` SHA on the new `DeploymentVersion`
- Path traversal guard reused from `@qm/deploy-runtime/materialize.ts` (`safeRelativePath`) so the git-tree path matches the workspace path

**OUT**

- Multi-host git (push to remote origin, fetch from upstream)
- Git LFS
- Webhook triggers on push (different PRD — fires the trigger sink via `TriggersService`)
- The admin proxy slice (different PRD, no consumer in qm-next)
- The `DEPLOY_APPS_DOMAIN` per-app subdomain proxy (different PRD, blocked on `AWS_DEPLOY_GATE_SECRET`)

## Interfaces

```typescript
// packages/types/src/deploy.ts (additions)
export interface DeployGitInputFile {
  path: string
  data: string | Uint8Array
}

export interface DeployGitTreeFile {
  path: string
  sha: string
  size: number
  mode: '100644'
}

export interface DeployGitDiff {
  added: DeployGitTreeFile[]
  modified: DeployGitTreeFile[]
  deleted: DeployGitTreeFile[]
}

export interface DeployGitStore {
  commit(input: {
    deploymentId: string
    version: number
    files: DeployGitInputFile[]
    parent?: string
    message?: string
  }): Promise<string>
  treeOf(deploymentId: string, commitSha: string): Promise<DeployGitTreeFile[]>
  filesOf(deploymentId: string, commitSha: string, paths?: string[]): Promise<DeployGitInputFile[]>
  diff(deploymentId: string, fromCommit: string | undefined, toCommit: string): Promise<DeployGitDiff>
  bundle(deploymentId: string, commitSha: string): Promise<Uint8Array>
  setRef(deploymentId: string, ref: string, sha: string): Promise<void>
  deleteRef(deploymentId: string, ref: string): Promise<void>
  refOf(deploymentId: string, ref: string): Promise<string | null>
  blob(deploymentId: string, sha: string): Promise<Uint8Array | null>
  repoUrl(deploymentId: string): Promise<string>
}
```

## HTTP route shape

```typescript
// packages/api/src/routes/deployment-git-routes.ts
export function deploymentGitRoutes(deps: {
  git: DeployGitStore
  secrets: string[]
}): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/v1/deployments/:id/git/info/refs', auth: 'either', handle: (ctx) => infoRefs(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/git/git-upload-pack', auth: 'either', handle: (ctx) => uploadPack(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/git/git-receive-pack', auth: 'either', handle: (ctx) => receivePack(ctx, deps) },
  ]
}
```

Implementation: spawn `git -c http.receivepack=true http-backend` with the env contract qm uses:

```
GIT_PROJECT_ROOT=<repoRoot>
GIT_HTTP_EXPORT_ALL=1
PATH_INFO=/<deploymentId>.git/<tail>
REQUEST_METHOD=<method>
QUERY_STRING=<stripped of token/access_token>
CONTENT_TYPE=<client header>
CONTENT_LENGTH=<body length>
REMOTE_USER=deployment-git
```

Forwards the subprocess stdout (CGI headers + body) back to the client; parses `Status:` header to set the response code. Auth header parsing accepts `Authorization: Bearer <token>` and `Authorization: Basic base64(user:token)` plus `?token=` / `?access_token=` query params for plain `git clone` invocations.

## File layout

```
packages/deploy-runtime/src/
  git-store.ts               # DeployGitStore impl (ported from qm)
  git-store.test.ts          # unit tests (mock git CLI)

packages/api/src/routes/
  deployment-git-routes.ts   # /v1/deployments/:id/git/{info/refs,git-upload-pack,git-receive-pack}

packages/api/src/
  service.ts                 # composition root wires gitStore + git routes when deployRuntime is on
  routes/deployment-routes.ts # git-url returns 200 {url, capability} when runtime is wired
```

## Verification

```bash
pnpm --filter @qm/deploy-runtime typecheck
pnpm --filter @qm/deploy-runtime test                  # mock git CLI
pnpm --filter @qm/api test                              # route tests
pnpm test:pg                                            # git store + byte-store round-trip
pnpm check:im                                           # no IM domain symbols leak
```

End-to-end manual check (with real `git` in PATH):

```bash
# 1. boot the api with deployRuntime on
pnpm tsx scripts/dev-deploy.ts --deploy-runtime

# 2. POST a deployment
curl -X POST localhost:PORT/v1/deployments \
  -H 'authorization: Bearer <signer>' \
  -d '{"ownerScopeId":"personal:user-1","createdBy":"user-1","entrypoint":"node server.js","files":[{"path":"server.js","blobKey":"files/<sha>"}]}'

# 3. read the git-url
curl -H 'authorization: Bearer <signer>' \
  localhost:PORT/v1/deployments/<id>/git-url
# → {"url":"http://...:PORT/v1/deployments/<id>/git","capability":"<cap-token>"}

# 4. clone
git clone http://localhost:PORT/v1/deployments/<id>/git /tmp/clone -c http.extraHeader="Authorization: Bearer <cap-token>"
cd /tmp/clone && cat server.js
```

## Estimate

| Phase | Time | Notes |
|---|---|---|
| `DeployGitStore` port | 1.5 days | port qm/src/deploy/deploy-git-store.ts (379 lines); mock `git` CLI for tests |
| Commit-on-deploy hook | 0.5 day | `createMemoryDeploymentStore.deploy()` → `gitStore.commit()`; store SHA on `DeploymentVersion.commit` |
| HTTP routes | 1-2 days | `deployment-git-routes.ts` (CGI subprocess + header/body forwarding); reuses `@qm/auth` capability verifier |
| `git-url` route + capability issuance | 0.5 day | replace 403 stub; `mintCapabilityToken({ aud: 'deploy_git', deploymentId, scopes: ['read' \| 'write'] })` |
| Tests | 1 day | mock git CLI; full HTTP round-trip with Fastify `inject` |
| Docs + manual smoke | 0.5 day | update `architecture.md` §13 with the git slice; live `git clone` smoke |
| **Total** | **~5-6 days** | |

## Dependencies

- `@qm/auth` — `mintCapabilityToken` (already shipped in 12.0 control plane)
- `@qm/store` — `DurableByteStore` already in place (cluster 1 MVP)
- `@qm/deploy-runtime` — `DeployFile` shape from cluster 1 MVP
- `git` CLI on the host (system binary; CI carries `git` as a base image dep)

## Risk register

| Risk | Mitigation |
|---|---|
| `git` binary missing in CI / production image | Lane-A fallback: without `gitBin`, routes are not registered; `git-url` keeps 403 — same as today |
| Concurrent pushes corrupting the bare repo | git CLI serializes writes per-repo via `index.lock`; multi-writer safety is git's concern, not ours |
| Capability token leakage in `git-url` response | Token has 30-minute TTL and is bound to `aud: 'deploy_git'` with the deployment id; `@qm/auth` already issues + verifies these |
| Path traversal via tree paths | `safeRelativePath` from `@qm/deploy-runtime/materialize.ts` rejects `.git` components and `..` |
| Subprocess leaks (uncaught `git http-backend` crash) | Use `child_process.spawn` with `killSignal: 'SIGKILL'`, `timeout: 60_000`; surface error as 502 |
| Bare repo size blow-up on many pushes | Garbage-collect via `git gc --auto` after each `receive-pack` (best-effort); ship config knob `gcAfterPush` |
| `application/x-git-receive-pack` Content-Type missing | qm's `readRequestBytes` reads raw bytes; CGI env contract passes `CONTENT_TYPE` through |