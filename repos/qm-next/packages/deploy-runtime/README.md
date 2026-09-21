# @qm/deploy-runtime

Cluster 1 deploy runtime MVP: a Docker provider, a materialize hook
over `@qm/store`'s `DurableByteStore`, and the public reverse-proxy
plumbing for `/d/<slug>/**`. See
`docs/qm-next-parity-clearance/qm-next-deploy-runtime-mvp.md` for the
PRD and `docs/qm-next-parity-clearance/cluster-1-interface-memo.md`
for the engineer hand-off.

## What lives here

| File | Role |
|---|---|
| `src/port.ts` | `DeployFile`, `DeployMaterializer`, `DeployProvider`, `DockerExec` types and the `DockerDeployProviderOptions` shape |
| `src/docker-exec.ts` | `spawnDockerExec` — node:child_process adapter; same shape as qm's `src/sandbox/docker-exec.ts` |
| `src/docker.ts` | `createDockerDeployProvider` — port of qm's 165-line Docker provider, retargeted to the qm-next `DeployApplyInput` signature |
| `src/materialize.ts` | `createMaterializer(byteStore, opts)` — writes `DeployFile` entries into a per-version workspace directory |
| `src/testing.ts` | `createRecordingDockerExec`, `createMockDockerDeployProvider`, `createStaticDeployProvider` — test fixtures |
| `src/index.ts` | Public re-exports |

## Composition (production)

```typescript
import { createDockerDeployProvider, createMaterializer } from '@qm/deploy-runtime'
import { createLocalByteStore } from '@qm/store'
import { createMemoryDeploymentStore } from '@qm/api/services/deployment-store.ts'

const byteStore = createLocalByteStore('/var/lib/qm-next/blobs')
const provider  = createDockerDeployProvider({ basePort: 9200 })
const materializer = createMaterializer(byteStore, {
  workspaceRoot: '/var/lib/qm-next/workspaces',
})
const store = createMemoryDeploymentStore({
  grants,
  provider,
  materializer,
  logger,
})
```

`@qm/api` wires exactly this in `service.ts` when
`ApiConfig.deployRuntime = true`; the `/d/<slug>/**` proxy route
(`packages/api/src/routes/deployment-proxy-routes.ts`) reads the
endpoint live via `provider.resolveEndpoint()`.

## Demo (local)

```bash
# 1. Spin the API with the runtime on and a signing secret.
pnpm tsx scripts/dev-deploy.ts \
  --deploy-runtime \
  --deploy-image node:24-alpine \
  --deploy-base-port 9200 \
  --deploy-workspace-root /tmp/qm-next-workspaces

# 2. POST a deploy — entrypoint runs against the in-memory store;
#    the docker provider spins a container, mounts the materialized
#    workspace read-only at /app.
curl -X POST localhost:PORT/v1/deployments \
  -H 'authorization: Bearer <token>' \
  -d '{
    "ownerScopeId": "personal:user-1",
    "createdBy": "user-1",
    "entrypoint": "node server.js",
    "files": [
      { "path": "server.js", "blobKey": "files/<sha256>" }
    ],
    "name": "hello"
  }'

# 3. Hit the proxy; the inbound request lands at the running container.
curl localhost:PORT/d/hello/
```

`scripts/dev-deploy.ts` is a future-PR follow-up; this README points at
the shape until the demo script lands.

## Verification

```bash
pnpm --filter @qm/deploy-runtime typecheck
pnpm --filter @qm/deploy-runtime test
```

The unit tests cover:

- Docker provider: `apply`/`destroy`/`resolveEndpoint`/`logs` against
  a recording fake docker exec; `dockerDaemonFailure` probe (5 paths)
- Materialize: per-version workspaces, nested paths, blob-not-found,
  path-traversal rejection
- Deployment store wiring: `deploy`/`redeploy`/`archive`/`restore`/
  `rollback`/`logsFor` each drive the runtime hooks; the lane-A fallback
  (no runtime deps) keeps the in-memory shape

## Out of scope (cluster 1 MVP)

- Fly / AWS / Porter providers (the `DeployProvider` port is provider-neutral)
- Git HTTP backend (`/v1/credentials/git/...`, smart-HTTP proxy)
- Multi-host, scale-to-zero, public subdomains (`DEPLOY_APPS_DOMAIN`)
- Share-capability flow for deployments (`POST /v1/deployments/:id/share` stays 403)