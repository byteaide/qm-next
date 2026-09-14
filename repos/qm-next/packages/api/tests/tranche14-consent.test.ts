/**
 * Tranche 14 IM-backfill route tests (P4 14.0 tranche 4): recipient
 * consent (create-side stamping + notice, the decision route's success,
 * wrong-actor, no-consent, and unknown-id paths), the owner edit notice on
 * third-party PATCHes, and the admin shadow-deliveries provenance view.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createMemoryDirectoryStore, resolveProviderDm } from '@qm/directory'
import type { ImDelivery } from '@qm/im-core'
import { createMemoryCronStore } from '@qm/triggers'
import type { RecipientConsent } from '@qm/types'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { reachDirectory } from '@qm/reach'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createApiServer, createMemoryAdminService, mintSignedPayload, type ApiDeps, type ApiServerOptions } from '../src/index.ts'

const SECRET = '[redacted-credential]'
const SCOPE: ScopeId = 'org:test'
const ORG = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }
const OWNER = 'feishu:u_owner'

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

/** Roster: two people plus their bot-DM spaces (owner + teammate). */
async function seededDirectory(): Promise<ReturnType<typeof createMemoryDirectoryStore>> {
  const directory = createMemoryDirectoryStore()
  await directory.apply({
    provider: 'feishu',
    instanceId: 'inst-1',
    people: [
      { providerUserId: 'u_owner', displayName: 'Owner', type: 'internal' },
      { providerUserId: 'u_other', displayName: 'Teammate', type: 'internal' },
    ],
    spaces: [
      { spaceId: 'oc_general', name: 'general', kind: 'channel', isPrivate: false, isExternal: false },
      { spaceId: 'oc_dm_owner', kind: 'dm', isPrivate: true, isExternal: false },
      { spaceId: 'oc_dm_other', kind: 'dm', isPrivate: true, isExternal: false },
    ],
    spaceMembers: [
      { spaceId: 'oc_dm_owner', providerUserId: 'u_owner' },
      { spaceId: 'oc_dm_other', providerUserId: 'u_other' },
    ],
    replace: ['people', 'spaces', 'spaceMembers'],
    syncedAt: 1,
  })
  return directory
}

async function cronDeps(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const directory = await seededDirectory()
  const captured: Array<Record<string, unknown>> = []
  const store = createMemoryCronStore()
  return {
    crons: () => store,
    scheduler: () => undefined,
    directory,
    deliveries: () => ({
      enqueue: async (input: Record<string, unknown>) => {
        captured.push(input)
        return { id: 'd1' } as ImDelivery
      },
    }),
    reach: reachDirectory(directory),
    scopeFor: () => SCOPE,
    provider: 'feishu',
    ...overrides,
  }
}

test('cron create with a recipient stamps pending consent and notifies the recipient DM', async () => {
  const owner = auth(await token(OWNER))
  const captured: Array<Record<string, unknown>> = []
  const deps = await cronDeps({
    deliveries: () => ({
      enqueue: async (input: Record<string, unknown>) => {
        captured.push(input)
        return { id: 'd1' } as ImDelivery
      },
    }),
  })
  const app = createApiServer({ ...baseDeps(), crons: deps } as unknown as ApiDeps, OPTS)
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/crons',
      headers: owner,
      payload: { schedule: { everyMs: 60_000 }, task: 'daily digest', recipient: 'u_other', title: 'digest' },
    })
    assert.equal(res.statusCode, 200, res.body)
    const cron = res.json().cron
    const consent: RecipientConsent | undefined = cron.recipientConsent
    assert.ok(consent, 'a standing recipient cron carries a consent stamp')
    assert.equal(consent.recipientId, 'feishu:u_other')
    assert.equal(consent.status, 'pending')

    assert.equal(captured.length, 1, 'the recipient hears about the pending delivery')
    const notice = captured[0]!
    assert.match(String(notice.idempotencyKey), /^consent-notice:/)
    const body = notice.op as { body: { text: string } }
    assert.match(body.body.text, /Owner set up a scheduled message \("digest"\)/)
    assert.match(body.body.text, /won't start until you accept/)
  } finally {
    await app.close()
  }
})

test('channel crons and one-shot crons never stamp consent', async () => {
  const owner = auth(await token(OWNER))
  const deps = await cronDeps()
  const app = createApiServer({ ...baseDeps(), crons: deps } as unknown as ApiDeps, OPTS)
  try {
    const channel = await app.inject({
      method: 'POST',
      url: '/v1/crons',
      headers: owner,
      payload: { schedule: { everyMs: 60_000 }, task: 'standup notes', channel: 'oc_general' },
    })
    assert.equal(channel.statusCode, 200)
    assert.equal(channel.json().cron.recipientConsent, undefined)

    const oneShot = await app.inject({
      method: 'POST',
      url: '/v1/crons',
      headers: owner,
      payload: { schedule: { firstFireAt: Date.now() + 60_000 }, task: 'once', recipient: 'u_other' },
    })
    assert.equal(oneShot.statusCode, 200)
    assert.equal(oneShot.json().cron.recipientConsent, undefined, 'one-shot deliveries need no standing consent')
  } finally {
    await app.close()
  }
})

test('the consent route: recipient accepts, wrong actor is forbidden, missing consent is a 400', async () => {
  const owner = auth(await token(OWNER))
  const teammate = auth(await token('feishu:u_other'))
  const store = createMemoryCronStore()
  const created = await store.create({
    scopeId: SCOPE,
    ownerId: OWNER,
    createdBy: OWNER,
    schedule: { everyMs: 60_000 },
    action: 'digest',
    recipientConsent: { recipientId: 'feishu:u_other', status: 'pending' },
  })
  const deps = await cronDeps({ crons: () => store })
  const app = createApiServer({ ...baseDeps(), crons: deps } as unknown as ApiDeps, OPTS)
  try {
    const anonymous = await app.inject({ method: 'POST', url: `/v1/triggers/${created.id}/consent`, payload: { decision: 'accept' } })
    assert.equal(anonymous.statusCode, 403)

    const badDecision = await app.inject({ method: 'POST', url: `/v1/triggers/${created.id}/consent`, headers: teammate, payload: { decision: 'maybe' } })
    assert.equal(badDecision.statusCode, 400)

    const foreign = await app.inject({ method: 'POST', url: `/v1/triggers/${created.id}/consent`, headers: owner, payload: { decision: 'accept' } })
    assert.equal(foreign.statusCode, 403, 'only the stamped recipient may decide')

    const accept = await app.inject({ method: 'POST', url: `/v1/triggers/${created.id}/consent`, headers: teammate, payload: { decision: 'accept' } })
    assert.equal(accept.statusCode, 200)
    assert.equal(accept.json().ok, true)
    assert.equal(accept.json().consent.status, 'accepted')
    assert.equal((await store.get(created.id))?.recipientConsent?.status, 'accepted')

    const again = await app.inject({ method: 'POST', url: `/v1/triggers/${created.id}/consent`, headers: teammate, payload: { decision: 'accept' } })
    assert.equal(again.statusCode, 200, 're-deciding is idempotent')

    const missing = await app.inject({ method: 'POST', url: '/v1/triggers/unknown/consent', headers: teammate, payload: { decision: 'accept' } })
    assert.equal(missing.statusCode, 404)
  } finally {
    await app.close()
  }
})

test('a cron without a consent stamp answers 400 on the consent route', async () => {
  const teammate = auth(await token('feishu:u_other'))
  const store = createMemoryCronStore()
  const created = await store.create({
    scopeId: SCOPE,
    ownerId: OWNER,
    createdBy: OWNER,
    schedule: { everyMs: 60_000 },
    action: 'channel digest',
  })
  const deps = await cronDeps({ crons: () => store })
  const app = createApiServer({ ...baseDeps(), crons: deps } as unknown as ApiDeps, OPTS)
  try {
    const res = await app.inject({ method: 'POST', url: `/v1/triggers/${created.id}/consent`, headers: teammate, payload: { decision: 'accept' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /no recipient consent/)
  } finally {
    await app.close()
  }
})

test('third-party edits notify the owner; the owner editing does not', async () => {
  const owner = auth(await token(OWNER))
  const editor = auth(await token('feishu:u_editor'))
  const directory = await seededDirectory()
  await directory.apply({
    provider: 'feishu',
    instanceId: 'inst-2',
    people: [
      { providerUserId: 'u_owner', displayName: 'Owner', type: 'internal' },
      { providerUserId: 'u_other', displayName: 'Teammate', type: 'internal' },
      { providerUserId: 'u_editor', displayName: 'Editor', type: 'internal' },
    ],
    spaces: [
      { spaceId: 'oc_dm_owner', kind: 'dm', isPrivate: true, isExternal: false },
      { spaceId: 'oc_dm_other', kind: 'dm', isPrivate: true, isExternal: false },
    ],
    spaceMembers: [
      { spaceId: 'oc_dm_owner', providerUserId: 'u_owner' },
      { spaceId: 'oc_dm_other', providerUserId: 'u_other' },
    ],
    replace: ['people', 'spaces', 'spaceMembers'],
    syncedAt: 2,
  })
  const captured: Array<Record<string, unknown>> = []
  const deps = await cronDeps({
    directory,
    deliveries: () => ({
      enqueue: async (input: Record<string, unknown>) => {
        captured.push(input)
        return { id: 'd2' } as ImDelivery
      },
    }),
  })
  const app = createApiServer({ ...baseDeps(), crons: deps } as unknown as ApiDeps, OPTS)
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/crons',
      headers: owner,
      payload: { schedule: { everyMs: 60_000 }, task: 'owner task', title: 'weekly sweep' },
    })
    assert.equal(created.statusCode, 200)
    const cronId = created.json().cron.id

    const ownerEdit = await app.inject({ method: 'PATCH', url: `/v1/crons/${cronId}`, headers: owner, payload: { title: 'self rename' } })
    assert.equal(ownerEdit.statusCode, 200)
    assert.equal(captured.length, 0, 'no notice when the owner edits their own cron')

    const thirdParty = await app.inject({ method: 'PATCH', url: `/v1/crons/${cronId}`, headers: editor, payload: { title: 'renamed by editor', enabled: false } })
    assert.equal(thirdParty.statusCode, 200)
    assert.equal(captured.length, 1)
    const notice = captured[0]!
    assert.match(String(notice.idempotencyKey), /^cron-edit-notice:/)
    const op = notice.op as { body: { text: string }; destination: { target: string } }
    assert.equal(op.destination.target, 'oc_dm_owner', 'the notice rides the owner DM')
    assert.match(op.body.text, /Heads up: Editor renamed your "renamed by editor" cron and paused it\./)
  } finally {
    await app.close()
  }
})

test('admin shadow deliveries list trigger-provenanced rows', async () => {
  const ada = auth(await token('person:ada'))
  const queueRows: ImDelivery[] = []
  const enqueue = async (input: { idempotencyKey: string; origin?: ImDelivery['origin'] }) => {
    const row = {
      id: `d-${queueRows.length + 1}`,
      idempotencyKey: input.idempotencyKey,
      provider: 'feishu',
      op: { op: 'send', destination: { type: 'feishu', target: 'oc_dm_owner' }, body: { text: 'x' } },
      createdAt: 1,
      attempts: 0,
      deliveredAt: null,
      ...(input.origin ? { origin: input.origin } : {}),
    } as unknown as ImDelivery
    queueRows.push(row)
    return row
  }
  const queue = {
    enqueue,
    list: async () => queueRows,
  }
  await enqueue({
    idempotencyKey: 'cron-fire:k1',
    origin: { trigger: 'cron-1', surface: 'cron', fireKey: 'k1', sourceScopeId: ORG, sourceThreadRef: 'cron:t1' },
  })
  await enqueue({ idempotencyKey: 'run:abc', origin: { runId: 'abc' } })
  const app = createApiServer(
    {
      ...baseDeps(),
      admin: {
        ...{ admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }), orgScope: ORG },
        deliveries: () => queue,
      },
    } as unknown as ApiDeps,
    OPTS,
  )
  try {
    const res = await app.inject({ method: 'GET', url: `/v1/admin/deliveries/shadow?scope=${ORG}`, headers: ada })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.scopeId, ORG)
    assert.equal(body.shadow.length, 1, 'only trigger-provenanced deliveries surface')
    assert.equal(body.shadow[0].origin.fireKey, 'k1')
    assert.equal(body.shadow[0].origin.sourceScopeId, ORG)
  } finally {
    await app.close()
  }
})

test('resolveProviderDm finds the dm space a person belongs to', async () => {
  const directory = await seededDirectory()
  const dm = await resolveProviderDm(directory, 'feishu', 'u_other')
  assert.equal(dm?.destination.target, 'oc_dm_other')
  assert.equal(await resolveProviderDm(directory, 'feishu', 'u_stranger'), null)
})
