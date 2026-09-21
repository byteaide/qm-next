/**
 * Emoji upload service (cluster 2 brief `qm-next-c2-emoji-upload`).
 *
 * Provider-neutral core ported from qm's `src/connectors/emoji-upload-service.ts`:
 * validate filename + content-type + byte cap, store the bytes via an
 * injected `DurableByteStore`, emit an audit event, then optionally call a
 * provider-side `registerEmoji` if the deployment has wired an IM provider.
 *
 * When no IM provider is wired (the current state of qm-next), the call
 * succeeds with `pendingProviderRegistration: true` so the admin UI can
 * surface "stored, awaiting provider hookup" instead of a 500.  Per the
 * brief: 502/501 stubs are replaced; Slack/Feishu-specific behaviour is
 * deferred to provider packages.
 */
import type { DurableByteStore } from '@qm/store'

export interface EmojiUploadInput {
  /** Display name for the emoji (e.g. "party-parrot"). */
  name: string
  /** MIME type from the upload; must be `image/*`. */
  contentType: string
  /** Raw image bytes. */
  bytes: Uint8Array
  /** Optional scope label (org id, surface) for the audit row. */
  scopeLabel?: string
}

export interface EmojiUploadSuccess {
  ok: true
  /** content-addressed blob key (`emojis/<sha256>`) returned by the byte store. */
  blobKey: string
  /** sha256 of the stored bytes (lowercase hex). */
  sha256: string
  sizeBytes: number
  /**
   * True when the IM provider's emoji registry is not yet wired.  The
   * bytes are durably stored; only the provider-side `registerEmoji`
   * call is skipped.
   */
  pendingProviderRegistration: boolean
}

export interface EmojiUploadError {
  ok: false
  error: string
  message: string
}

export type EmojiUploadResult = EmojiUploadSuccess | EmojiUploadError

export interface EmojiRegistry {
  /**
   * Register an emoji on the IM provider side (e.g. Feishu's custom
   * emoji API).  Implementations throw on provider failure; the service
   * converts the throw into `pendingProviderRegistration: true` so the
   * upload is not lost.
   */
  registerEmoji(input: { name: string; blobKey: string; contentType: string; sizeBytes: number }): Promise<void>
}

export interface EmojiAuditLike {
  record(event: {
    at: number
    principalId: string
    action: string
    resource: string
    scopeLabel: string
    status?: string
    detail?: string
  }): void
}

export interface EmojiUploadServiceDeps {
  bytes: DurableByteStore
  /** Provider registry; if absent we report `pendingProviderRegistration: true`. */
  provider?: EmojiRegistry
  audit?: EmojiAuditLike
  /** Max bytes accepted; defaults to 256 KiB (DoS guard). */
  maxBytes?: number
  /** Clock for the audit `at` field; defaults to `Date.now`. */
  now?: () => number
}

export interface EmojiUploadService {
  upload(principalId: string, input: EmojiUploadInput): Promise<EmojiUploadResult>
}

const DEFAULT_MAX_BYTES = 256 * 1024
const EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function createEmojiUploadService(deps: EmojiUploadServiceDeps): EmojiUploadService {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const now = deps.now ?? (() => Date.now())

  return {
    async upload(principalId, input): Promise<EmojiUploadResult> {
      if (!input.name || !EMOJI_NAME_PATTERN.test(input.name)) {
        return { ok: false, error: 'invalid_name', message: 'name must be 1-64 chars, [a-zA-Z0-9_-]' }
      }
      if (!input.contentType || !input.contentType.startsWith('image/')) {
        return { ok: false, error: 'invalid_content_type', message: 'contentType must be image/*' }
      }
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
        return { ok: false, error: 'invalid_bytes', message: 'bytes must be a non-empty Uint8Array' }
      }
      if (input.bytes.byteLength > maxBytes) {
        return {
          ok: false,
          error: 'too_large',
          message: `bytes exceed the ${maxBytes}-byte limit (received ${input.bytes.byteLength})`,
        }
      }

      const stored = await deps.bytes.put(input.bytes)
      const scopeLabel = input.scopeLabel ?? 'org:default'

      deps.audit?.record({
        at: now(),
        principalId,
        action: 'emoji.uploaded',
        resource: stored.blobKey,
        scopeLabel,
        status: 'ok',
        detail: `name=${input.name} contentType=${input.contentType} size=${stored.sizeBytes}`,
      })

      let pendingProviderRegistration = true
      if (deps.provider) {
        try {
          await deps.provider.registerEmoji({
            name: input.name,
            blobKey: stored.blobKey,
            contentType: input.contentType,
            sizeBytes: stored.sizeBytes,
          })
          pendingProviderRegistration = false
        } catch (err) {
          deps.audit?.record({
            at: now(),
            principalId,
            action: 'emoji.register_failed',
            resource: stored.blobKey,
            scopeLabel,
            status: 'provider_error',
            detail: String(err instanceof Error ? err.message : err),
          })
          // Bytes are durable; provider registration can be retried.
          pendingProviderRegistration = true
        }
      }

      return {
        ok: true,
        blobKey: stored.blobKey,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        pendingProviderRegistration,
      }
    },
  }
}