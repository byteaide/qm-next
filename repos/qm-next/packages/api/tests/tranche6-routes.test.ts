/**
 * Tranche 6 route tests (11.0): files over the staged-blob flow, the grant
 * ledger (apply/revoke + the capability share gate), soul composition and
 * personal-scope writes, the runtime-config/surface-config/channel-pin
 * surface, deployment management (create/list/get/rollback/archive/restore/
 * rename + git-url 403, owner-url 503, fetch 502), the deployment-layer
 * bundle lane, connector token/status/revoke with unknown-provider 404s,
 * webhook CRUD with secret redaction and raw incoming deliveries (bad
 * signature 401, slack handshake, hmac 202), and raw blob staging.
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import {
  createApiServer,
  createMemoryBlobTransfer,
  createMemoryConnectorTokenStore,
  createMemoryDeploymentLayerStore,
  createMemoryDeploymentStore,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryRuntimeConfigStore,
  createMemorySoulStore,
  createMemoryWebhookStore,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../src/index.ts'

const SECRET = '[redacted-credential]'
const SCOPE: ScopeId = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

test('blobs: put with sha verification, hash mismatch 400, get octet-stream, missing 404', async () => {
  const blobTransfer = createMemoryBlobTransfer()
  const app = createApiServer({ ...baseDeps(), blobs: { blobTransfer } }, OPTS)
  const ada = auth(await token('person:ada'))
  const content = 'hello blob world'

  const bad = await app.inject({ method: 'POST', url: '/v1/blobs', headers: { ...ada, 'content-type': 'application/octet-stream', 'x-content-sha256': 'deadbeef' }, payload: content })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().error, 'hash_mismatch')

  const put = await app.inject({ method: 'POST', url: '/v1/blobs', headers: { ...ada, 'content-type': 'application/octet-stream', 'x-content-sha256': sha256(content) }, payload: content })
  assert.equal(put.statusCode, 200)
  const { blobId, sizeBytes } = put.json()
  assert.equal(sizeBytes, Buffer.byteLength(content))

  const get = await app.inject({ method: 'GET', url: `/v1/blobs/${blobId}`, headers: ada })
  assert.equal(get.statusCode, 200)
  assert.equal(get.headers['content-type'], 'application/octet-stream')
  assert.equal(get.body, content)

  const missing = await app.inject({ method: 'GET', url: '/v1/blobs/nope', headers: ada })
  assert.equal(missing.statusCode, 404)
  await app.close()
})

test('files: staged upload, list, inline content, wrong-context 403, staged-missing 404', async () => {
  const blobTransfer = createMemoryBlobTransfer()
  const grants = createMemoryGrantLedger()
  const files = createMemoryFileStore({ blobTransfer, grants })
  const app = createApiServer({ ...baseDeps(), blobs: { blobTransfer }, files: { files, blobTransfer } }, OPTS)
  const ada = auth(await token('person:ada'))
  const blobby = auth(await token('person:bob'))

  const noPrincipal = await app.inject({ method: 'POST', url: '/v1/files/upload', headers: ada, payload: { blobId: 'b', name: 'n' } })
  assert.equal(noPrincipal.statusCode, 400)

  const staged = await app.inject({ method: 'POST', url: '/v1/blobs', headers: { ...ada, 'x-content-sha256': sha256('report') }, payload: 'report' })
  const blobId = staged.json().blobId

  const ghost = await app.inject({ method: 'POST', url: '/v1/files/upload', headers: ada, payload: { principalId: 'person:ada', blobId: 'missing', name: 'log.txt' } })
  assert.equal(ghost.statusCode, 404)
  assert.equal(ghost.json().message, 'staged blob not found')

  const stagedForBob = await app.inject({ method: 'POST', url: '/v1/blobs', headers: { ...blobby, 'x-content-sha256': sha256('bob note') }, payload: 'bob note' })
  const bobUpload = await app.inject({ method: 'POST', url: '/v1/files/upload', headers: blobby, payload: { principalId: 'person:bob', blobId: stagedForBob.json().blobId, name: 'bob.txt' } })
  assert.equal(bobUpload.statusCode, 200)
  assert.equal(bobUpload.json().file.principalId, 'person:bob')

  const otherScope = await app.inject({ method: 'POST', url: '/v1/files/upload', headers: blobby, payload: { principalId: 'person:bob', blobId: stagedForBob.json().blobId, name: 'nope.txt', scopeId: `personal:person:ada` } })
  assert.equal(otherScope.statusCode, 404, 'the staged blob was consumed; 404 fires before the scope check')

  const upload = await app.inject({ method: 'POST', url: '/v1/files/upload', headers: ada, payload: { principalId: 'person:ada', blobId, name: 'log.txt' } })
  assert.equal(upload.statusCode, 200)
  const usedBlob = await app.inject({ method: 'GET', url: `/v1/blobs/${blobId}`, headers: ada })
  assert.equal(usedBlob.statusCode, 404, 'staged blob is consumed by the upload')

  const staged2 = await app.inject({ method: 'POST', url: '/v1/blobs', headers: { ...ada, 'x-content-sha256': sha256('second file') }, payload: 'second file' })
  const upload2 = await app.inject({ method: 'POST', url: '/v1/files/upload', headers: ada, payload: { principalId: 'person:ada', blobId: staged2.json().blobId, name: 'notes.md', mimetype: 'text/markdown' } })
  assert.equal(upload2.statusCode, 200)

  const list = await app.inject({ method: 'GET', url: '/v1/files', headers: ada })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().files.length, 2)
  const notes = list.json().files.find((f: { name: string }) => f.name === 'notes.md')
  assert.ok(notes)

  const bobList = await app.inject({ method: 'GET', url: '/v1/files', headers: blobby })
  assert.deepEqual(bobList.json().files.map((f: { name: string }) => f.name), ['bob.txt'])

  const fileId = notes.id
  const content = await app.inject({ method: 'GET', url: `/v1/files/${fileId}/content`, headers: ada })
  assert.equal(content.statusCode, 200)
  assert.equal(content.body, 'second file')
  assert.match(String(content.headers['content-disposition']), /filename\*=UTF-8''notes\.md/)

  const bobRead = await app.inject({ method: 'GET', url: `/v1/files/${fileId}/content`, headers: blobby })
  assert.equal(bobRead.statusCode, 404)
  await app.close()
})

test('grants: apply/revoke ladder, invalid bodies, share capability 403', async () => {
  const grants = createMemoryGrantLedger()
  const app = createApiServer({ ...baseDeps(), grants: { grants, orgScope: 'org:default' } }, OPTS)
  const ada = auth(await token('person:ada'))

  const bad = await app.inject({ method: 'POST', url: '/v1/grants', headers: ada, payload: { ownerScopeId: 'personal:person:ada' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().message, 'expected a Grant')

  const ok = await app.inject({
    method: 'POST',
    url: '/v1/grants',
    headers: ada,
    payload: { ownerScopeId: 'personal:person:ada', ref: 'file:1', granteeScopeId: 'org:default', permission: 'read', grantedBy: 'person:ada' },
  })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json(), { ok: true })

  const badRevoke = await app.inject({ method: 'POST', url: '/v1/grants/revoke', headers: ada, payload: { ownerScopeId: 'personal:person:ada', ref: 'file:1', granteeScopeId: 'org:default' } })
  assert.equal(badRevoke.statusCode, 400)
  assert.equal(badRevoke.json().message, 'ownerScopeId, ref, granteeScopeId, revokedBy required')

  const revoke = await app.inject({ method: 'POST', url: '/v1/grants/revoke', headers: ada, payload: { ownerScopeId: 'personal:person:ada', ref: 'file:1', granteeScopeId: 'org:default', revokedBy: 'person:ada' } })
  assert.deepEqual(revoke.json(), { ok: true })

  const revokeMissing = await app.inject({ method: 'POST', url: '/v1/grants/revoke', headers: ada, payload: { ownerScopeId: 'personal:person:ada', ref: 'file:9', granteeScopeId: 'org:default', revokedBy: 'person:ada' } })
  assert.equal(revokeMissing.statusCode, 400)
  assert.equal(revokeMissing.json().error, 'revoke_failed')

  const share = await app.inject({ method: 'POST', url: '/v1/share', headers: ada, payload: { type: 'file', id: '1', toScope: 'org' } })
  assert.equal(share.statusCode, 403)
  assert.equal(share.json().message, 'sharing requires an agent capability token')
  await app.close()
})

test('soul: org composition, personal write versions, foreign scope 403', async () => {
  const soul = createMemorySoulStore('default')
  soul.setSoul('org:default', 'Be concise.')
  const app = createApiServer({ ...baseDeps(), soul: { soul } }, OPTS)
  const ada = auth(await token('person:ada'))

  const noScope = await app.inject({ method: 'GET', url: '/v1/soul', headers: ada })
  assert.equal(noScope.statusCode, 400)
  assert.equal(noScope.json().message, 'scopeId required')

  const read = await app.inject({ method: 'GET', url: '/v1/soul?scopeId=personal:person:ada', headers: ada })
  assert.equal(read.statusCode, 200)
  const body = read.json()
  assert.equal(body.soul, null)
  assert.equal(body.orgSoul, 'Be concise.')
  assert.ok(body.effectiveSoul.includes('Be concise.'))

  const missing = await app.inject({ method: 'POST', url: '/v1/soul', headers: ada, payload: { scopeId: 'personal:person:ada' } })
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.json().message, 'scopeId, content, actorId required')

  const write = await app.inject({ method: 'POST', url: '/v1/soul', headers: ada, payload: { scopeId: 'personal:person:ada', content: 'Own voice.', actorId: 'person:ada' } })
  assert.equal(write.statusCode, 200)
  assert.deepEqual(write.json(), { ok: true, version: 1 })

  const reread = await app.inject({ method: 'GET', url: '/v1/soul?scopeId=personal:person:ada', headers: ada })
  assert.equal(reread.json().soul, 'Own voice.')
  assert.equal(reread.json().soulVersion, 1)
  assert.ok(reread.json().effectiveSoul.includes('Lower-scope instructions'))
  assert.ok(reread.json().effectiveSoul.includes('Own voice.'))

  const foreign = await app.inject({ method: 'POST', url: '/v1/soul', headers: ada, payload: { scopeId: 'personal:person:bob', content: 'hijack', actorId: 'person:ada' } })
  assert.equal(foreign.statusCode, 403)
  assert.equal(foreign.json().error, 'soul_update_denied')
  await app.close()
})

test('config: surface-config defaults, runtime-config ladder, channel-header-pin', async () => {
  const config = createMemoryRuntimeConfigStore()
  const app = createApiServer({ ...baseDeps(), config: { config, surfaceConfig: { baseModel: 'claude-opus-5' } } }, OPTS)
  const ada = auth(await token('person:ada'))

  const surface = await app.inject({ method: 'GET', url: '/v1/surface-config', headers: ada })
  assert.equal(surface.statusCode, 200)
  assert.equal(surface.json().harnessId, 'pi')
  assert.equal(surface.json().baseModel, 'claude-opus-5')
  assert.ok(Array.isArray(surface.json().webuiModels))
  assert.ok(surface.json().webuiModels.includes('claude-opus-5'))

  const forbidden = await app.inject({ method: 'GET', url: '/v1/runtime-config', headers: ada })
  assert.equal(forbidden.statusCode, 403)

  const get = await app.inject({ method: 'GET', url: '/v1/runtime-config?principalId=person:ada&scopeId=personal:person:ada', headers: ada })
  assert.equal(get.statusCode, 200)
  const body = get.json()
  assert.equal(body.scopeId, 'personal:person:ada')
  assert.equal(body.effective.harnessId, 'pi')
  assert.deepEqual(body.approvedHarnesses, ['pi'])
  assert.ok(body.fastModeModelIds.includes('claude-opus-5'))

  const badHarness = await app.inject({ method: 'PUT', url: '/v1/runtime-config', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', harnessId: 'codex', modelId: 'gpt-5.6-sol' } })
  assert.equal(badHarness.statusCode, 400)
  assert.equal(badHarness.json().error, 'harness_not_approved')

  const badModel = await app.inject({ method: 'PUT', url: '/v1/runtime-config', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', harnessId: 'pi', modelId: 'nonexistent-model' } })
  assert.equal(badModel.statusCode, 400)
  assert.equal(badModel.json().error, 'model_not_supported')

  const badEffort = await app.inject({ method: 'PUT', url: '/v1/runtime-config', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', harnessId: 'pi', modelId: 'claude-opus-5', effortLevel: 'maximum' } })
  assert.equal(badEffort.statusCode, 400)
  assert.equal(badEffort.json().error, 'effort_not_supported')

  const put = await app.inject({ method: 'PUT', url: '/v1/runtime-config', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', harnessId: 'pi', modelId: 'claude-opus-5', effortLevel: 'high', fastMode: true } })
  assert.equal(put.statusCode, 200)
  assert.equal(put.json().effective.modelId, 'claude-opus-5')
  assert.equal(put.json().effective.effortLevel, 'high')
  assert.equal(put.json().effective.fastMode, true)
  assert.equal(put.json().scopeOverride.modelId, 'claude-opus-5')
  assert.equal(put.json().scopeOverride.orgRevision, 0)

  const inherit = await app.inject({ method: 'PUT', url: '/v1/runtime-config', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', inherit: true } })
  assert.equal(inherit.json().scopeOverride, null)

  const pinForbidden = await app.inject({ method: 'GET', url: '/v1/channel-header-pin', headers: ada })
  assert.equal(pinForbidden.statusCode, 403)

  const pinGet = await app.inject({ method: 'GET', url: '/v1/channel-header-pin?principalId=person:ada&scopeId=personal:person:ada', headers: ada })
  assert.equal(pinGet.statusCode, 200)
  assert.equal(pinGet.json().on, false)
  assert.equal(pinGet.json().default, false)

  const pinBad = await app.inject({ method: 'PUT', url: '/v1/channel-header-pin', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', on: 'yes' } })
  assert.equal(pinBad.statusCode, 400)
  assert.equal(pinBad.json().message, 'expected { on: boolean | null } (null reverts to the org default)')

  const pinPut = await app.inject({ method: 'PUT', url: '/v1/channel-header-pin', headers: ada, payload: { principalId: 'person:ada', scopeId: 'personal:person:ada', on: true } })
  assert.equal(pinPut.statusCode, 200)
  assert.deepEqual(pinPut.json(), { scopeId: 'personal:person:ada', on: true, configured: true })
  await app.close()
})

test('deployments: create, viewer list/get, rollback ladder, archive/restore, rename, gates', async () => {
  const grants = createMemoryGrantLedger()
  const deployments = createMemoryDeploymentStore({ grants })
  const app = createApiServer({ ...baseDeps(), deployments: { deployments } }, OPTS)
  const ada = auth(await token('person:ada'))
  const blobby = auth(await token('person:bob'))

  const bad = await app.inject({ method: 'POST', url: '/v1/deployments', headers: ada, payload: { ownerScopeId: 'personal:person:ada' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().message, 'expected a DeployInput')

  const created = await app.inject({
    method: 'POST',
    url: '/v1/deployments',
    headers: ada,
    payload: { ownerScopeId: 'personal:person:ada', createdBy: 'person:ada', entrypoint: 'index.ts', files: [{ path: 'index.ts', content: 'export default 1' }], name: 'hello-app' },
  })
  assert.equal(created.statusCode, 200)
  const deployment = created.json().deployment
  assert.equal(deployment.name, 'hello-app')
  assert.equal(deployment.currentVersion, 1)

  const adaList = await app.inject({ method: 'GET', url: '/v1/deployments?principalId=person:ada', headers: ada })
  assert.equal(adaList.json().deployments.length, 1)
  assert.equal(adaList.json().deployments[0].permission, 'write')

  const bobList = await app.inject({ method: 'GET', url: '/v1/deployments?principalId=person:bob', headers: blobby })
  assert.equal(bobList.json().deployments.length, 0)

  const byName = await app.inject({ method: 'GET', url: '/v1/deployments/hello-app?principalId=person:ada', headers: ada })
  assert.equal(byName.json().deployment.id, deployment.id)

  const bobGet = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}?principalId=person:bob`, headers: blobby })
  assert.equal(bobGet.statusCode, 404)

  const missingRollback = await app.inject({ method: 'POST', url: '/v1/deployments/ghost/rollback', headers: ada, payload: { version: 1 } })
  assert.equal(missingRollback.statusCode, 404)

  const badRollback = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/rollback`, headers: ada, payload: { version: 'one' } })
  assert.equal(badRollback.statusCode, 400)
  assert.equal(badRollback.json().message, 'version (number) required')

  const futureRollback = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/rollback`, headers: ada, payload: { version: 9 } })
  assert.equal(futureRollback.statusCode, 400)
  assert.equal(futureRollback.json().error, 'rollback_failed')

  const okRollback = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/rollback`, headers: ada, payload: { version: 1 } })
  assert.deepEqual(okRollback.json(), { ok: true })

  const logs = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/logs?principalId=person:ada`, headers: ada })
  assert.equal(logs.statusCode, 200)
  assert.equal(logs.json().logs, null)
  assert.equal(logs.json().message, 'no logs available for this deployment')

  const badTail = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/logs?tailLines=9999`, headers: ada })
  assert.equal(badTail.statusCode, 400)
  assert.equal(badTail.json().message, 'tailLines must be an integer from 1 to 2000')

  const fetchNoViewer = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/fetch?path=/index.html`, headers: blobby })
  assert.equal(fetchNoViewer.statusCode, 502)

  const badPath = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/fetch?path=../etc/passwd&principalId=person:ada`, headers: ada })
  assert.equal(badPath.statusCode, 400)
  assert.equal(badPath.json().message, 'path must be a safe absolute path')

  const fetchOk = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/fetch?path=/index.html&principalId=person:ada`, headers: ada })
  assert.equal(fetchOk.statusCode, 502)
  assert.equal(fetchOk.json().error, 'upstream_unreachable')

  const gitUrl = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/git-url?principalId=person:ada`, headers: ada })
  assert.equal(gitUrl.statusCode, 403)
  assert.equal(gitUrl.json().message, 'a git URL requires an agent capability token')

  const ownerUrl = await app.inject({ method: 'GET', url: `/v1/deployments/${deployment.id}/owner-url?principalId=person:ada`, headers: ada })
  assert.equal(ownerUrl.statusCode, 503)
  assert.ok(String(ownerUrl.json().message).includes('DEPLOY_APPS_DOMAIN'))

  const share = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/share`, headers: ada, payload: { scope: 'org' } })
  assert.equal(share.statusCode, 403)
  assert.equal(share.json().message, 'sharing requires an agent capability token')

  const renamed = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/name`, headers: ada, payload: { principalId: 'person:ada', name: 'renamed-app' } })
  assert.equal(renamed.json().deployment.name, 'renamed-app')

  const displayName = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/display-name`, headers: ada, payload: { principalId: 'person:ada', displayName: 'Hello App' } })
  assert.equal(displayName.json().deployment.displayName, 'Hello App')

  const bobArchive = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/archive`, headers: blobby, payload: { principalId: 'person:bob' } })
  assert.equal(bobArchive.statusCode, 403)

  const archived = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/archive`, headers: ada, payload: { principalId: 'person:ada' } })
  assert.deepEqual(archived.json(), { ok: true })

  const restored = await app.inject({ method: 'POST', url: `/v1/deployments/${deployment.id}/restore`, headers: ada, payload: { principalId: 'person:ada' } })
  assert.equal(restored.json().deployment.status, 'live')
  assert.equal(restored.json().deployment.permission, 'write')
  await app.close()
})

test('deployment-layer: empty state, put, applied read, invalid bundle 400', async () => {
  const app = createApiServer({ ...baseDeps(), deploymentLayer: { deploymentLayer: createMemoryDeploymentLayerStore() } }, OPTS)
  const ada = auth(await token('person:ada'))

  const empty = await app.inject({ method: 'GET', url: '/v1/deployment-layer', headers: ada })
  assert.equal(empty.statusCode, 200)
  assert.equal(empty.json().version, 0)
  assert.equal(empty.json().source, 'builtin')

  const bad = await app.inject({ method: 'PUT', url: '/v1/deployment-layer', headers: ada, payload: { contract: 2 } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().message, 'contract: 1, tools[], and skills[] required')

  const put = await app.inject({ method: 'PUT', url: '/v1/deployment-layer', headers: ada, payload: { contract: 1, tools: [{ id: 'shell' }], skills: ['deploy'] } })
  assert.equal(put.statusCode, 200)
  const body = put.json()
  assert.equal(body.ok, true)
  assert.equal(body.version, 1)
  assert.equal(body.durable, true)
  assert.ok(typeof body.contentHash === 'string' && body.contentHash.length === 64)

  const read = await app.inject({ method: 'GET', url: '/v1/deployment-layer', headers: ada })
  assert.equal(read.json().status, 'applied')
  assert.equal(read.json().updatedBy, 'source-authenticated deployment CLI')
  assert.equal(read.json().bundle.skills[0], 'deploy')
  await app.close()
})

test('connectors: token register + status, revoke by host, unknown provider 404, consent unwired 404', async () => {
  const tokens = createMemoryConnectorTokenStore()
  const app = createApiServer({ ...baseDeps(), connectors: { tokens } }, OPTS)
  const ada = auth(await token('person:ada'))

  const badExpiry = await app.inject({ method: 'POST', url: '/v1/connectors/token', headers: ada, payload: { host: 'github.com', principalId: 'person:ada', accessToken: 'tok', expiresAt: 'not-a-date' } })
  assert.equal(badExpiry.statusCode, 400)
  assert.equal(badExpiry.json().message, 'expiresAt must be an epoch timestamp in seconds or milliseconds, or an ISO date string')

  const missing = await app.inject({ method: 'POST', url: '/v1/connectors/token', headers: ada, payload: { host: 'github.com' } })
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.json().message, 'host, principalId, accessToken required')

  const set = await app.inject({ method: 'POST', url: '/v1/connectors/token', headers: ada, payload: { host: 'github.com', principalId: 'person:ada', accessToken: 'tok' } })
  assert.deepEqual(set.json(), { ok: true })

  const status = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status?principalId=person:ada', headers: ada })
  assert.equal(status.statusCode, 200)
  assert.deepEqual(status.json(), { principalId: 'person:ada', providers: {} })

  const noStatus = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status', headers: ada })
  assert.equal(noStatus.statusCode, 400)
  assert.equal(noStatus.json().message, 'principalId required')

  const revokeProvider = await app.inject({ method: 'POST', url: '/v1/connectors/oauth/revoke', headers: ada, payload: { principalId: 'person:ada', provider: 'github' } })
  assert.equal(revokeProvider.statusCode, 404)
  assert.equal(revokeProvider.json().message, 'unknown OAuth provider: github')

  const missingRevoke = await app.inject({ method: 'POST', url: '/v1/connectors/oauth/revoke', headers: ada, payload: { principalId: 'person:ada' } })
  assert.equal(missingRevoke.statusCode, 400)
  assert.equal(missingRevoke.json().message, 'principalId and provider or host required')

  const revokeHost = await app.inject({ method: 'POST', url: '/v1/connectors/oauth/revoke', headers: ada, payload: { principalId: 'person:ada', host: 'github.com' } })
  assert.deepEqual(revokeHost.json(), { ok: true, principalId: 'person:ada', host: 'github.com' })

  const catalog = await app.inject({ method: 'GET', url: '/v1/connectors/catalog', headers: ada })
  assert.deepEqual(catalog.json(), { catalog: [] })

  const start = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/notion/start?principalId=person:ada&redirectUri=https://x/cb', headers: ada })
  assert.equal(start.statusCode, 404)
  assert.equal(start.json().message, 'unknown OAuth provider: notion')

  const consentMint = await app.inject({ method: 'POST', url: '/v1/connectors/oauth/consent/mint', headers: ada, payload: { provider: 'github' } })
  assert.equal(consentMint.statusCode, 401, 'audience oauth-consent required rejects ordinary tokens')

  const redeem = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/consent/redeem/abc', headers: ada })
  assert.equal(redeem.statusCode, 404)

  const callback = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/github/callback?error=access_denied' })
  assert.equal(callback.statusCode, 400)
  assert.equal(callback.json().error, 'oauth_denied')

  const callbackMissing = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/github/callback' })
  assert.equal(callbackMissing.statusCode, 400)
  assert.equal(callbackMissing.json().message, 'code and state required')

  const callbackBadState = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/github/callback?code=c&state=stale' })
  assert.equal(callbackBadState.statusCode, 400)
  assert.equal(callbackBadState.json().error, 'oauth_callback_failed')
  await app.close()
})

test('webhooks: create, redacted list, enable/disable guards, raw incoming ladder', async () => {
  const webhooks = createMemoryWebhookStore()
  const app = createApiServer({ ...baseDeps(), webhooks: { webhooks } }, OPTS)
  const ada = auth(await token('person:ada'))
  const blobby = auth(await token('person:bob'))

  const bad = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: ada, payload: { ownerScopeId: 'personal:person:ada', owner: 'person:ada', createdBy: 'person:ada', action: 'notify', verification: { scheme: 'bogus', secret: 's' } } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().message, 'expected a CreateWebhookInput')

  const created = await app.inject({
    method: 'POST',
    url: '/v1/webhooks',
    headers: ada,
    payload: { ownerScopeId: 'personal:person:ada', owner: 'person:ada', createdBy: 'person:ada', action: 'notify', verification: { scheme: 'hmac-sha256', secret: 'sekrit' } },
  })
  assert.equal(created.statusCode, 200)
  const webhook = created.json().webhook
  assert.equal(webhook.verification.secret, 'sekrit', 'the create response is not redacted (qm parity)')
  assert.match(String(created.json().url), new RegExp(`/v1/webhooks/incoming/${webhook.id}`))

  const list = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: ada })
  assert.equal(list.json().webhooks[0].verification.secret, '***', 'listings redact the secret')

  const bobList = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: blobby })
  assert.equal(bobList.json().webhooks.length, 0)

  const strangerDisable = await app.inject({ method: 'POST', url: `/v1/webhooks/${webhook.id}/disable`, headers: blobby })
  assert.equal(strangerDisable.statusCode, 403)
  assert.equal(strangerDisable.json().message, 'not your webhook')

  const anonymousDisable = await app.inject({ method: 'POST', url: `/v1/webhooks/${webhook.id}/disable?principalId=person:stranger` })
  assert.equal(anonymousDisable.statusCode, 404)

  const disable = await app.inject({ method: 'POST', url: `/v1/webhooks/${webhook.id}/disable`, headers: ada })
  assert.deepEqual(disable.json(), { ok: true })
  const disabledIncoming = await app.inject({ method: 'POST', url: `/v1/webhooks/incoming/${webhook.id}`, headers: { 'x-signature': 'nope' }, payload: 'x' })
  assert.equal(disabledIncoming.statusCode, 404)

  await app.inject({ method: 'POST', url: `/v1/webhooks/${webhook.id}/enable`, headers: ada })
  const badSignature = await app.inject({ method: 'POST', url: `/v1/webhooks/incoming/${webhook.id}`, payload: 'payload' })
  assert.equal(badSignature.statusCode, 401)
  assert.equal(badSignature.json().error, 'unauthorized')

  const goodSig = createHmac('sha256', 'sekrit').update('payload').digest('hex')
  const accepted = await app.inject({ method: 'POST', url: `/v1/webhooks/incoming/${webhook.id}`, headers: { 'x-signature': `sha256=${goodSig}` }, payload: 'payload' })
  assert.equal(accepted.statusCode, 202)
  assert.deepEqual(accepted.json(), { ok: true })

  const missingIncoming = await app.inject({ method: 'POST', url: '/v1/webhooks/incoming/none', payload: 'x' })
  assert.equal(missingIncoming.statusCode, 404)
  await app.close()
})

test('webhooks: slack url_verification handshake echoes the challenge', async () => {
  const webhooks = createMemoryWebhookStore()
  const app = createApiServer({ ...baseDeps(), webhooks: { webhooks } }, OPTS)
  const ada = auth(await token('person:ada'))
  const created = await app.inject({
    method: 'POST',
    url: '/v1/webhooks',
    headers: ada,
    payload: { ownerScopeId: 'personal:person:ada', owner: 'person:ada', createdBy: 'person:ada', action: 'notify', verification: { scheme: 'slack', secret: 'sekrit' } },
  })
  const id = created.json().webhook.id
  const payload = JSON.stringify({ type: 'url_verification', challenge: 'tok-123' })
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = createHmac('sha256', 'sekrit').update(`v0:${ts}:${payload}`).digest('hex')
  const handshake = await app.inject({
    method: 'POST',
    url: `/v1/webhooks/incoming/${id}`,
    headers: { 'x-slack-signature': `v0=${sig}`, 'x-slack-request-timestamp': ts },
    payload,
  })
  assert.equal(handshake.statusCode, 200)
  assert.equal(handshake.body, 'tok-123')
  await app.close()
})

