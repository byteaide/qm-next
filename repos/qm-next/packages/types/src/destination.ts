/**
 * Delivery destination descriptor.
 *
 * `type` is the surface type (e.g. "feishu", "slack", "web") and is always
 * explicit — no default surface exists anywhere in the platform. Thread
 * semantics use the surface-neutral `threadId` (replaces qm's Slack-shaped
 * `threadTs`).
 */
import type { ScopeId } from './identity.ts'

export interface Destination {
  type: string
  target: string
  threadId?: string
  audienceScopeId?: ScopeId
  onBehalfOf?: string
  identity?: string
}

export interface AttachmentBase {
  name: string
  mimetype: string
  sizeBytes: number
  blobId: string
}

export type IncomingAttachment = AttachmentBase & {
  sourceId?: string
  author?: string
}

export type OutgoingAttachment = AttachmentBase & {
  artifactId?: string
  artifactViewerId?: string
}
