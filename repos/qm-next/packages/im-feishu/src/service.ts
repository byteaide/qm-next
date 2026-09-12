/**
 * Cordis wrapper that registers the Feishu provider with the IM registry
 * (`ctx.im`) on start and unregisters it on dispose. Composition only —
 * the provider logic itself lives in `provider.ts`.
 */
import { Service, type Context } from '@qm/cordis'
import type { ImProvider } from '@qm/im-core'
import Schema from '@qm/schemastery'
import { createFeishuProvider } from './provider.ts'
import type { FeishuChannelLike, FeishuProviderConfig, FeishuProviderDeps } from './types.ts'

export const Config = Schema.object({
  appId: Schema.string().required().description('Feishu open-platform app id (cli_*)'),
  appSecret: Schema.string().required().description('Feishu open-platform app secret'),
  instanceId: Schema.string().default('default').description('Instance label within qm-next'),
  verificationToken: Schema.string().description('Event/card callback verification token'),
  encryptKey: Schema.string().description('Event/card callback decrypt key'),
  domain: Schema.union(['feishu', 'lark']).default('feishu').description('Platform domain'),
  pingTimeoutSec: Schema.number().default(30).description('WS liveness watchdog seconds'),
}).description('Feishu IM provider configuration')

export interface FeishuProviderServiceConfig extends FeishuProviderConfig {
  /** Test/diagnostic override of the SDK channel constructor. */
  channelFactory?: (config: FeishuProviderConfig) => FeishuChannelLike
}

export class FeishuProviderService extends Service {
  static Config = Config

  static inject = ['im']

  constructor(ctx: Context, public config: FeishuProviderServiceConfig) {
    super(ctx, 'im-feishu')
  }

  async [Service.init]() {
    const deps: FeishuProviderDeps = this.config.channelFactory
      ? { channelFactory: this.config.channelFactory }
      : {}
    const provider: ImProvider = createFeishuProvider(this.config, deps)
    const dispose = await this.ctx.im.register(provider)
    return async () => {
      await dispose()
    }
  }
}

declare module '@qm/cordis' {
  interface Context {
    'im-feishu': FeishuProviderService
  }
}

export default FeishuProviderService
