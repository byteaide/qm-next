# Deploy Runtime MVP — Docker Provider + `/d/<slug>`

**Cluster**: 1 (deploy runtime) — see `qm-next-parity-clearance-2026-09-21.md`
**Status**: Approved plan, awaiting engineering execution
**Target**: 1 engineer, serial, ~6-8 days

## Context

qm-next's deployment routes (`/v1/deployments/*`) are registered in `packages/api/src/routes/deployment-routes.ts` but hit an in-memory store with no live runtime. The public proxy `/d/<slug>/**`, git HTTP backend, and live fetch/logs/redeploy all return 502/403/404 stubs (parity-deviations.md #45b; `deployment-routes.ts:4` comment).

This MVP brings **one provider (Docker)** and the **public proxy** online so qm-next can host an agent app end-to-end on a single host. Larger concerns are explicitly OUT.

## Decisions (already made in conversation)

| Question | Decision | Rationale |
|---|---|---|
| Provider layer | Docker only | No AWS/Fly accounts needed; qm's 165-line docker provider can be ported |
| byte-store integration | `materialize` hook at apply time | Decouples provider from `DurableByteStore` internals; future-proofs S3 swap |
| Port allocation | In-memory pool + docker inspect self-heal | docker daemon is source of truth; qm's proven pattern |
| Demo path | Local `pnpm dev` + docker daemon | MVP scope; Fly staging needs accounts + DNS |
| Layer 3 (git HTTP) | Deferred to follow-up PRD | Tightly coupled with deploy-fs; out of MVP scope |

## Scope

**IN**

- `DeployProvider` port (`packages/types/src/deploy.ts`)
- `createDockerDeployProvider()` (`packages/deploy-runtime/src/docker.ts`)
- `materializeDeployment(input, byteStore): Promise<string>` helper
- Hooks into `DeploymentStore`: `deploy`/`redeploy` call `provider.apply()`, archive/restore call `provider.destroy()`/`provider.apply()`
- `/d/<slug>/**` reverse-proxy route with capability-token auth
- `pnpm dev` demo: POST a hello-world, curl `/d/<slug>/`, see response
- Mock `dockerExec` unit tests + one real-container e2e

**OUT**

- Fly provider / AWS provider / Porter provider
- Git HTTP backend (`/v1/credentials/git/...`, smart-HTTP proxy)
- Multi-host, scale-to-zero, public subdomains
- `DEPLOY_APPS_DOMAIN` subdomain proxy
- Share-capability flow for deployments

## Interfaces

```typescript
// packages/types/src/deploy.ts
export interface DeployEndpoint { host: string; port: number }

export interface DeployProfile {
  managedScaleToZero: boolean
}

export interface DeployMaterializer {
  materialize(input: { entrypoint: string; files: unknown[] }): Promise<string>
}

export interface DeployProvider {
  readonly profile: DeployProfile
  apply(deploymentId: string, version: number, workspaceDir: string, entrypoint: string, env: Record<string, string>): Promise<DeployEndpoint>
  destroy(deploymentId: string): Promise<void>
  resolveEndpoint(deploymentId: string, version: number): Promise<DeployEndpoint | null>
  logs(deploymentId: string, opts: { tailLines: number }): Promise<string | null>
}
```

## File layout

```
packages/deploy-runtime/
  src/
    index.ts             # re-exports
    port.ts              # DeployProvider, DeployEndpoint, DeployMaterializer
    docker.ts            # createDockerDeployProvider
    materialize.ts       # materializeDeployment
    testing.ts           # createMockDockerDeployProvider (for unit tests)
  tests/
    docker.test.ts       # mock dockerExec
    materialize.test.ts  # byteStore in-memory round-trip
    e2e.test.ts          # real container, requires DOCKER_HOST

packages/types/src/deploy.ts                    # port + types
packages/api/src/routes/deployment-proxy-routes.ts  # /d/<slug>/*
packages/api/src/services/deployment-store.ts   # wire provider hooks
packages/api/src/service.ts                     # composition root wiring
```

## Hook into `DeploymentStore`

```typescript
// packages/api/src/services/deployment-store.ts (additions)
import type { DeployProvider, DeployMaterializer } from '@qm/deploy-runtime'

export function createMemoryDeploymentStore(deps: {
  grants: GrantLedger
  deployProvider?: DeployProvider
  materializer?: DeployMaterializer
}): DeploymentStore {
  // existing impl; deploy/redeploy/archive now call provider
  // - deploy(): materializer.materialize() -> workspace dir; provider.apply()
  // - redeploy(): same; provider.apply() with new version
  // - archive(): provider.destroy()
  // - rollback(): provider.apply() with old version's workspace dir
}
```

## `/d/<slug>` proxy

```typescript
// packages/api/src/routes/deployment-proxy-routes.ts
export function deploymentProxyRoutes(deps: {
  deployments: DeploymentStore
  provider: DeployProvider
}): ReadonlyArray<Route> {
  return [
    { method: 'ALL', path: '/d/:slug/*', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
  ]
}

async function proxyToDeployment(ctx, deps): Promise<unknown> {
  const slug = ctx.params.slug
  const deployment = await deps.deployments.getByIdOrName(slug)
  if (!deployment) return sendJson(ctx, 404, { error: 'not_found' })

  const version = deployment.appliedVersion ?? deployment.currentVersion
  const endpoint = await deps.provider.resolveEndpoint(deployment.id, version)
  if (!endpoint) return sendJson(ctx, 502, { error: 'container_not_running' })

  // Stream HTTP request to 127.0.0.1:endpoint.port, return response
}
```

## Verification

- `pnpm typecheck` — green
- `pnpm test` — green (mock dockerExec)
- `pnpm test:pg` — green (DeploymentStore now uses real provider)
- `pnpm test:e2e` — requires `DOCKER_HOST`; one real container
- Demo commands documented in `packages/deploy-runtime/README.md`

## Estimate

| Phase | Time | Notes |
|-------|------|-------|
| Port + types | 0.5 day | `packages/types/src/deploy.ts` |
| Docker provider impl | 1-2 days | port qm 165 lines, mock `dockerExec` |
| Materializer + byteStore hook | 0.5 day | write blob → tmp dir |
| Deployment-store hook | 1 day | deploy/redeploy/archive/rollback call provider |
| `/d/<slug>` proxy route | 1-2 days | capability-token auth + http forwarding |
| Tests (mock + e2e) | 1 day | `pnpm test:e2e` needs Docker |
| Docs + demo | 0.5 day | README + local demo script |
| **Total** | **~6-8 days** | |

## Dependencies

- `@qm/types` — needs new `deploy.ts` (no breaking change)
- `@qm/store` — `DurableByteStore` already in place (`packages/store/src/byte-store.ts:26`)
- `@qm/api` — `DeploymentStore` already in place (`packages/api/src/services/deployment-store.ts:85`)
- Docker daemon — required for e2e and demo (local dev only)

## Risk register

| Risk | Mitigation |
|---|---|
| docker daemon unavailable in CI | `test:e2e` opt-in via `DOCKER_HOST`; unit tests use mock |
| Port allocation race on concurrent deploys | qm uses `freed[]` + `nextPort++`; same pattern |
| Container leaks on crash | `archive` always calls `provider.destroy()`; reconcile via `resolveEndpoint` |
| `materialize` IO cost on large files | content-addressed, dedup'd; tmp dir cleaned after `destroy` |