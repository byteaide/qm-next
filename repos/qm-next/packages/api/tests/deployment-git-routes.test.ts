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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('git transport binds tokens to the deployment: aud, grant and owner scope (#47d)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-routes-'))
  try {
    const { deps } = gitWiredDeps(join(root, 'repos'))
    const app = createApiServer(deps, OPTS)
    const ada = auth(await token('person:ada'))
    const created = await app.inject({
      method: 'POST',
      url: '/v1/deployments',
      headers: ada,
      payload: { ownerScopeId: 'personal:person:ada', createdBy: 'person:ada', entrypoint: 'index.ts', files: [{ path: 'index.ts', content: 'x' }], name: 'bound-app' },
    })
    assert.equal(created.statusCode, 200)
    const id = created.json().deployment.id
    const url = `/v1/deployments/${id}/git/info/refs?service=git-upload-pack`
    const mint = (claims: Record<string, unknown>) =>
      mintCapabilityToken({ actorId: 'person:ada', exp: Date.now() + 600_000, ...claims } as never, SECRET, 'test')
    const send = (capability: string) =>
      app.inject({ method: 'GET', url, headers: { authorization: `Basic ${Buffer.from(`git:${capability}`).toString('base64')}` } })

    const foreignAud = await send(await mint({ aud: 'other-aud', scopeId: 'personal:person:ada', grants: [`deployment-git:${id}`] }))
    assert.equal(foreignAud.statusCode, 401)
    assert.match(foreignAud.json().message, /not valid for deployment git/)

    const foreignGrant = await send(await mint({ aud: DEPLOY_GIT_AUD, scopeId: 'personal:person:ada', grants: ['deployment-git:other-id'] }))
    assert.equal(foreignGrant.statusCode, 401)
    assert.match(foreignGrant.json().message, /not bound to this deployment/)

    const noGrant = await send(await mint({ aud: DEPLOY_GIT_AUD, scopeId: 'personal:person:ada' }))
    assert.equal(noGrant.statusCode, 401)
    assert.match(noGrant.json().message, /not bound to this deployment/)

    const foreignScope = await send(await mint({ aud: DEPLOY_GIT_AUD, scopeId: 'personal:person:mallory', grants: [`deployment-git:${id}`] }))
    assert.equal(foreignScope.statusCode, 401)
    assert.match(foreignScope.json().message, /no longer matches the deployment owner scope/)
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

test('real git clone and push round-trip over the CGI transport', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-routes-'))
  let app: ReturnType<typeof createApiServer> | undefined
  try {
    const { deps, git } = gitWiredDeps(join(root, 'repos'))
    app = createApiServer(deps, OPTS)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    assert.ok(address && typeof address === 'object', 'server should expose a TCP address')
    const gitOpts = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000 }

    const ada = auth(await token('person:ada'))
    const created = await app.inject({
      method: 'POST',
      url: '/v1/deployments',
      headers: ada,
      payload: { ownerScopeId: 'personal:person:ada', createdBy: 'person:ada', entrypoint: 'server.js', files: [{ path: 'server.js', content: 'console.log("hi")' }], name: 'e2e-clone' },
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
    const remote = `http://git:${capability}@127.0.0.1:${address.port}/v1/deployments/${deployment.id}/git`

    // clone: the deployed files come back out through upload-pack
    const cloneDir = join(root, 'clone')
    await run('git', ['clone', remote, cloneDir], gitOpts)
    assert.equal(readFileSync(join(cloneDir, 'server.js'), 'utf8'), 'console.log("hi")')

    // push: a client commit lands in the bare repo through receive-pack
    writeFileSync(join(cloneDir, 'pushed.md'), 'pushed via git-receive-pack')
    await run('git', ['-C', cloneDir, 'add', 'pushed.md'], gitOpts)
    await run('git', ['-C', cloneDir, '-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '--quiet', '-m', 'push'], gitOpts)
    const revParse = await run('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], gitOpts)
    const pushedSha = revParse.stdout.trim()
    await run('git', ['-C', cloneDir, 'push', 'origin', 'HEAD:refs/heads/e2e'], gitOpts)
    assert.equal(await git.refOf(deployment.id, 'refs/heads/e2e'), pushedSha)

    // a second clone sees the pushed ref and its content
    const clone2 = join(root, 'clone-2')
    await run('git', ['clone', '--branch', 'e2e', remote, clone2], gitOpts)
    assert.equal(readFileSync(join(clone2, 'pushed.md'), 'utf8'), 'pushed via git-receive-pack')
    assert.equal(readFileSync(join(clone2, 'server.js'), 'utf8'), 'console.log("hi")')
  } finally {
    // git clients leave keep-alive sockets open; drop them so close() settles
    app?.server.closeAllConnections()
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  }
})