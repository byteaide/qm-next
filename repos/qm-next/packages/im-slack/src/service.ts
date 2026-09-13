/**
 * Cordis wrapper that registers the Slack provider with the IM registry
 * (`ctx.im`) on start and unregisters it on dispose. Composition only —
 * the provider logic itself lives in `provider.ts`.
 */
import { Service, type Context } from '@qm/cordis'
import type { ImProvider } from '@qm/im-core'
import Schema from '@qm/schemastery'
import { createSlackProvider } from './provider.ts'
import type { SlackClientsLike, SlackProviderConfig, SlackProviderDeps, SlackSocketLike } from './types.ts'

export const Config = Schema.object({
  appToken: Schema.string().required().description('Slack app-level token for Socket Mode (xapp-*)'),
  botToken: Schema.string().required().description('Slack bot user token (xoxb-*)'),
  instanceId: Schema.string().default('default').description('Instance label within qm-next'),
}).description('Slack IM provider configuration')

export interface SlackProviderServiceConfig extends SlackProviderConfig {
  /** Test/diagnostic override of the SocketModeClient constructor. */
  socketFactory?: (config: SlackProviderConfig) => SlackSocketLike
  /** Test/diagnostic override of the WebClient constructor. */
  clientsFactory?: (config: SlackProviderConfig) => SlackClientsLike
}

export class SlackProviderService extends Service {
  static Config = Config

  static inject = ['im']

  constructor(ctx: Context, public config: SlackProviderServiceConfig) {
    super(ctx, 'im-slack')
  }

  async [Service.init]() {
    const deps: SlackProviderDeps = {}
    if (this.config.socketFactory) deps.socketFactory = this.config.socketFactory
    if (this.config.clientsFactory) deps.clientsFactory = this.config.clientsFactory
    const provider: ImProvider = createSlackProvider(this.config, deps)
    const dispose = await this.ctx.im.register(provider)
    return async () => {
      await dispose()
    }
  }
}

declare module '@qm/cordis' {
  interface Context {
    'im-slack': SlackProviderService
  }
}

export default SlackProviderService
