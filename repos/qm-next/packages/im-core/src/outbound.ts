/**
 * Outbound operations: the unit of work providers execute and the delivery
 * queue stores. One operation, one receipt. Adapters must apply operations
 * independently — no cross-operation ordering guarantees beyond array order.
 */
import type { Destination, OutgoingAttachment } from '@qm/types'
import type { MessageRef, OutboundBody, OutboundOperationKind, OutboundReceipt } from './types.ts'

/** Send a message (text, markdown, attachments, or interactive card). */
export interface SendOperation {
  op: 'send'
  destination: Destination
  body: OutboundBody
  /** Thread to reply into (capabilities.threads). */
  threadId?: string
  /** Message to reply to; providers derive or create the thread. */
  replyToMessageId?: string
}

/** Edit a previously sent message in place (streaming replies build on this). */
export interface EditOperation {
  op: 'edit'
  ref: MessageRef
  body: OutboundBody
}

/** Recall/delete a previously sent message. */
export interface DeleteOperation {
  op: 'delete'
  ref: MessageRef
}

/**
 * Upload bytes to the provider, returning a file handle that later `send`
 * attachments may reference instead of re-uploading.
 */
export interface UploadFileOperation {
  op: 'uploadFile'
  destination: Destination
  file: OutgoingAttachment
  content: Uint8Array
}

/** Add or remove an emoji reaction. Reserved position: v1 reports no support. */
export interface ReactOperation {
  op: 'react'
  ref: MessageRef
  emoji: string
  action: 'add' | 'remove'
}

export type OutboundOperation =
  | SendOperation
  | EditOperation
  | DeleteOperation
  | UploadFileOperation
  | ReactOperation

export type { OutboundOperationKind, OutboundReceipt }
