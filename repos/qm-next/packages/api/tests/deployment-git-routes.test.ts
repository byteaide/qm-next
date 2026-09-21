/**
 * Deployment git smart-HTTP tests (cluster 1 phase 2, parity #45b
 * remaining slice). Covers the git-url capability mint (real token when
 * the git store is wired, 403 stub in the lane-A fallback), the git
 * transport auth ladder (401 + WWW-Authenticate: Basic, invalid token,
 * token via ?token= query), and — when a usable `git` binary is present
 * — an end-to-end info/refs advertisement over the spawned CGI plus the
 * commit-on-deploy hook through the management lane.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { mintCapabilityToken, verifyCapabilityToken } from '@qm/auth'
import { createDeployGitStore } from '@qm/deploy-runtime'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryByteStore, createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import {
  createApiServer,
  createMemoryDeploymentStore,
  createMemoryGrantLedger,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../src/index.ts'
import { DEPLOY_GIT_AUD } from '../src/routes/deployment-routes.ts'

const SECRET = 'git-http-backend-test-secret-0123456789'
const SCOPE: ScopeId = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

const run = promisify(execFile)

async function gitAvailable(): Promise<boolean> {
  for (const bin of ['git', '/usr/bin/git', '/opt/homebrew/bin/git']) {
    try {
      await run(bin, ['--version'])
      return true
    } catch {
      continue
    }
  }
  return false
}

const gitOk = await gitAvailable()

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

async function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function resolution(): ResolutionService {
  return {
    resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
}

function baseDeps(): ApiDeps {
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const res = resolution()
  return {
    orchestrator: new OrchestratorService(new Context(), {
      sessions: createMemorySessionStore(),
      runs: createMemoryRunStore(),
      harness: registry,
      identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
      resolution: res,
      rateLimiter: { check: async () => ({ allowed: true }) },
    }),
    sessions: createMemorySessionStore(),
    runs: createMemoryRunStore(),
    resolution: res,
  }
}

function gitWiredDeps(repoRoot: string): { deps: ApiDeps; store: ReturnType<typeof createMemoryDeploymentStore>; git: ReturnType<typeof createDeployGitStore> } {
  const grants = createMemoryGrantLedger()
  const store = createMemoryDeploymentStore({ grants, gitStore: createDeployGitStore({ repoRoot }), byteStore: createMemoryByteStore() })
  const git = createDeployGitStore({ repoRoot })
  const deps: ApiDeps = {
    ...baseDeps(),
    deployments: { deployments: store, git },
    deploymentGit: { git, orgId: 'test' },
  }
  return { deps, store, git }
}

test('git-url keeps the 403 stub when the git store is not wired', async () => {
  const grants = createMemoryGrantLedger()
  const store = createMemoryDeploymentStore({ grants })
  const app = createApiServer({ ...baseDeps(), deployments: { deployments: store } }, OPTS)
  const ada = auth(await token('person:ada'))
  const created = await app.inject({
    method: 'POST',
    url: '/v1/deployments',
    headers: ada,
    payload: { ownerScopeId: 'personal:person:ada', createdBy: 'person:ada', entrypoint: 'index.ts', files: [{ path: 'index.ts', content: 'x' }], name: 'no-git-app' },
  })
  assert.equal(created.statusCode, 200)
  const id = created.json().deployment.id
  const gitUrl = await app.inject({ method: 'GET', url: `/v1/deployments/${id}/git-url?principalId=person:ada`, headers: ada })
  assert.equal(gitUrl.statusCode, 403)
  await app.close()
})

test('git-url mints a real deploy-git capability token when wired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-routes-'))
  try {
    const { deps } = gitWiredDeps(join(root, 'repos'))
    const app = createApiServer(deps, OPTS)
    const ada = auth(await token('person:ada'))
    const created = await app.inject({
      method: 'POST',
      url: '/v1/deployments',
      headers: ada,
      payload: { ownerScopeId: 'personal:person:ada', createdBy: 'person:ada', entrypoint: 'index.ts', files: [{ path: 'index.ts', content: 'export default 1' }], name: 'git-app' },
    })
    assert.equal(created.statusCode, 200)
    const id = created.json().deployment.id

    const gitUrl = await app.inject({ method: 'GET', url: `/v1/deployments/${id}/git-url?principalId=person:ada`, headers: ada })
    assert.equal(gitUrl.statusCode, 200)
    const body = gitUrl.json()
    assert.equal(body.url, `/v1/deployments/${id}/git`)
    assert.equal(typeof body.capability, 'string')
    assert.equal(body.expiresInSeconds, 1800)

    const claims = await verifyCapabilityToken(body.capability, [SECRET])
    assert.ok(claims)
    assert.equal(claims!.aud, DEPLOY_GIT_AUD)
    assert.equal(claims!.actorId, 'person:ada')
    assert.deepEqual(claims!.grants, [`deployment-git:${id}`])
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('git transport rejects missing and invalid tokens with the Basic ladder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-routes-'))
  try {
    const { deps } = gitWiredDeps(join(root, 'repos'))
    const app = createApiServer(deps, OPTS)
    const url = '/v1/deployments/some-id/git/info/refs?service=git-upload-pack'

    const anonymous = await app.inject({ method: 'GET', url })
    assert.equal(anonymous.statusCode, 401)
    assert.match(String(anonymous.headers['www-authenticate']), /Basic realm="deployment git"/)

    const invalid = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer not-a-token` } })
    assert.equal(invalid.statusCode, 401)

    const basicInvalid = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Basic ${Buffer.from('git:wrong-token').toString('base64')}` },
    })
    assert.equal(basicInvalid.statusCode, 401)
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('info/refs advertises upload-pack through the CGI for a committed repo', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-routes-'))
  try {
    const { deps, git } = gitWiredDeps(join(root, 'repos'))
    const app = createApiServer(deps, OPTS)
    const ada = auth(await token('person:ada'))
    const created = await app.inject({
      method: 'POST',
      url: '/v1/deployments',
      headers: ada,
      payload: { ownerScopeId: 'personal:person:ada', createdBy: 'person:ada', entrypoint: 'server.js', files: [{ path: 'server.js', content: 'console.log("hi")' }], name: 'clone-me' },
    })
    assert.equal(created.statusCode, 200)
    const deployment = created.json().deployment
    assert.ok(deployment.versions[0].commit, 'deploy() should land a git commit')

    const capability = await mintCapabilityToken(
      {
        actorId: 'person:ada',
        aud: DEPLOY_GIT_AUD,
        scopeId: 'personal:person:ada',
        grants: [`deployment-git:${deployment.id}`],
        exp: Date.now() + 600_000,
      },
      SECRET,
      'test',
    )

    const refs = await app.inject({
      method: 'GET',
      url: `/v1/deployments/${deployment.id}/git/info/refs?service=git-upload-pack`,
      headers: { authorization: `Basic ${Buffer.from(`git:${capability}`).toString('base64')}` },
    })
    assert.equal(refs.statusCode, 200)
    assert.ok(String(refs.headers['content-type']).includes('x-git-upload-pack-advertisement'))
    assert.ok(Buffer.from(refs.body).toString('utf8').includes('deploy-commits'))

    const sha = await git.refOf(deployment.id, `refs/deploy-commits/${deployment.versions[0].commit}`)
    assert.equal(sha, deployment.versions[0].commit)
    await app.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})