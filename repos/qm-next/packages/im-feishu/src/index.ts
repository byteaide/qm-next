/**
 * @qm/im-feishu — Feishu (Lark) provider adapter for the @qm/im-core
 * contract. WS long connection via @larksuiteoapi/node-sdk createLarkChannel.
 */
import Schema from '@qm/schemastery'
import { createFeishuProvider } from './provider.ts'
import { createInboundMapper } from './map-inbound.ts'
import type { FeishuProviderConfig, FeishuProviderDeps, FeishuChannelLike } from './types.ts'

export const Config = Schema.object({
  appId: Schema.string().required().description('Feishu open-platform app id (cli_*)'),
  appSecret: Schema.string().required().description('Feishu open-platform app secret'),
  instanceId: Schema.string().default('default').description('Instance label within qm-next'),
  verificationToken: Schema.string().description('Event/card callback verification token'),
  encryptKey: Schema.string().description('Event/card callback decrypt key'),
  domain: Schema.union(['feishu', 'lark']).default('feishu').description('Platform domain'),
  pingTimeoutSec: Schema.number().default(30).description('WS liveness watchdog seconds'),
}).description('Feishu IM provider configuration')

export { createFeishuProvider, createInboundMapper }
export type { FeishuProviderConfig, FeishuProviderDeps, FeishuChannelLike }
