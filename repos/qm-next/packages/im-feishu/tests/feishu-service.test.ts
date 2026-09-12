/**
 * FeishuProviderService: registers the provider into ctx.im on start and
 * unregisters it on dispose. Uses an injected channel factory so no real
 * socket is opened.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { ImRegistryService } from '@qm/im-core/runtime'
import { FeishuProviderService, type FeishuProviderServiceConfig } from '../src/index.ts'
import type { FeishuChannelLike } from '../src/index.ts'

function stubChannel(): FeishuChannelLike {
  return {
    connect: async () => {},
    disconnect: async () => {},
    on: (() => () => {}) as unknown as FeishuChannelLike['on'],
    send: async () => ({ messageId: 'm1' }),
    editMessage: async () => {},
    updateCard: async () => {},
    recallMessage: async () => {},
    downloadResource: async () => Buffer.alloc(0),
    getChatInfo: async () => ({}),
  } as unknown as FeishuChannelLike
}

test('FeishuProviderService registers into ctx.im and dispose unregisters', async () => {
  const ctx = new Context()
  new ImRegistryService(ctx, { onEvent: async () => {} })
  const config: FeishuProviderServiceConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    instanceId: 'test',
    channelFactory: () => stubChannel(),
  }
  const fiber = await ctx.plugin(FeishuProviderService, config)
  assert.equal(ctx.im.status('feishu'), 'running')
  await fiber.dispose()
  assert.equal(ctx.im.status('feishu'), 'stopped')
})

test('provider start failure fails the service fiber', async () => {
  const ctx = new Context()
  new ImRegistryService(ctx, { onEvent: async () => {} })
  const config: FeishuProviderServiceConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    instanceId: 'test',
    channelFactory: () => {
      throw new Error('sdk unavailable')
    },
  }
  await assert.rejects(async () => {
    await ctx.plugin(FeishuProviderService, config)
  }, /sdk unavailable/)
})
