/**
 * Kernel smoke tests: plugin lifecycle, service registry, injection waiting,
 * config validation, event dispatch modes, and effect teardown.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { Demo } from '@qm/demo'

// Mirrors FiberState (a const enum: values exist at runtime, the object does not).
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2

declare module '@qm/cordis' {
  interface Events {
    'smoke/emit'(): void
    'smoke/parallel'(): void
    'smoke/serial'(): string | undefined
    'smoke/bail'(): string | null | false | undefined
    'smoke/waterfall'(value: string, next: () => string): string
  }
}

test('plugin lifecycle: mount, provide, unmount', async () => {
  const ctx = new Context()
  assert.equal(ctx.reflect.get('demo'), undefined)

  const fiber = await ctx.plugin(Demo, { greeting: 'hi', times: 2 })
  assert.equal(fiber.state, FIBER_ACTIVE)
  assert.equal(ctx.demo.greet('qm'), 'hi, qm! hi, qm!')

  await ctx.registry.delete(Demo)
  assert.equal(ctx.registry.has(Demo), false)
  assert.equal(ctx.reflect.get('demo'), undefined)
})

test('config: omitted fields fall back to schema defaults', async () => {
  const ctx = new Context()
  await ctx.plugin(Demo, {})
  assert.equal(ctx.demo.greet('qm'), 'hello, qm!')
  await ctx.registry.delete(Demo)
})

test('config: schema validation rejects out-of-range values', async () => {
  const ctx = new Context()
  await assert.rejects(async () => { await ctx.plugin(Demo, { times: 100 }) }, /invalid config/)
})

test('inject: plugin stays pending until the required service appears', async () => {
  const ctx = new Context()
  let started = false
  const fiber = ctx.inject(['demo'], () => { started = true })

  // A pending fiber has no in-flight lifecycle work, so awaiting settles now.
  await fiber
  assert.equal(started, false)
  assert.equal(fiber.state, FIBER_PENDING)

  await ctx.plugin(Demo, { greeting: 'yo', times: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, true)

  await ctx.registry.delete(Demo)
})

test('dispatch: emit runs listeners without awaiting them', async () => {
  const ctx = new Context()
  let flag = false
  ctx.on('smoke/emit', async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    flag = true
  })
  ctx.emit('smoke/emit')
  assert.equal(flag, false)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(flag, true)
})

test('dispatch: parallel waits for all listeners and aggregates errors', async () => {
  const ctx = new Context()
  ctx.on('smoke/parallel', async () => { throw new Error('boom-1') })
  ctx.on('smoke/parallel', async () => { throw new Error('boom-2') })
  await assert.rejects(() => ctx.parallel('smoke/parallel'), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    return true
  })
})

test('dispatch: serial stops at the first bail value', async () => {
  const ctx = new Context()
  let reached = false
  ctx.on('smoke/serial', () => undefined)
  ctx.on('smoke/serial', () => 'hit')
  ctx.on('smoke/serial', () => { reached = true })
  assert.equal(await ctx.serial('smoke/serial'), 'hit')
  assert.equal(reached, false)
})

test('dispatch: bail stops synchronously at the first bail value', async () => {
  const ctx = new Context()
  let reached = false
  ctx.on('smoke/bail', () => null)
  ctx.on('smoke/bail', () => false)
  ctx.on('smoke/bail', () => 'sync-hit')
  ctx.on('smoke/bail', () => { reached = true })
  assert.equal(ctx.bail('smoke/bail'), 'sync-hit')
  assert.equal(reached, false)
})

test('dispatch: waterfall composes listeners around next()', async () => {
  const ctx = new Context()
  const order: string[] = []
  ctx.on('smoke/waterfall', (value, next) => {
    order.push('first')
    return next() + '!'
  })
  ctx.on('smoke/waterfall', (value, next) => {
    order.push('second')
    return value + 'a'
  })
  assert.equal(ctx.waterfall('smoke/waterfall', 'x', () => 'x'), 'xa!')
  assert.deepEqual(order, ['first', 'second'])
})

test('dispatch: waterfall veto stops the chain and the built-in behavior', async () => {
  const ctx = new Context()
  let innerCalled = false
  ctx.on('smoke/waterfall', value => value)
  assert.equal(ctx.waterfall('smoke/waterfall', 'x', () => { innerCalled = true; return 'x' }), 'x')
  assert.equal(innerCalled, false)
})

test('effects: disposers run on fiber unload and inactive fibers reject new effects', async () => {
  const ctx = new Context()
  let pluginCtx: Context | undefined
  let cleaned = false
  const fiber = await ctx.plugin({
    name: 'probe',
    apply(child: Context) {
      pluginCtx = child
      child.fiber.effect(() => () => { cleaned = true })
    },
  })
  assert.ok(pluginCtx)
  assert.equal(cleaned, false)

  await fiber.dispose()
  assert.equal(cleaned, true)
  assert.throws(() => pluginCtx!.fiber.effect(() => {}), /cannot create effect on inactive context/)
})
