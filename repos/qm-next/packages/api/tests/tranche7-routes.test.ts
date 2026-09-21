/**
 * Tranche 7 route tests (11.0): the qm admin guard ladder (404 unwired /
 * 400 missing scope / 403 non-admin), whoami + grants (org-admin
 * vocabulary incl. the last-admin guard), admin skills/memory/files,
 * slack-installation lifecycle, the skill-pack registry with the lane-A
 * fetch gate, per-principal model credentials, secret drops (mint 401,
 * form/redeem ladder), the emoji gate, egress audit ingest + admin view,
 * and the auth-broker 503/email gates.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createMemoryScopeMemory } from '@qm/memory'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemorySkillStore } from '@qm/skills'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import {
  adminRoutes,
  createApiServer,
  createMemoryAdminService,
  createMemoryAuditLog,
  createMemoryBlobTransfer,
  createMemoryEgressAuditSink,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemorySecretDropStore,
  createMemorySkillPackStore,
  createMemoryUserModelCredentialsStore,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../src/index.ts'
import { mintCapabilityToken, SECRET_DROP_AUD } from '@qm/auth'
import { createEmojiUploadService } from '@qm/connectors'
import { createMemoryByteStore } from '@qm/store'

const SECRET = '[redacted-credential]'
const SCOPE: ScopeId = 'org:test'
const ORG = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

async function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
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

function adminDeps(overrides: Partial<Parameters<typeof adminRoutes>[0]> = {}): Parameters<typeof adminRoutes>[0] {
  return {
    admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }),
    orgScope: ORG,
    ...overrides,
  }
}

test('admin: guard ladder (unwired 404, non-admin 403, missing scope 400) and whoami', async () => {
  const noAdmin = createApiServer({ ...baseDeps() }, OPTS)
  const ada = auth(await token('person:ada'))
  const unwired = await noAdmin.inject({ method: 'GET', url: '/v1/admin/whoami', headers: ada })
  assert.equal(unwired.statusCode, 404)
  await noAdmin.close()

  const app = createApiServer({ ...baseDeps(), admin: adminDeps() }, OPTS)
  const noToken = await app.inject({ method: 'GET', url: '/v1/admin/whoami' })
  assert.equal(noToken.statusCode, 200)
  assert.deepEqual(noToken.json(), { isAdmin: false, permissions: [] })

  const stranger = auth(await token('person:stranger'))
  const forbidden = await app.inject({ method: 'GET', url: '/v1/admin/whoami', headers: stranger })
  assert.deepEqual(forbidden.json(), { isAdmin: false, permissions: [] })

  const missingScope = await app.inject({ method: 'GET', url: '/v1/admin/metrics', headers: ada })
  assert.equal(missingScope.statusCode, 400)
  assert.equal(missingScope.json().message, 'scope required')

  const usersNoScope = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: ada })
  assert.equal(usersNoScope.statusCode, 200, 'qm listUsers is org-wide; no scope required')

  const scopedForbidden = await app.inject({ method: 'GET', url: `/v1/admin/users?scope=${ORG}`, headers: stranger })
  assert.equal(scopedForbidden.statusCode, 403)
  assert.equal(scopedForbidden.json().message, 'admin grant required for this scope')

  const whoami = await app.inject({ method: 'GET', url: '/v1/admin/whoami', headers: ada })
  assert.equal(whoami.json().isAdmin, true)
  assert.equal(whoami.json().role, 'org_admin')
  assert.deepEqual(whoami.json().permissions, ['admin'])
  await app.close()
})

test('admin: grants create/revoke with org-admin vocabulary and the last-admin guard', async () => {
  const app = createApiServer({ ...baseDeps(), admin: adminDeps() }, OPTS)
  const ada = auth(await token('person:ada'))

  const notAdmin = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: auth(await token('person:evil')), payload: { principalId: 'person:x', role: 'org_admin', scopeId: ORG } })
  assert.equal(notAdmin.statusCode, 403)

  const badScope = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: ada, payload: { principalId: 'person:bob', role: 'org_admin', scopeId: 'org:other' } })
  assert.equal(badScope.statusCode, 400)
  assert.equal(badScope.json().message, 'org_admin scope must be org:test')

  const granted = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: ada, payload: { principalId: 'person:bob', role: 'org_admin', scopeId: ORG } })
  assert.equal(granted.statusCode, 200)
  assert.equal(granted.json().grant.principalId, 'person:bob')
  assert.equal(granted.json().grant.grantedBy, 'person:ada')

  const bob = auth(await token('person:bob'))
  const bobWhoami = await app.inject({ method: 'GET', url: '/v1/admin/whoami', headers: bob })
  assert.equal(bobWhoami.json().isAdmin, true)

  const badRevoke = await app.inject({ method: 'DELETE', url: `/v1/admin/grants/person:bob?scope=${ORG}&role=admin`, headers: ada })
  assert.equal(badRevoke.statusCode, 400)
  assert.equal(badRevoke.json().message, 'principalId (path), and scope + role=org_admin (query) required')

  const revoked = await app.inject({ method: 'DELETE', url: `/v1/admin/grants/person:bob?scope=${ORG}&role=org_admin`, headers: ada })
  assert.deepEqual(revoked.json(), { ok: true })

  const lastAdmin = await app.inject({ method: 'DELETE', url: `/v1/admin/grants/person:ada?scope=${ORG}&role=org_admin`, headers: ada })
  assert.equal(lastAdmin.statusCode, 400)
  assert.equal(lastAdmin.json().message, 'cannot revoke the last org admin')

  const users = await app.inject({ method: 'GET', url: `/v1/admin/users?scope=${ORG}`, headers: ada })
  assert.equal(users.statusCode, 200)
  assert.equal(users.json().scopeId, ORG)
  assert.ok(users.json().users.some((u: { principalId: string }) => u.principalId === 'person:ada'))
  await app.close()
})

test('admin: skills list/detail/archive, memory read/write, slack-installation lifecycle', async () => {
  const skills = createMemorySkillStore()
  const memory = createMemoryScopeMemory()
  const app = createApiServer(
    {
      ...baseDeps(),
      admin: adminDeps({ skills, memory, auditLog: createMemoryAuditLog() }),
    },
    OPTS,
  )
  const ada = auth(await token('person:ada'))
  const skill = await skills.register({
    scopeId: 'personal:person:ada' as ScopeId,
    name: 'deploy-help',
    description: 'helps deploy',
    body: 'do the deploy',
    createdBy: 'person:ada',
  })

  const list = await app.inject({ method: 'GET', url: `/v1/admin/skills?scope=${ORG}`, headers: ada })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().skills.length, 1)
  assert.equal(list.json().skills[0].name, 'deploy-help')

  const detail = await app.inject({ method: 'GET', url: `/v1/admin/skills/${skill.id}`, headers: ada })
  assert.equal(detail.statusCode, 200)
  assert.equal(detail.json().body, 'do the deploy')

  const archive = await app.inject({ method: 'DELETE', url: `/v1/admin/skills/${skill.id}`, headers: ada })
  assert.deepEqual(archive.json(), { ok: true })
  const archived = await skills.get(skill.id)
  assert.equal(archived?.status, 'archived')

  const noContent = await app.inject({ method: 'PUT', url: `/v1/admin/memory?scope=${ORG}`, headers: ada, payload: {} })
  assert.equal(noContent.statusCode, 400)
  assert.equal(noContent.json().message, 'memory requires { content: string }')

  await app.inject({ method: 'PUT', url: `/v1/admin/memory?scope=${ORG}`, headers: ada, payload: { content: 'org memory' } })
  const mem = await app.inject({ method: 'GET', url: `/v1/admin/memory?scope=${ORG}`, headers: ada })
  assert.equal(mem.json().content.trim(), 'org memory')

  const scopes = await app.inject({ method: 'GET', url: `/v1/admin/memory/scopes?scope=${ORG}`, headers: ada })
  assert.equal(scopes.statusCode, 200)
  assert.ok(scopes.json().scopes.some((s: { scopeId: string; hasMemory: boolean }) => s.scopeId === ORG && s.hasMemory))

  const badInstall = await app.inject({ method: 'PUT', url: '/v1/admin/slack-installation', headers: ada, payload: { botToken: 'x' } })
  assert.equal(badInstall.statusCode, 400)
  assert.equal(badInstall.json().error, 'invalid_slack_installation')

  const missingInstall = await app.inject({ method: 'GET', url: '/v1/admin/slack-installation', headers: ada })
  assert.equal(missingInstall.statusCode, 404)

  await app.inject({ method: 'PUT', url: '/v1/admin/slack-installation', headers: ada, payload: { botToken: 'xoxb', teamId: 'T1', teamName: 'Acme' } })
  const install = await app.inject({ method: 'GET', url: '/v1/admin/slack-installation', headers: ada })
  assert.equal(install.json().configured, undefined)
  assert.equal(install.json().source, 'admin')
  assert.equal(install.json().teamId, 'T1')

  const removed = await app.inject({ method: 'DELETE', url: '/v1/admin/slack-installation', headers: ada })
  assert.equal(removed.json().configured, false)
  const gone = await app.inject({ method: 'GET', url: '/v1/admin/slack-installation', headers: ada })
  assert.equal(gone.statusCode, 404)

  const audit = await app.inject({ method: 'GET', url: `/v1/admin/audit?scope=${ORG}`, headers: ada })
  assert.equal(audit.statusCode, 200)
  assert.ok(Array.isArray(audit.json().events))
  await app.close()
})

test('admin: staged-blob file upload + list + read', async () => {
  const blobTransfer = createMemoryBlobTransfer()
  const grants = createMemoryGrantLedger()
  const files = createMemoryFileStore({ blobTransfer, grants })
  const app = createApiServer({ ...baseDeps(), admin: adminDeps({ files, blobTransfer }), blobs: { blobTransfer }, files: { files, blobTransfer } }, OPTS)
  const ada = auth(await token('person:ada'))

  const missingBlob = await app.inject({ method: 'POST', url: '/v1/admin/files/upload?scope=personal:person:ada', headers: ada, payload: { name: 'x.txt' } })
  assert.equal(missingBlob.statusCode, 400)
  assert.equal(missingBlob.json().message, 'blobId required')

  const staged = await app.inject({ method: 'POST', url: '/v1/blobs', headers: { ...ada, 'x-content-sha256': sha256('admin file') }, payload: 'admin file' })
  const upload = await app.inject({ method: 'POST', url: '/v1/admin/files/upload?scope=personal:person:ada', headers: ada, payload: { blobId: staged.json().blobId, name: 'admin.txt', mimetype: 'text/plain' } })
  assert.equal(upload.statusCode, 200)
  assert.equal(upload.json().file.name, 'admin.txt')
  assert.equal(upload.json().file.scopeId, 'personal:person:ada')

  const list = await app.inject({ method: 'GET', url: '/v1/admin/files?scope=personal:person:ada', headers: ada })
  assert.equal(list.json().files.length, 1)
  assert.equal(list.json().files[0].name, 'admin.txt')

  const fileId = list.json().files[0].id
  const read = await app.inject({ method: 'GET', url: `/v1/admin/files/read?id=${fileId}`, headers: ada })
  assert.equal(read.statusCode, 200)
  assert.equal(read.json().content, 'admin file')
  assert.equal(read.json().truncated, false)

  const noId = await app.inject({ method: 'GET', url: '/v1/admin/files/read', headers: ada })
  assert.equal(noId.statusCode, 400)
  assert.equal(noId.json().message, 'id required')
  await app.close()
})

test('skill-packs: admin gate, register records the fetch-error import, catalog gate, remove', async () => {
  const packs = createMemorySkillPackStore()
  const app = createApiServer(
    {
      ...baseDeps(),
      skillPacks: { packs, orgScope: ORG, admins: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }) },
    },
    OPTS,
  )
  const ada = auth(await token('person:ada'))

  const forbidden = await app.inject({ method: 'GET', url: '/v1/admin/skill-packs', headers: auth(await token('person:stranger')) })
  assert.equal(forbidden.statusCode, 403)

  const noUrl = await app.inject({ method: 'POST', url: '/v1/admin/skill-packs', headers: ada, payload: {} })
  assert.equal(noUrl.statusCode, 400)
  assert.equal(noUrl.json().message, 'url is required')

  const badSubset = await app.inject({ method: 'POST', url: '/v1/admin/skill-packs', headers: ada, payload: { url: 'https://example/pack', subset: 3 } })
  assert.equal(badSubset.statusCode, 400)
  assert.equal(badSubset.json().message, "subset must be 'all' or string[]")

  const created = await app.inject({ method: 'POST', url: '/v1/admin/skill-packs', headers: ada, payload: { url: 'https://example/pack', trustTier: 'internal' } })
  assert.equal(created.statusCode, 200)
  const pack = created.json().pack
  assert.equal(pack.trustTier, 'internal')
  assert.equal(pack.syncMode, 'pinned')
  assert.equal(pack.lastImport, undefined, 'register does not auto-fetch; the catalog route is the fetch entry')

  const list = await app.inject({ method: 'GET', url: '/v1/admin/skill-packs', headers: ada })
  assert.equal(list.json().packs[0].importedCount, 0)

  const catalog = await app.inject({ method: 'GET', url: `/v1/admin/skill-packs/${pack.id}/catalog`, headers: ada })
  assert.equal(catalog.statusCode, 400)
  assert.equal(catalog.json().message, 'git pack fetching is not available in this deployment')

  const imported = await app.inject({ method: 'POST', url: `/v1/admin/skill-packs/${pack.id}/import`, headers: ada, payload: { selected: 'all' } })
  assert.equal(imported.statusCode, 400)

  const patched = await app.inject({ method: 'PATCH', url: `/v1/admin/skill-packs/${pack.id}`, headers: ada, payload: { ref: 'v2', syncMode: 'tracked' } })
  assert.equal(patched.json().pack.ref, 'v2')
  assert.equal(patched.json().pack.syncMode, 'tracked')

  const removed = await app.inject({ method: 'DELETE', url: `/v1/admin/skill-packs/${pack.id}`, headers: ada })
  assert.deepEqual(removed.json(), { removed: 0 })
  await app.close()
})

test('user-model-auth: identity gate, api-key connect/disconnect, oauth 502 gates', async () => {
  const credentials = createMemoryUserModelCredentialsStore()
  const app = createApiServer({ ...baseDeps(), userModelAuth: { credentials } }, OPTS)
  const ada = auth(await token('person:ada'))

  const noToken = await app.inject({ method: 'GET', url: '/v1/user-model-auth/status' })
  assert.equal(noToken.statusCode, 401)
  assert.equal(noToken.json().error, 'unauthorized')

  const status = await app.inject({ method: 'GET', url: '/v1/user-model-auth/status', headers: ada })
  assert.deepEqual(status.json(), { individualModelAuth: false, connections: [] })

  const badProvider = await app.inject({ method: 'POST', url: '/v1/user-model-auth/api-key', headers: ada, payload: { provider: 'gemini', apiKey: 'k' } })
  assert.equal(badProvider.statusCode, 400)
  assert.equal(badProvider.json().message, 'provider must be claude or chatgpt')

  const noKey = await app.inject({ method: 'POST', url: '/v1/user-model-auth/api-key', headers: ada, payload: { provider: 'claude' } })
  assert.equal(noKey.statusCode, 400)
  assert.equal(noKey.json().message, 'API key is required')

  await app.inject({ method: 'POST', url: '/v1/user-model-auth/api-key', headers: ada, payload: { provider: 'chatgpt', apiKey: 'sk-key' } })
  const connected = await app.inject({ method: 'GET', url: '/v1/user-model-auth/status', headers: ada })
  assert.deepEqual(connected.json().connections, [{ provider: 'openai', kind: 'api-key', connectedAt: connected.json().connections[0].connectedAt }])

  const pollNoId = await app.inject({ method: 'POST', url: '/v1/user-model-auth/chatgpt/poll', headers: ada, payload: {} })
  assert.equal(pollNoId.statusCode, 400)

  const poll = await app.inject({ method: 'POST', url: '/v1/user-model-auth/chatgpt/poll', headers: ada, payload: { deviceAuthId: 'd1' } })
  assert.equal(poll.statusCode, 502)
  assert.equal(poll.json().error, 'oauth_poll_failed')

  const claudeComplete = await app.inject({ method: 'POST', url: '/v1/user-model-auth/claude/complete', headers: ada, payload: { code: 'c' } })
  assert.equal(claudeComplete.statusCode, 400)

  await app.inject({ method: 'POST', url: '/v1/user-model-auth/disconnect', headers: ada, payload: { provider: 'chatgpt' } })
  const after = await app.inject({ method: 'GET', url: '/v1/user-model-auth/status', headers: ada })
  assert.deepEqual(after.json().connections, [])
  await app.close()
})

test('secret-drops: mint capability 401, form/redeem ladder, single-use redemption', async () => {
  const drops = createMemorySecretDropStore()
  const app = createApiServer({ ...baseDeps(), secretDrops: { drops, secrets: OPTS.secrets } }, OPTS)
  const ada = auth(await token('person:ada'))

  const mint = await app.inject({ method: 'POST', url: '/v1/keychain/drops', headers: ada, payload: { service: 'github', purpose: 'releases' } })
  assert.equal(mint.statusCode, 401)
  assert.equal(mint.json().message, 'secret-drop mint requires an agent capability token')

  const missingForm = await app.inject({ method: 'GET', url: '/v1/keychain/drops/none/form', headers: ada })
// Parity #47a: form without `?t=` capability token is 401 (fail closed), not 404.
  assert.equal(missingForm.statusCode, 401)

  const redeemedMissing = await app.inject({ method: 'POST', url: '/v1/keychain/drops/none', headers: ada, payload: { secret: 'redacted-credential' } })
  // Same: redeem without `?t=` (or body.t) capability token returns 401.
  assert.equal(redeemedMissing.statusCode, 401)
  assert.equal(redeemedMissing.json().message, 'secret-drop redeem requires the embedded capability token')

  const { dropId } = await drops.mint({
    ownerId: 'person:ada',
    orgId: 'test',
    service: 'github',
    purpose: 'release automation',
    fields: [{ key: 'GITHUB_TOKEN', label: 'GitHub token' }],
    requestedBy: 'person:ada',
  })

// Parity #47a: form / redeem require the embedded `?t=` capability token
  // minted at drop creation. The test mint-bypasses the route, so it mints
  // the token directly.
  const dropToken = await mintCapabilityToken(
    {
      aud: SECRET_DROP_AUD,
      actorId: 'person:ada',
      scopeId: 'personal:self',
      drop: dropId,
      exp: Date.now() + 5 * 60_000,
    },
    OPTS.secrets[0]!,
    'test',
  )

  const form = await app.inject({ method: 'GET', url: `/v1/keychain/drops/${dropId}/form?t=${dropToken}`, headers: ada })
  assert.equal(form.statusCode, 200)
  assert.match(form.body, /github/)
  assert.match(form.body, /release automation/)

  // Without the token: form is 401, redeem is 401.
  const formNoToken = await app.inject({ method: 'GET', url: `/v1/keychain/drops/${dropId}/form`, headers: ada })
  assert.equal(formNoToken.statusCode, 401)
  const redeemNoToken = await app.inject({ method: 'POST', url: `/v1/keychain/drops/${dropId}`, headers: ada, payload: { secret: 'value' } })
  assert.equal(redeemNoToken.statusCode, 401)

  const noValues = await app.inject({ method: 'POST', url: `/v1/keychain/drops/${dropId}?t=${dropToken}`, headers: ada, payload: {} })
  assert.equal(noValues.statusCode, 400)
  assert.equal(noValues.json().message, 'missing value for GITHUB_TOKEN')

  const ok = await app.inject({ method: 'POST', url: `/v1/keychain/drops/${dropId}?t=${dropToken}`, headers: ada, payload: { values: { GITHUB_TOKEN: 'supersecretvalue' } } })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().credential.service, 'github')

  const reuse = await app.inject({ method: 'POST', url: `/v1/keychain/drops/${dropId}?t=${dropToken}`, headers: ada, payload: { values: { GITHUB_TOKEN: 'supersecretvalue' } } })
  assert.equal(reuse.statusCode, 404)
  await app.close()
})

test('emoji gate, egress-audit ingest + admin view, auth-broker gates', async () => {
  const sink = createMemoryEgressAuditSink()
  // Cluster 2 brief `qm-next-c2-emoji-upload`: wire an in-test
  // EmojiUploadService backed by the memory byte store so the gate stays
  // exercisable without an IM provider.
  const emojiService = createEmojiUploadService({
    bytes: createMemoryByteStore(),
    audit: createMemoryAuditLog(),
  })
  const emojiApp = createApiServer(
    {
      ...baseDeps(),
      admin: adminDeps({ egressAudit: sink, auditLog: createMemoryAuditLog() }),
      emoji: { service: emojiService },
      egressAudit: { sink },
      authBroker: {},
      grants: { grants: createMemoryGrantLedger(), orgScope: ORG },
    },
    OPTS,
  )
  const ada = auth(await token('person:ada'))

  const emojiNoToken = await emojiApp.inject({ method: 'POST', url: '/v1/emoji', payload: { name: 'x', image: 'aGk=' } })
  assert.equal(emojiNoToken.statusCode, 401)
  assert.equal(emojiNoToken.json().message, 'agent capability token required')

  // With the service wired but no IM provider, the upload succeeds with
  // pendingProviderRegistration: true (cluster 2 brief acceptance: not 500).
  const emoji = await emojiApp.inject({
    method: 'POST',
    url: '/v1/emoji',
    headers: ada,
    payload: { name: 'party-parrot', contentType: 'image/png', bytes: 'aGk=' },
  })
  assert.equal(emoji.statusCode, 200)
  assert.equal(emoji.json().ok, true)
  assert.equal(emoji.json().pendingProviderRegistration, true)
  assert.match(emoji.json().blobKey, /^files\//)

  const badBatch = await emojiApp.inject({ method: 'POST', url: '/v1/egress-audit', headers: ada, payload: { records: [] } })
  assert.equal(badBatch.statusCode, 400)
  assert.equal(badBatch.json().message, 'records must be a non-empty array of at most 500')

  const ingest = await emojiApp.inject({
    method: 'POST',
    url: '/v1/egress-audit',
    headers: ada,
    payload: {
      records: [
        { host: 'api.github.com', verdict: 'ok', principalId: 'person:ada', scopeLabel: ORG, port: 443 },
        { host: 'evil.example', verdict: 'denied', scopeLabel: ORG },
        { verdict: 'no-host' },
      ],
    },
  })
  assert.deepEqual(ingest.json(), { accepted: 2, rejected: 1 })

  const egressView = await emojiApp.inject({ method: 'GET', url: `/v1/admin/egress?scope=${ORG}`, headers: ada })
  assert.equal(egressView.statusCode, 200)
  assert.equal(egressView.json().total, 2)
  assert.equal(egressView.json().denied, 1)
  assert.equal(egressView.json().hosts, 2)
  assert.deepEqual(egressView.json().bySource, { broker: 0, firewall: 2 })

  const claim = await emojiApp.inject({ method: 'POST', url: '/v1/auth/broker/claim', headers: ada, payload: { ids: ['n1'], expiresAtMs: Date.now() + 1000 } })
  assert.equal(claim.statusCode, 503)
  assert.ok(String(claim.json().message).includes('Postgres-backed replay store'))

  const noEmail = await emojiApp.inject({ method: 'GET', url: '/v1/auth/broker/email-allowed', headers: ada })
  assert.equal(noEmail.statusCode, 400)
  assert.equal(noEmail.json().message, 'email required')

  const email = await emojiApp.inject({ method: 'GET', url: '/v1/auth/broker/email-allowed?email=x@y.z', headers: ada })
  assert.deepEqual(email.json(), { allowed: false })
  await emojiApp.close()
})
