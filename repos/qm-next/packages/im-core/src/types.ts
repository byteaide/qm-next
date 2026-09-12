/**
 * M2 frozen contract: provider-neutral IM types shared by `im-core` services
 * and every IM provider adapter (`im-feishu`, `im-slack`, …).
 *
 * FROZEN at 7.1 (serial gate). Provider adapters program against these types;
 * changes go back through the main session, never inside a parallel lane.
 */
import type { Destination, IncomingAttachment, OutgoingAttachment } from '@qm/types'

/** Provider key. Equal to `Destination.type` for all events and operations. */
export type ImProviderId = string

/** One configured channel instance (e.g. "feishu-prod"). Provider-scoped. */
export type ImInstanceId = string

/**
 * Blob port: how a provider reaches attachment bytes. `stage` persists
 * provider-downloaded bytes into the core blob store (inbound files);
 * `read` dereferences a core `blobId` (outbound attachments).
 */
export interface ImBlobs {
  stage(content: Uint8Array, meta?: { name?: string; mimetype?: string }): Promise<IncomingAttachment>
  read(blobId: string): Promise<Uint8Array>
}

/** Provider-native message identity plus the destination it lives in. */
export interface MessageRef {
  destination: Destination
  /** Provider message id (e.g. Slack `ts`, Feishu `message_id`). */
  messageId: string
}

/** Sender identity as the provider reports it, before directory resolution. */
export interface InboundActor {
  /** Provider-native user id (open_id / Slack user id / …). */
  providerUserId: string
  displayName?: string
  /** True when the actor is a bot (including this platform's own bot). */
  isBot?: boolean
}

/** One @-mention carried on an inbound message. */
export interface InboundMention {
  actor: InboundActor
  /** True when the mention targets the receiving bot itself. */
  isBot?: boolean
}

/**
 * What a provider can do. The delivery loop and approval flows consult these
 * flags instead of hard-coding per-platform knowledge. `react` is a reserved
 * position: v1 ships no reaction features, adapters report `false`.
 */
export interface ImCapabilities {
  /** Thread replies are supported (`Destination.threadId` honoured). */
  threads: boolean
  /** `edit` operations supported. */
  edit: boolean
  /** `delete` operations supported. */
  delete: boolean
  /** `react` operations supported (reserved: v1 reports false). */
  react: boolean
  /** Standalone `uploadFile` operations supported. */
  uploadFile: boolean
  /** Interactive cards (`card` body, interaction events) supported. */
  interactive: boolean
  /** Streaming in-place updates (edit-as-stream) supported. */
  streaming: boolean
  /** `directorySync` pushes are supported. */
  directorySync: boolean
  /** Canonical markdown support: native, provider-converted, or none. */
  markdown: 'native' | 'converted' | 'none'
}

/**
 * Provider-ready outbound body. `text` is plain text; `markdown` is canonical
 * markdown the provider formats via its format pipeline; `card` is an opaque
 * provider-native interactive payload — the contract only fixes the envelope,
 * never the card schema.
 */
export interface OutboundBody {
  text?: string
  markdown?: string
  attachments?: OutgoingAttachment[]
  card?: Record<string, unknown>
}

/** Discriminator of every outbound operation. */
export type OutboundOperationKind = 'send' | 'edit' | 'delete' | 'uploadFile' | 'react'

/** Receipt for one applied outbound operation. */
export interface OutboundReceipt {
  op: OutboundOperationKind
  /** Created/updated message ref for send/edit/uploadFile; absent for delete/react. */
  ref?: MessageRef
  /** Provider file handle for uploadFile. */
  fileRef?: string
}

/** Sentinel thrown/emitted when a provider does not implement an operation. */
export const IM_UNSUPPORTED_OP = 'IM_UNSUPPORTED_OP' as const
