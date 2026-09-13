/**
 * Slack provider configuration and the structural slices of
 * `@slack/socket-mode` + `@slack/web-api` the adapter consumes. Tests
 * inject fixture doubles; production wires the real clients.
 */
import type { ImBlobs, ImLogger } from '@qm/im-core'

/** Provider config (schemastery schema in service.ts mirrors these fields). */
export interface SlackProviderConfig {
  /** Slack app-level token for Socket Mode (`xapp-*`). */
  appToken: string
  /** Slack bot user token (`xoxb-*`). */
  botToken: string
  /** Instance label within qm-next (e.g. "prod"). */
  instanceId: string
}

/** Raw socket-mode handler payload: the envelope body plus typed extras. */
export interface SlackHandlerPayload {
  /** Socket Mode acknowledgement — must be called once per envelope. */
  ack(): void
  /** Envelope body (`event_callback` payload or interactive payload). */
  body: Record<string, unknown>
  /** Events API event body (present on event handlers). */
  event?: Record<string, unknown>
}

/** Structural slice of the SocketModeClient the adapter touches. */
export interface SlackSocketLike {
  on(name: string, handler: (payload: SlackHandlerPayload) => void | Promise<void>): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
}

/** Structural slice of the WebClient the adapter touches. */
export interface SlackClientsLike {
  auth: {
    test(): Promise<{ user_id?: string; bot_id?: string; user?: string }>
  }
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string; channel?: string }>
    update(args: Record<string, unknown>): Promise<{ ts?: string; channel?: string }>
    delete(args: Record<string, unknown>): Promise<{ ts?: string; channel?: string }>
  }
  files?: {
    uploadV2(args: Record<string, unknown>): Promise<unknown>
  }
  users: {
    list(args?: Record<string, unknown>): Promise<{
      members?: Array<Record<string, unknown>>
      response_metadata?: { next_cursor?: string }
    }>
  }
  conversations: {
    list(args?: Record<string, unknown>): Promise<{
      channels?: Array<Record<string, unknown>>
      response_metadata?: { next_cursor?: string }
    }>
  }
}

export interface SlackProviderDeps {
  /** Override the socket constructor (fixture tests inject recordings). */
  socketFactory?: (config: SlackProviderConfig) => SlackSocketLike
  /** Override the web-client constructor (fixture tests inject recordings). */
  clientsFactory?: (config: SlackProviderConfig) => SlackClientsLike
  logger?: ImLogger
  /** Blob port; when absent, inbound file attachments are dropped with a warning. */
  blobs?: ImBlobs
}
