/**
 * ImRegistry: start/stop lifecycle, dedup, drain-on-dispose, service wiring.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import type { ImCapabilities, ImProvider, ImProviderStartContext } from '@qm/im-core'
import { IM_UNSUPPORTED_OP } from '@qm/im-core'
import { createImRegistry, ImRegistryService } from '@qm/im-core/runtime'

function capabilities(overrides: Partial<ImCapabilities> = {}): ImCapabilities {
  return {
    threads: true,
    edit: true,
    delete: true,
    react: false,
    uploadFile: true,
    interactive: true,
    streaming: true,
    directorySync: true,
    markdown: 'converted',
    ...overrides,
  }
}

function fakeProvider(overrides: Partial<ImProvider> = {}): ImProvider {
  return {
    provider: 'fake',
    instanceId: 'test',
    capabilities: () => capabilities(),
    start: async () => {},
    stop: async () => {},
    outbound: async (ops) => ops.map((op) => ({ op: op.op })),
    format: (markdown) => ({ text: markdown }),
    destination: (chatId) => ({ type: 'fake', target: chatId }),
    ...overrides,
  }
}

test('register resolves with intake live and dispose parks it stopped', async () => {
  const received: string[] = []
  const registry = createImRegistry({
    onEvent: async (events) => {
      for (const e of events) received.push(e.eventId)
    },
  })
  const disposer = await registry.register(fakeProvider())
  assert.equal(registry.status('fake'), 'running')
  assert.deepEqual(registry.listProviderIds(), ['fake'])
  await disposer()
  assert.equal(registry.status('fake'), 'stopped')
  assert.equal(received.length, 0)
})

test('emit flows to onEvent with eventId dedup', async () => {
  const received: string[] = []
  const registry = createImRegistry({ onEvent: async (events) => { for (const e of events) received.push(e.eventId) } })
  let startCtx: ImProviderStartContext | undefined
  const disposer = await registry.register(fakeProvider({ start: async (c) => { startCtx = c } }))
  await startCtx!.emit({ kind: 'message', provider: 'fake', instanceId: 'test', eventId: 'm1', occurredAt: 1, receivedAt: 2, destination: { type: 'fake', target: 'c1' }, actor: { providerUserId: 'u1' }, text: 'hi' })
  await startCtx!.emit({ kind: 'message', provider: 'fake', instanceId: 'test', eventId: 'm1', occurredAt: 1, receivedAt: 3, destination: { type: 'fake', target: 'c1' }, actor: { providerUserId: 'u1' }, text: 'hi' })
  await startCtx!.emit({ kind: 'message', provider: 'fake', instanceId: 'test', eventId: 'm2', occurredAt: 4, receivedAt: 5, destination: { type: 'fake', target: 'c1' }, actor: { providerUserId: 'u1' }, text: 'again' })
  assert.deepEqual(received, ['m1', 'm2'])
  await disposer()
})

test('duplicate registration is rejected; failed start rejects and removes the entry', async () => {
  const registry = createImRegistry({ onEvent: async () => {} })
  const disposer = await registry.register(fakeProvider())
  await assert.rejects(() => registry.register(fakeProvider()), /already registered/)
  await assert.rejects(
    () => registry.register(fakeProvider({ provider: 'boom', start: async () => { throw new Error('no socket') } })),
    /no socket/,
  )
  assert.equal(registry.get('boom'), undefined)
  assert.equal(registry.status('boom'), 'stopped')
  await disposer()
})

test('disposer aborts the signal, calls stop, drains in-flight dispatches, idempotent', async () => {
  const events: string[] = []
  let releaseOnEvent: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseOnEvent = resolve })
  let stopCalls = 0
  let aborted = false
  const registry = createImRegistry({
    onEvent: async () => {
      events.push('dispatched')
      await gate
    },
  })
  let startCtx: ImProviderStartContext | undefined
  const disposer = await registry.register(fakeProvider({
    start: async (c) => { startCtx = c },
    stop: async () => { stopCalls += 1; aborted = startCtx!.signal.aborted },
  }))
  const dispatching = startCtx!.emit({ kind: 'message', provider: 'fake', instanceId: 'test', eventId: 'm1', occurredAt: 1, receivedAt: 2, destination: { type: 'fake', target: 'c1' }, actor: { providerUserId: 'u1' }, text: 'hi' })
  const dispose = disposer()
  releaseOnEvent!()
  await Promise.all([dispatching, dispose, dispose])
  assert.equal(stopCalls, 1)
  assert.equal(aborted, true, 'stop() observes the aborted signal')
  assert.deepEqual(events, ['dispatched'], 'in-flight dispatch drained before dispose resolved')
  assert.equal(registry.status('fake'), 'stopped')
})

test('unsupported sentinel constant is exported for adapters', () => {
  assert.equal(IM_UNSUPPORTED_OP, 'IM_UNSUPPORTED_OP')
})

test('ImRegistryService exposes ctx.im and drains on fiber dispose', async () => {
  const received: string[] = []
  const ctx = new Context()
  let stopped = false
  const fiber = await ctx.plugin(ImRegistryService, {
    onEvent: async (events) => { for (const e of events) received.push(e.eventId) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  const service = ctx.im
  let startCtx: ImProviderStartContext | undefined
  const disposer = await service.register(fakeProvider({
    start: async (c) => { startCtx = c },
    stop: async () => { stopped = true },
  }))
  await startCtx!.emit({ kind: 'message', provider: 'fake', instanceId: 'test', eventId: 'm1', occurredAt: 1, receivedAt: 2, destination: { type: 'fake', target: 'c1' }, actor: { providerUserId: 'u1' }, text: 'hi' })
  assert.deepEqual(received, ['m1'])
  await fiber.dispose()
  assert.equal(stopped, true, 'service unload drains providers')
  assert.equal(service.status('fake'), 'stopped')
  void disposer
})
