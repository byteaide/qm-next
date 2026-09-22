/**
 * ToolContext control-plane behavior tests (T-cluster wiring): the cron
 * surface runs the full chain over the real @qm/triggers memory store and
 * scheduler (create → fire → runs → patch → delete), the webhook surface
 * creates/lists/disables over the real store, and the share surface gates
 * through the grant ledger. MCP rides a stub service.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCronScheduler, createMemoryCronStore } from '@qm/triggers'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, RunStore } from '@qm/types'
import type { CronControlDeps } from '../src/services/cron-control.ts'
import type { ToolControlDeps } from '../src/services/tool-control.ts'
import {
  createCronControl,
  createMemoryBlobTransfer,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryWebhookStore,
  createToolControlSurfaces,
  sharedFileHandles,
} from '../src/index.ts'

const T0 = 1_700_000_000_000

const RESOLUTION: ResolutionService = {
  resolve: async () => ({ systemPrompt: 'test', orgScopeId: 'org:test' }),
  scopeFor: () => 'org:test',
}

function cronDeps(): CronControlDeps & { runs: RunStore } {
  const crons = createMemoryCronStore()
  const runs = createMemoryRunStore()
  let clock = T0
  const scheduler = createCronScheduler({
    crons,
    runs,
    sessions: createMemorySessionStore(),
    resolution: RESOLUTION,
    now: () => clock,
  })
  return {
    crons,
    runs,
    scheduler,
    scopeFor: () => 'org:test',
    deliveries: () => undefined,
  }
}

function toolControl(over: Partial<ToolControlDeps> = {}): ReturnType<typeof createToolControlSurfaces> {
  const webhookStore = createMemoryWebhookStore()
  const fileStore = createMemoryFileStore({ blobTransfer: createMemoryBlobTransfer(), grants: createMemoryGrantLedger() })
  return createToolControlSurfaces({
    actorId: 'feishu:ada',
    cron: cronDeps,
    webhooks: () => webhookStore,
    orgScope: 'org:test',
    grants: () => createMemoryGrantLedger(),
    files: () => fileStore,
    ...over,
  })
}

test('cron surface: create → fire → runs → patch → setEnabled → delete over the real scheduler', async () => {
  const surfaces = toolControl()
  assert.ok(surfaces.crons)

  const refused = await surfaces.crons.cronCreate({ schedule: { everyMs: 500 }, action: 'x', destinationKey: 'd1' })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.message, /capability-mode/)

  const noTask = await surfaces.crons.cronCreate({ schedule: { everyMs: 500 } })
  assert.equal(noTask.ok, false)
  if (!noTask.ok) assert.match(noTask.message, /task \(what to do\) or text/)

  const world = cronDeps()
  const surfacesWithWorld = createToolControlSurfaces({
    actorId: 'feishu:ada',
    cron: () => world,
    orgScope: 'org:test',
  })
  assert.ok(surfacesWithWorld.crons)
  const created = await surfacesWithWorld.crons.cronCreate(
    { schedule: { everyMs: 60_000, firstFireAt: T0 + 60_000 }, title: 'standup notes', action: 'write the standup notes' },
  )
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.cron.title, 'standup notes')
  assert.equal(created.cron.owner, 'feishu:ada')
  assert.equal(created.cron.ownerScopeId, 'org:test')

  const fired = await surfacesWithWorld.crons.cronRun(created.cron.id)
  assert.equal(fired.ok, true)
  const submitted = await world.runs.list({ limit: 10 })
  assert.equal(submitted.length, 1, 'cronRun submits one run through the scheduler')
  await world.runs.complete(submitted[0]!.id, submitted[0]!.leaseToken!, { status: 'ok', reply: 'notes written' })

  const runs = await surfacesWithWorld.crons.cronRuns(created.cron.id, { limit: 5 })
  assert.equal(runs.ok, true)
  if (!runs.ok) return
  assert.equal(runs.total, 1)
  assert.equal(runs.runs.length, 1)
  assert.equal(runs.runs[0]!.reply, 'notes written')

  const patched = await surfacesWithWorld.crons.cronPatch(created.cron.id, { title: 'standup notes v2' })
  assert.equal(patched.ok, true)
  if (!patched.ok) return
  assert.equal(patched.cron.title, 'standup notes v2')

  const foreignPatch = await createCronControl(world).cronPatch(created.cron.id, { title: 'hijack' }, 'feishu:mallory')
  assert.equal(foreignPatch.ok, false)
  if (!foreignPatch.ok) assert.equal(foreignPatch.code, 'forbidden')

  const disabled = await surfacesWithWorld.crons.cronSetEnabled(created.cron.id, false)
  assert.equal(disabled.ok, true)
  if (disabled.ok) assert.equal(disabled.cron.enabled, false)

  const pausedRun = await surfacesWithWorld.crons.cronRun(created.cron.id)
  assert.equal(pausedRun.ok, false)
  if (!pausedRun.ok) assert.equal(pausedRun.code, 'bad_request')

  const deleted = await surfacesWithWorld.crons.cronDelete(created.cron.id)
  assert.equal(deleted.ok, true)
  const gone = await surfacesWithWorld.crons.cronGet(created.cron.id)
  assert.equal(gone.ok, false)
  if (!gone.ok) assert.equal(gone.code, 'not_found')
})

test('webhook surface: create returns the inbound url once, list redacts, strangers stay blind', async () => {
  const surfaces = toolControl({ webhookPublicUrl: 'https://qm.example' })
  assert.ok(surfaces.webhooks)

  const created = await surfaces.webhooks.webhookCreate({
    action: 'dispatch the payload to the agent',
    verification: { scheme: 'hmac-sha256', secret: 's3cret' },
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.match(created.url, /^https:\/\/qm\.example\/v1\/webhooks\/incoming\//)
  assert.equal(created.secret, 's3cret')

  const listed = await surfaces.webhooks.webhookList()
  assert.ok(Array.isArray(listed), 'the wired list answers the redacted array')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.verification.secret, '***', 'list redacts the secret like the route')

  const stranger = toolControl({ actorId: 'feishu:mallory', webhooks: () => createMemoryWebhookStore() })
  assert.ok(stranger.webhooks)
  const empty = await stranger.webhooks.webhookList()
  assert.ok(Array.isArray(empty))
  assert.equal(empty.length, 0, 'another actor sees none of ada\u2019s webhooks')
  const hijack = await stranger.webhooks.webhookDisable('whatever')
  assert.equal(hijack.ok, false)
  if (!hijack.ok) assert.equal(hijack.code, 'not_found')
})

test('share surface: absent without a grant ledger; non-file types answer not_found', async () => {
  const surfaces = toolControl()
  assert.ok(surfaces.share)

  const otherType = await surfaces.share.shareArtifact({ type: 'skill', id: 's1', scope: 'org' })
  assert.equal(otherType.ok, false)
  if (!otherType.ok) assert.match(otherType.message, /skill store wiring/)

  const missing = await surfaces.share.shareArtifact({ type: 'file', id: 'nope', scope: 'org' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'not_found')

  const bare = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test' })
  assert.equal(bare.share, undefined, 'share surface only exists when a grant ledger is wired')
})

test('shared file handles: grants to a person manifest as shared/<name>; own and revoked stay hidden', async () => {
  const grants = createMemoryGrantLedger()
  const blob = createMemoryBlobTransfer()
  const files = createMemoryFileStore({ blobTransfer: blob, grants })
  const uploaded = await files.uploadForViewer('person:ada', { name: 'report.md', bytes: Buffer.from('hello') })
  assert.ok(uploaded)
  await grants.grant({ ownerScopeId: 'personal:person:ada', ref: uploaded!.id, granteeScopeId: 'personal:person:bob', permission: 'read', grantedBy: 'person:ada' })

  const handles = await sharedFileHandles({ grants, files })
  assert.deepEqual(handles, [
    { handlePath: 'shared/report.md', ownerScopeId: 'personal:person:ada', ownerPath: uploaded!.id, permission: 'read' },
  ])

  const bobOnly = await sharedFileHandles({ grants, files }, [{ id: 'person:bob', type: 'internal' }])
  assert.equal(bobOnly.length, 1)
  const adaOnly = await sharedFileHandles({ grants, files }, [{ id: 'person:ada', type: 'internal' }])
  assert.equal(adaOnly.length, 0, 'the owner does not see her own file as shared')

  await grants.revokeGrant('personal:person:ada', uploaded!.id, 'personal:person:bob', 'person:ada')
  const afterRevoke = await sharedFileHandles({ grants, files })
  assert.equal(afterRevoke.length, 0)
})

test('unwired stores answer CONTROL_UNAVAILABLE instead of pretending success', async () => {
  const surfaces = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test' })
  assert.equal(surfaces.crons, undefined)
  assert.equal(surfaces.webhooks, undefined)
  assert.equal(surfaces.mcp, undefined)
  assert.equal(surfaces.share, undefined)

  const noActor = createToolControlSurfaces({ cron: cronDeps, orgScope: 'org:test' })
  assert.ok(noActor.crons)
  const refused = await noActor.crons.cronList()
  if ('crons' in refused) return assert.fail('missing actor must answer control_unavailable')
  assert.equal(refused.code, 'control_unavailable')
})

test('playground surface: creates through the file store with qm title/validation parity', async () => {
  const fileStore = createMemoryFileStore({ blobTransfer: createMemoryBlobTransfer(), grants: createMemoryGrantLedger() })
  const surfaces = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test', files: () => fileStore })
  assert.ok(surfaces.playgrounds)

  const artifact = await surfaces.playgrounds.createPlayground({ title: '  wave   demo ', html: '<p>hi</p>' })
  assert.equal(artifact.kind, 'playground')
  assert.equal(artifact.title, 'wave demo')

  const opened = await fileStore.openForViewer(artifact.artifactId, 'feishu:ada')
  assert.ok(opened)
  assert.equal(opened.name, 'wave demo.html')
  assert.equal(opened.mimetype, 'text/html')
  assert.equal(opened.bytes.toString('utf8'), '<p>hi</p>')
  assert.equal(opened.ownerScopeId, 'personal:feishu:ada')
})

test('playground surface: honest failures for missing store, missing actor, and bad documents', async () => {
  const unwired = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test' })
  assert.equal(unwired.playgrounds, undefined)

  const fileStore = createMemoryFileStore({ blobTransfer: createMemoryBlobTransfer(), grants: createMemoryGrantLedger() })
  const noActor = createToolControlSurfaces({ orgScope: 'org:test', files: () => fileStore })
  assert.ok(noActor.playgrounds)
  await assert.rejects(noActor.playgrounds.createPlayground({ title: 't', html: '<p>x</p>' }), /not available/)

  const surfaces = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test', files: () => fileStore })
  assert.ok(surfaces.playgrounds)
  await assert.rejects(surfaces.playgrounds.createPlayground({ title: 't', html: '   ' }), /playground HTML is empty/)
  await assert.rejects(
    surfaces.playgrounds.createPlayground({ title: 't', html: 'x'.repeat(512_001) }),
    /keep it under 512000/,
  )
})
