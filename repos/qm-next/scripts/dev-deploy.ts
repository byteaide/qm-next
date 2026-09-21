/**
 * Deploy slice dev boot (cluster 1 MVP + phase 2 git backend).
 *
 * Boots an in-memory API with the deployment management lane and the git
 * smart-HTTP transport (fresh bare-repo root under the OS tmpdir), then
 * prints a copy-pasteable curl + git cheat-sheet. No Docker daemon and no
 * profile required — the git lane proves the storage + transport end to
 * end; wire `deployRuntime` in a profile when you need the container path.
 *
 * Run from `repos/qm-next/`; stop with Ctrl-C (or SIGTERM).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createApiServer,
  createMemoryDeploymentStore,
  createMemoryGrantLedger,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../packages/api/src/index.ts'
import { createDeployGitStore } from '../packages/deploy-runtime/src/index.ts'
import { createMemoryByteStore, createMemoryRunStore, createMemorySessionStore } from '../packages/store/src/index.ts'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '../packages/orchestrator/src/index.ts'
import { Context } from '../vendor/cordis/src/index.ts'
import type { ResolutionService, ScopeId } from '../packages/types/src/index.ts'

const SECRET = 'dev-deploy-secret'
const SCOPE: ScopeId = 'org:dev'

const resolution: ResolutionService = {
  resolve: async () => ({ systemPrompt: 'You are a dev agent.', orgScopeId: SCOPE }),
  scopeFor: () => SCOPE,
}

const registry = createHarnessRouter({ defaultId: 'mock' })
registry.register(createMockHarness())

const repoRoot = mkdtempSync(join(tmpdir(), 'qm-next-dev-deploy-git-'))
const grants = createMemoryGrantLedger()
const git = createDeployGitStore({ repoRoot })
const deployments = createMemoryDeploymentStore({ grants, gitStore: git, byteStore: createMemoryByteStore() })

const deps: ApiDeps = {
  orchestrator: new OrchestratorService(new Context(), {
    sessions: createMemorySessionStore(),
    runs: createMemoryRunStore(),
    harness: registry,
    identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
    resolution,
    rateLimiter: { check: async () => ({ allowed: true }) },
  }),
  sessions: createMemorySessionStore(),
  runs: createMemoryRunStore(),
  resolution,
  deployments: { deployments, git },
  deploymentGit: { git, orgId: 'dev' },
}

const opts: ApiServerOptions = { secrets: [SECRET] }
const app = createApiServer(deps, opts)
await app.listen({ port: Number(process.env.PORT ?? 0), host: '127.0.0.1' })
const address = app.server.address()
const port = address && typeof address === 'object' ? address.port : 0
const base = `http://127.0.0.1:${port}`
const bearer = await mintSignedPayload({ p: 'person:dev' }, SECRET)

console.log(`deploy dev slice: ${base}`)
console.log(`git repo root: ${repoRoot}`)
console.log(`bearer token: ${bearer}`)
console.log('')
console.log('# create a deployment (files deploy straight into the lane)')
console.log(`curl -s -X POST ${base}/v1/deployments \\`)
console.log(`  -H 'authorization: Bearer ${bearer}' -H 'content-type: application/json' \\`)
console.log(`  -d '{"ownerScopeId":"personal:person:dev","createdBy":"person:dev","entrypoint":"server.js","name":"dev","files":[{"path":"server.js","content":"console.log(42)"}]}'`)
console.log('')
console.log('# mint a 30-minute git URL + capability')
console.log(`curl -s -H 'authorization: Bearer ${bearer}' '${base}/v1/deployments/<id>/git-url?principalId=person:dev'`)
console.log('')
console.log('# clone / push (capability is the basic-auth password)')
console.log(`git clone http://git:<capability>@127.0.0.1:${port}/v1/deployments/<id>/git`)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`deploy dev slice: ${signal} received, closing`)
  try {
    await app.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
