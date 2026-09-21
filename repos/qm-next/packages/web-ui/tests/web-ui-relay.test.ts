/**
 * Web-ui convergence relay tests (13.0): the per-user bearer relay into the
 * api parity lanes — blob staging + file upload/list/content, playground
 * CSP framing, webhook CRUD, memory read/write/history/restore, keychain
 * overview, user-model-auth status, connectors status, deployments with the
 * manage gate, scope-resources composition with secret redaction, search,
 * and the approval re-submission ladder.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Context } from '@qm/cordis'
import { createKeychain, deriveConnectorKey } from '@qm/credentials'
import { createMemoryDirectoryStore } from '@qm/directory'
import { createMemoryScopeMemory } from '@qm/memory'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemoryMap, createMemorySessionStore } from '@qm/store'
import { createInMemoryEventLog, createMemorySequenceAllocator, createMemorySessionReservationStore } from '@qm/concurrency'
import { createMemoryTargetApprovalStore } from '@qm/approvals'
import { createMemoryCronStore } from '@qm/triggers'
import { createMemorySkillStore } from '@qm/skills'
import { createTurnRunner, createApiServer, mintSignedPayload } from '@qm/api'
import {
  createMemoryBlobTransfer,
  createMemoryConnectorSurface,
  createMemoryDeploymentStore,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryRuntimeConfigStore,
  createMemoryUserModelCredentialsStore,
  createMemoryWebhookStore,
} from '@qm/api'
import type { ResolutionService, ScopeId } from '@qm/types'
import { mintPortalIdentity } from '@qm/auth'
import { createApiRelay } from '../src/relay.ts'
import { createWebUiServer, type WebUiDeps } from '../src/index.ts'

const SCOPE: ScopeId = 'org:default'
const SECRET = 'relay-test-secret'
const COOKIE = { cookie: 'webuiuser=dev' }

interface RelayRig {
  web: FastifyInstance
  api: FastifyInstance
  runs: ReturnType<typeof createMemoryRunStore>
  runner: ReturnType<typeof createTurnRunner>
}

async function buildRig(overrides: Partial<WebUiDeps> = {}): Promise<RelayRig> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const log = createInMemoryEventLog({ allocator: createMemorySequenceAllocator() })
  const approvalsTarget = createMemoryTargetApprovalStore()
  const reservations = createMemorySessionReservationStore()
  const mock = createMockHarness({
    script: [
      { reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [{ command: 'drop-tables', reason: 'destructive' }] },
      { reply: 'echo: hello relay' },
    ],
  })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(mock)
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'test soul prompt', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: registry,
    identity: {
      isInternal: (p) => p.type === 'internal',
      audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
    },
    resolution,
    rateLimiter: { check: async () => ({ allowed: true }) },
    runEventLog: log.bus,
  })
  // ADR-0010 continuation executor — suspend + continuation lane wired.
  const runner = createTurnRunner(
    {
      orchestrator,
      runs,
      runEventLog: log.bus,
      approvals: approvalsTarget,
      reservations,
    },
    { tickMs: 5 },
  )
  runner.start()

  const grantLedger = createMemoryGrantLedger()
  const blobTransfer = createMemoryBlobTransfer()
  const apiApp = createApiServer(
    {
      orchestrator,
      sessions,
      runs,
      resolution,
      surface: { sessions, orchestrator, scopeFor: () => SCOPE },
      files: { files: createMemoryFileStore({ blobTransfer, grants: grantLedger }), blobTransfer },
      grants: { grants: grantLedger, orgScope: SCOPE },
      blobs: { blobTransfer },
      webhooks: { webhooks: createMemoryWebhookStore() },
      connectors: createMemoryConnectorSurface(),
      userModelAuth: { credentials: createMemoryUserModelCredentialsStore() },
      keychain: {
        keychain: () =>
          createKeychain({
            creds: createMemoryMap(),
            grants: createMemoryMap(),
            asks: createMemoryMap(),
            key: deriveConnectorKey(SECRET),
            orgId: () => 'default',
          }),
        scopeFor: (actorId) => `personal:${actorId}`,
      },
      memory: { memory: createMemoryScopeMemory(), scopeFor: () => SCOPE },
      deployments: { deployments: createMemoryDeploymentStore({ grants: grantLedger }) },
      config: { config: createMemoryRuntimeConfigStore() },
    },
    { secrets: [SECRET] },
  )

  const web = createWebUiServer(
    {
      orchestrator,
      sessions,
      runs,
      resolution,
      runObservation: log.observation,
      approvalContinuation: { approvals: approvalsTarget, runs, runEventLog: log.bus, reservations },
      skills: createMemorySkillStore(),
      crons: createMemoryCronStore(),
      directory: createMemoryDirectoryStore(),
      relay: createApiRelay(apiApp, SECRET),
      publicUrl: 'https://web.example.test',
      ...overrides,
    },
    { host: '127.0.0.1', port: 0, user: 'dev' },
  )
  return { web, api: apiApp, runs, runner }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('blobs + files: staging enforces the declared sha, upload registers, list and content read back', async () => {
  const rig = await buildRig()
  try {
    const bytes = Buffer.from('relay file body')
    const badSha = await rig.web.inject({
      method: 'POST',
      url: `/api/blobs?sha=${'0'.repeat(64)}`,
      headers: { cookie: COOKIE.cookie, 'content-type': 'application/octet-stream' },
      payload: bytes,
    })
    assert.equal(badSha.statusCode, 400)
    const goodSha = await rig.web.inject({
      method: 'POST',
      url: `/api/blobs?sha=${sha256Hex(bytes)}`,
      headers: { cookie: COOKIE.cookie, 'content-type': 'application/octet-stream' },
      payload: bytes,
    })
    if (goodSha.statusCode !== 200) console.log('GOODSHA-BODY', goodSha.statusCode, goodSha.body)
    assert.equal(goodSha.statusCode, 200)
    const staged = goodSha.json() as { blobId: string }
    assert.ok(staged.blobId)

    const upload = await rig.web.inject({
      method: 'POST',
      url: `/api/files/upload?name=notes.txt&sha=${sha256Hex(bytes)}`,
      headers: { cookie: COOKIE.cookie, 'content-type': 'text/plain' },
      payload: bytes,
    })
    assert.equal(upload.statusCode, 200)
    const uploaded = upload.json() as { file: { id: string; name: string } }
    assert.equal(uploaded.file.name, 'notes.txt')

    const list = await rig.web.inject({ method: 'GET', url: '/api/files', headers: COOKIE })
    assert.equal(list.statusCode, 200)
    const listed = list.json() as { owned: Array<{ id: string; name: string }> }
    assert.equal(listed.owned.length, 1)

    const content = await rig.web.inject({ method: 'GET', url: `/api/files/${uploaded.file.id}/content`, headers: COOKIE })
    assert.equal(content.statusCode, 200)
    assert.equal(content.body, 'relay file body')
    assert.match(String(content.headers['content-security-policy']), /sandbox allow-scripts/)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('playgrounds frame only html artifacts, with source view and the strict sandbox CSP', async () => {
  const rig = await buildRig()
  try {
    const html = Buffer.from('<!doctype html><html><body><h1>artifact</h1></body></html>')
    const upload = await rig.web.inject({
      method: 'POST',
      url: `/api/files/upload?name=artifact.html&sha=${sha256Hex(html)}`,
      headers: { cookie: COOKIE.cookie, 'content-type': 'text/html; charset=utf-8' },
      payload: html,
    })
    assert.equal(upload.statusCode, 200)
    const { file } = upload.json() as { file: { id: string } }

    const framed = await rig.web.inject({ method: 'GET', url: `/api/playgrounds/${file.id}`, headers: COOKIE })
    assert.equal(framed.statusCode, 200)
    assert.match(String(framed.headers['content-type']), /text\/html/)
    assert.match(String(framed.headers['content-security-policy']), /default-src 'none'/)

    const source = await rig.web.inject({ method: 'GET', url: `/api/playgrounds/${file.id}?source=1`, headers: COOKIE })
    assert.equal(source.statusCode, 200)
    assert.match(String(source.headers['content-type']), /text\/plain/)

    const text = Buffer.from('just text')
    const textUpload = await rig.web.inject({
      method: 'POST',
      url: `/api/files/upload?name=plain.txt&sha=${sha256Hex(text)}`,
      headers: { cookie: COOKIE.cookie, 'content-type': 'text/plain' },
      payload: text,
    })
    assert.equal(textUpload.statusCode, 200)
    const { file: textFile } = textUpload.json() as { file: { id: string } }
    const rejected = await rig.web.inject({ method: 'GET', url: `/api/playgrounds/${textFile.id}`, headers: COOKIE })
    assert.equal(rejected.statusCode, 415)
    assert.equal((rejected.json() as { error: string }).error, 'not_a_playground')
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('webhooks: create mints a secret, list shows it, enable/disable round-trips', async () => {
  const rig = await buildRig()
  try {
    const created = await rig.web.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: COOKIE,
      payload: { action: 'triage the payload' },
    })
    assert.equal(created.statusCode, 200)
    const hook = created.json() as { webhook: { id: string; verification: { scheme: string; secret: string } } }
    assert.equal(hook.webhook.verification.scheme, 'hmac-sha256')
    assert.ok(hook.webhook.verification.secret)

    const listed = await rig.web.inject({ method: 'GET', url: '/api/webhooks', headers: COOKIE })
    assert.equal(listed.statusCode, 200)
    const body = listed.json() as { webhooks: Array<{ id: string }> }
    assert.equal(body.webhooks.length, 1)

    const disabled = await rig.web.inject({ method: 'POST', url: `/api/webhooks/${hook.webhook.id}/disable`, headers: COOKIE })
    assert.equal(disabled.statusCode, 200)
    const enabled = await rig.web.inject({ method: 'POST', url: `/api/webhooks/${hook.webhook.id}/enable`, headers: COOKIE })
    assert.equal(enabled.statusCode, 200)

    const stranger = await rig.web.inject({
      method: 'POST',
      url: `/api/webhooks/${hook.webhook.id}/disable`,
      headers: { cookie: 'webuiuser=malory' },
    })
    assert.equal(stranger.statusCode, 404)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('memory: head, put with optimistic revision, history and restore', async () => {
  const rig = await buildRig()
  try {
    const head = await rig.web.inject({ method: 'GET', url: '/api/memory', headers: COOKIE })
    assert.equal(head.statusCode, 200)
    const empty = head.json() as { content: string; revision: string }
    assert.equal(empty.content, '')

    const put = await rig.web.inject({
      method: 'PUT',
      url: '/api/memory',
      headers: COOKIE,
      payload: { content: 'first revision' },
    })
    assert.equal(put.statusCode, 200)
    const saved = put.json() as { revision: string }
    assert.ok(saved.revision)

    const conflict = await rig.web.inject({
      method: 'PUT',
      url: '/api/memory',
      headers: COOKIE,
      payload: { content: 'stale write', revision: 'nope' },
    })
    assert.equal(conflict.statusCode, 409)

    const history = await rig.web.inject({ method: 'GET', url: '/api/memory/history', headers: COOKIE })
    assert.equal(history.statusCode, 200)
    const revisions = history.json() as { revisions: Array<{ revision: string }> }
    assert.ok(Array.isArray(revisions.revisions))
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('keychain, user-model-auth and connectors statuses ride the per-user relay', async () => {
  const rig = await buildRig()
  try {
    const overview = await rig.web.inject({ method: 'GET', url: '/api/keychain/overview', headers: COOKIE })
    assert.equal(overview.statusCode, 200)
    const chain = overview.json() as { credentials: unknown[]; grants: unknown[] }
    assert.deepEqual(chain.credentials, [])
    assert.deepEqual(chain.grants, [])

    const status = await rig.web.inject({ method: 'GET', url: '/api/user-model-auth/status', headers: COOKIE })
    assert.equal(status.statusCode, 200)
    const auth = status.json() as { individualModelAuth: boolean; connections: unknown[] }
    assert.equal(auth.individualModelAuth, false)

    const connectors = await rig.web.inject({ method: 'GET', url: '/api/connectors', headers: COOKIE })
    assert.equal(connectors.statusCode, 200)
    assert.equal((connectors.json() as { principalId: string }).principalId, 'dev')

    const anon = await rig.web.inject({ method: 'GET', url: '/api/keychain/overview' })
    assert.equal(anon.statusCode, 401)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('deployments: the manage gate admits the owner and blocks strangers; webUrl is mapped', async () => {
  const rig = await buildRig()
  try {
    const bearer = `Bearer ${await mintSignedPayload({ p: 'dev' }, SECRET)}`
    const created = await rig.api.inject({
      method: 'POST',
      url: '/v1/deployments',
      headers: { authorization: bearer },
      payload: {
        ownerScopeId: 'personal:dev',
        createdBy: 'dev',
        entrypoint: 'index.html',
        files: [{ path: 'index.html', content: '<h1>app</h1>' }],
      },
    })
    assert.equal(created.statusCode, 200)
    const { deployment } = created.json() as { deployment: { id: string } }

    const list = await rig.web.inject({ method: 'GET', url: '/api/deployments', headers: COOKIE })
    assert.equal(list.statusCode, 200)
    const listed = list.json() as { deployments: Array<{ id: string; webUrl: string }> }
    assert.equal(listed.deployments[0]?.webUrl, `/deployments/${deployment.id}/`)

    const renamed = await rig.web.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/name`,
      headers: COOKIE,
      payload: { name: 'my-app' },
    })
    assert.equal(renamed.statusCode, 200)

    const stranger = await rig.web.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/name`,
      headers: { cookie: 'webuiuser=malory' },
      payload: { name: 'hijacked' },
    })
    assert.equal(stranger.statusCode, 404)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('scope-resources composes the lanes and redacts webhook secrets', async () => {
  const rig = await buildRig()
  try {
    const bytes = Buffer.from('scope file')
    await rig.web.inject({
      method: 'POST',
      url: `/api/files/upload?name=scoped.txt&sha=${sha256Hex(bytes)}`,
      headers: { cookie: COOKIE.cookie, 'content-type': 'text/plain' },
      payload: bytes,
    })
    await rig.web.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: COOKIE,
      payload: { action: 'handle it' },
    })

    const resources = await rig.web.inject({
      method: 'GET',
      url: '/api/scope-resources?scope=personal:dev',
      headers: COOKIE,
    })
    assert.equal(resources.statusCode, 200)
    const body = resources.json() as {
      files: unknown[]
      webhooks: Array<{ verification?: { secret?: string } }>
      deployments: unknown[]
      manageable: boolean
    }
    assert.equal(body.files.length, 1)
    assert.equal(body.webhooks.length, 1)
    assert.equal(body.webhooks[0]?.verification?.secret, undefined)
    assert.equal(body.manageable, true)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('search and approvals ride the convergence: awaiting state surfaces, decisions resume the same Run', async () => {
  const rig = await buildRig()
  try {
    const turn = await rig.web.inject({
      method: 'POST',
      url: '/api/turn',
      headers: COOKIE,
      payload: { text: 'hello relay', threadRef: 'web:dev:default' },
    })
    assert.equal(turn.statusCode, 202)
    const { runId } = turn.json() as { runId: string }
    // The Run suspends (non-terminal) — poll for the awaiting state.
    let pollBody: { status: string; result: { status: string; pendingApprovals?: Array<{ requestId: string }> } | null } | undefined
    for (let i = 0; i < 100; i++) {
      const poll = await rig.web.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: COOKIE })
      pollBody = poll.json() as typeof pollBody
      if (pollBody?.status === 'awaiting_approval') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(pollBody?.status, 'awaiting_approval')
    assert.equal(pollBody.result?.status, 'pending_approval')
    const requestId = pollBody.result?.pendingApprovals?.[0]?.requestId
    assert.ok(requestId)

    const decision = await rig.web.inject({
      method: 'POST',
      url: `/api/approvals/${encodeURIComponent(requestId)}`,
      headers: COOKIE,
      payload: { approved: true },
    })
    assert.equal(decision.statusCode, 202)
    const decisionBody = decision.json() as { runId: string; state: string }
    assert.equal(decisionBody.runId, runId, 'no successor Run — the SAME Run resumes')
    assert.equal(decisionBody.state, 'resuming')
    await rig.runs.waitFor(runId, 5_000)
    const nextPoll = await rig.web.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: COOKIE })
    const nextBody = nextPoll.json() as { status: string; result: { status: string; reply?: string } | null }
    assert.equal(nextBody.status, 'succeeded')
    assert.equal(nextBody.result?.status, 'ok')
    assert.equal(nextBody.result?.reply, 'echo: hello relay')

    const stranger = await rig.web.inject({
      method: 'POST',
      url: `/api/approvals/${encodeURIComponent(requestId)}`,
      headers: { cookie: 'webuiuser=malory' },
      payload: { approved: true },
    })
    assert.equal(stranger.statusCode, 404)

    const search = await rig.web.inject({ method: 'GET', url: '/api/search?q=hello', headers: COOKIE })
    assert.equal(search.statusCode, 200)
    const hits = search.json() as { hits: Array<{ sessionId: string; snippet: string }> }
    assert.ok(hits.hits.length >= 1)
    assert.match(hits.hits[0]?.snippet ?? '', /hello/i)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})

test('hardening: portal identity admits, the allow-list narrows, portal mode names itself', async () => {
  const idpSecret = 'web-identity-secret'
  const rig = await buildRig({
    auth: { portalIdentitySecret: idpSecret, principals: ['alice'] },
  })
  try {
    const mint = (user: string): string =>
      mintPortalIdentity({ p: user, exp: Date.now() + 30_000 }, idpSecret)

    const cookieWhileLocked = await rig.web.inject({ method: 'GET', url: '/me', headers: COOKIE })
    assert.equal(cookieWhileLocked.statusCode, 401)
    const denied = cookieWhileLocked.json() as { mode: string; reason: string }
    assert.equal(denied.mode, 'portal')
    assert.equal(denied.reason, 'not_allowed')

    const stranger = await rig.web.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-portal-identity': mint('malory') },
    })
    assert.equal(stranger.statusCode, 401)
    assert.equal((stranger.json() as { reason: string }).reason, 'not_allowed')

    const admitted = await rig.web.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-portal-identity': mint('alice') },
    })
    assert.equal(admitted.statusCode, 200)
    const me = admitted.json() as { user: string; mode: string; impersonatedBy: string | null }
    assert.equal(me.user, 'alice')
    assert.equal(me.mode, 'portal')
    assert.equal(me.impersonatedBy, null)

    const impersonated = await rig.web.inject({
      method: 'GET',
      url: '/me',
      headers: {
        'x-portal-identity': mintPortalIdentity(
          { p: 'alice', imp: 'root', exp: Date.now() + 30_000 },
          idpSecret,
        ),
      },
    })
    assert.equal(impersonated.statusCode, 200)
    assert.equal((impersonated.json() as { impersonatedBy: string | null }).impersonatedBy, 'root')

    const garbage = await rig.web.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-portal-identity': 'not.a.valid-token' },
    })
    assert.equal(garbage.statusCode, 401)
  } finally {
    await rig.runner.stop()
    await rig.web.close()
    await rig.api.close()
  }
})
