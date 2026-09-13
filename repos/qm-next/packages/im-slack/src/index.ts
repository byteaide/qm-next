/**
 * @qm/im-slack — Slack provider adapter for the @qm/im-core contract.
 * Inbound over @slack/socket-mode (websocket, no public callback URL);
 * outbound via @slack/web-api. Markdown converts through the ported
 * mrkdwn pipeline; approval cards are Block Kit.
 */
export { createSlackProvider } from './provider.ts'
export { createInboundMapper } from './map-inbound.ts'
export type { SlackIdentity } from './map-inbound.ts'
export { createSlackApprovalCardRenderer, slackApprovalCard, SLACK_APPROVAL_ACTION } from './card-renderer.ts'
export { toSlackMrkdwn, stripMention, decodeSlackEntities, neutralizeMassMentions } from './mrkdwn.ts'
export { Config, SlackProviderService, default } from './service.ts'
export type { SlackProviderServiceConfig } from './service.ts'
export type { SlackProviderConfig, SlackProviderDeps, SlackSocketLike, SlackClientsLike, SlackHandlerPayload } from './types.ts'
