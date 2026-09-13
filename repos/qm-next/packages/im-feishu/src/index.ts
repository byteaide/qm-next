/**
 * @qm/im-feishu — Feishu (Lark) provider adapter for the @qm/im-core
 * contract. WS long connection via @larksuiteoapi/node-sdk createLarkChannel.
 */
export { createFeishuProvider } from './provider.ts'
export { createInboundMapper } from './map-inbound.ts'
export { createLarkApprovalCardRenderer, larkApprovalCard } from './card-renderer.ts'
export { Config, FeishuProviderService, default } from './service.ts'
export type { FeishuProviderServiceConfig } from './service.ts'
export type { FeishuProviderConfig, FeishuProviderDeps, FeishuChannelLike } from './types.ts'
