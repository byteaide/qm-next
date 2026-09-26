/**
 * Agent capability tokens (qm `src/auth/capability-token.ts`): short-lived
 * signed claims minted by the control plane for agents — share links,
 * secret drops, blob transfers, the egress proxy and the credential
 * broker each gate on their audience claim. The minting org id rides the
 * payload (qm reads a global config).
 *
 * Payload compression (qm-post-soul p003 lane B, 2026-09-26):
 *
 * Optional opt-in compression keeps the legacy wire shape unchanged
 * when off, and adds a `gzip1.<base64url-gzip-bytes>` envelope under the
 * `__qm_cap_compressed_v1` marker when on. The JWS signature covers the
 * exact bytes that go on the wire either way — `verifyCapabilityToken`
 * sniffs the marker, decompresses, restores `orgId`, and re-runs the
 * existing field-by-field validation against the decompressed claims.
 *
 * Wire envelope shapes:
 *   legacy: { orgId, actorId, scopeId, exp, ...rest }              // current
 *   new:    { orgId, __qm_cap_compressed_v1: 'gzip1',
 *             data: 'gzip1.<base64url-gzip-bytes>' }              // opt-in
 *
 * Operator knob: `packages/auth/config/compress-tokens: true` (see
 * `docs/operations.md` §15). The auth package ships the helpers + per-mint
 * `{ compress }` option; composition root wires the config flag.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { mintSignedPayload, verifySignedPayload } from './signed-token.ts'

/**
 * Wire-level compression flag for capability token payloads. Used as the
 * prefix on `data` (`<flag>.<base64url-gzip-bytes>`) so a verifier can
 * sniff the envelope before invoking the gzip decoder.
 */
export const COMPRESS_FLAG = 'gzip1' as const

/**
 * JSON byte threshold below which compression is a net loss (gzip header
 * + base64url expansion outweigh the savings). The per-mint `{ compress }`
 * option respects this gate — `{ compress: false }` skips compression even
 * for huge claims; `{ compress: true }` compresses even small claims when
 * the operator is explicit.
 */
export const CAPABILITY_COMPRESS_THRESHOLD = 1024

/**
 * Sanity ceiling — beyond `THRESHOLD × 32` (32 KB) the JSON shape is
 * either pathological or adversarial, and CPU spent decompressing on
 * verify doesn't pay off against typical wire savings. Throw
 * `compression_oversize` at mint time to fail loud. 32 KB is well
 * above any real capability-token claim we've seen in practice; real
 * payloads (keychain members × ~30) land in the 6-12 KB band.
 */
export const CAPABILITY_COMPRESS_CEILING = CAPABILITY_COMPRESS_THRESHOLD * 32

/**
 * Envelope marker that tells `verifyCapabilityToken` to decompress `data`
 * before running claim validation. Picked to be unambiguous against any
 * plausible claim key (`__`-prefixed + versioned + qm-namespaced) and
 * reserved forever — the verification layer short-circuits to the
 * decompressed branch on this single key.
 */
export const CAPABILITY_COMPRESS_MARKER = '__qm_cap_compressed_v1' as const

/**
 * Stable error codes for compression protocol errors. Consumers can
 * switch on `err.code` without parsing localized messages. Codes:
 *
 *   `compression_oversize`     — mint-time ceiling exceeded (adversarial payload)
 *   `not_a_compressed_payload` — `decompressPayload` called on text without the
 *                                  `gzip1.` prefix
 *   `decompression_failed`     — base64url decode or gunzip decode failed
 */
export class CapabilityTokenError extends Error {
  readonly code:
    | 'compression_oversize'
    | 'not_a_compressed_payload'
    | 'decompression_failed'

  constructor(
    code: CapabilityTokenError['code'],
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'CapabilityTokenError'
  }
}

export const CAPABILITY_TTL_MS = 60 * 60_000

export const CONTROL_PLANE_AUD = 'control-plane'
export const OAUTH_CONSENT_AUD = 'oauth-consent'
export const CREDENTIAL_BROKER_AUD = 'credential-broker'
export const EGRESS_PROXY_AUD = 'egress-proxy'
export const BLOB_TRANSFER_AUD = 'blob-transfer'
export const SECRET_DROP_AUD = 'secret-drop'

interface BlobGrant {
  dir: 'read' | 'write'
  id?: string
}

type BlobTransferClaims = CapabilityClaims & { aud: typeof BLOB_TRANSFER_AUD; blob: BlobGrant }

export interface CapabilityClaims {
  actorId: string
  aud?: string
  scopeId: string
  scopeVersion?: string
  timezone?: string
  destination?: unknown
  destinations?: unknown[]
  defaultDestinationKey?: string
  credentials?: string[]
  members?: unknown[]
  keychainMembers?: unknown[]
  privateScope?: boolean
  egress?: unknown
  blob?: BlobGrant
  drop?: string
  memory?: { write?: string; orgWrite?: string; read: string[] }
  liveActor?: boolean
  botActor?: boolean
  liveAuthor?: boolean
  triggered?: boolean
  grants?: string[]
  threadRef?: string
  exp: number
}

export function mintCapabilityToken(claims: CapabilityClaims, secret: string, orgId: string, opts: { compress?: boolean } = {}): Promise<string> {
  const shouldCompress = opts.compress === true
  if (!shouldCompress) {
    // Legacy wire shape — the qm-verbatim port behavior. Default off so
    // existing callers see no surprise change.
    return mintSignedPayload({ orgId, ...claims }, secret)
  }
  // Opt-in compression path. The JWS payload field is a small envelope
  // carrying only `orgId` + the marker + the gzipped claims-as-data-uri.
  // The JWS signature covers the exact bytes — verify-after-decompress is
  // guaranteed by the marker sniff in `verifyCapabilityToken`.
  const claimsJson = JSON.stringify(claims)
  const data = compressPayload(claimsJson)
  return mintSignedPayload({ orgId, [CAPABILITY_COMPRESS_MARKER]: COMPRESS_FLAG, data }, secret)
}

/**
 * Compress a JSON-serialized claims object into a wire-ready string.
 *
 * Returns: `'gzip1.<base64url-gzip-bytes>'`
 *
 * Throws `CapabilityTokenError { code: 'compression_oversize' }` if the
 * input exceeds `CAPABILITY_COMPRESS_CEILING` bytes (sanity ceiling —
 * gzip can't win beyond that, abort to avoid wasting CPU on adversarial
 * payloads).
 */
export function compressPayload(json: string): string {
  if (json.length > CAPABILITY_COMPRESS_CEILING) {
    throw new CapabilityTokenError(
      'compression_oversize',
      `payload size ${json.length} exceeds ceiling ${CAPABILITY_COMPRESS_CEILING}; not compressing`,
    )
  }
  const buf = gzipSync(Buffer.from(json, 'utf8'))
  return `${COMPRESS_FLAG}.${buf.toString('base64url')}`
}

/**
 * Reverse of `compressPayload`. Sniffs the `gzip1.` prefix, gunzips the
 * base64url-encoded bytes, returns the original JSON string. Throws
 * `CapabilityTokenError` with a stable `code` on any decode failure so
 * callers can switch on the code rather than parse messages.
 */
export function decompressPayload(text: string): string {
  const prefix = `${COMPRESS_FLAG}.`
  if (!text.startsWith(prefix)) {
    throw new CapabilityTokenError(
      'not_a_compressed_payload',
      `payload does not start with '${prefix}'`,
    )
  }
  const b64 = text.slice(prefix.length)
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64url')
  } catch (err) {
    throw new CapabilityTokenError(
      'decompression_failed',
      `base64url decode failed: ${(err as Error).message}`,
    )
  }
  let json: string
  try {
    json = gunzipSync(buf).toString('utf8')
  } catch (err) {
    throw new CapabilityTokenError(
      'decompression_failed',
      `gunzip failed: ${(err as Error).message}`,
    )
  }
  return json
}

/**
 * Sniff a wire-format payload for the compression flag prefix. Pure
 * string-prefix check — does not decode or parse anything. Useful in
 * callers that want to surface a flag indicator before invoking the
 * full decompressor (e.g. observability dashboards, debug tooling).
 */
export function isCompressedPayload(text: string): boolean {
  return text.startsWith(`${COMPRESS_FLAG}.`)
}

export function isValidCapabilityTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string') return false
  if (timezone.length === 0 || timezone.length > 64 || timezone.trim() !== timezone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

export async function verifyCapabilityToken(token: string, secret: string | string[], now: number = Date.now()): Promise<CapabilityClaims | null> {
  const outer = (await verifySignedPayload(token, secret)) as Record<string, unknown> | null
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return null

  // Transparent compression handling (qm-post-soul p003 lane B, 2026-09-26):
  // sniffs the marker, decompresses `data`, restores `orgId`. Any decode
  // error fails closed (returns null). Legacy envelopes (no marker) skip
  // this branch entirely — wire shape unchanged for legacy tokens.
  const claims = await resolveCapabilityEnvelope(outer)
  if (!claims) return null

  if (typeof claims.actorId !== 'string' || typeof claims.scopeId !== 'string' || typeof claims.exp !== 'number') {
    return null
  }
  if (claims.timezone !== undefined && !isValidCapabilityTimezone(claims.timezone)) return null
  if (claims.scopeVersion !== undefined && typeof claims.scopeVersion !== 'string') return null
  if (claims.destinations !== undefined && !Array.isArray(claims.destinations)) return null
  if (claims.credentials !== undefined && !Array.isArray(claims.credentials)) return null
  if (claims.grants !== undefined && (!Array.isArray(claims.grants) || !claims.grants.every((g) => typeof g === 'string'))) {
    return null
  }
  if (claims.keychainMembers !== undefined && !Array.isArray(claims.keychainMembers)) return null
  if (claims.memory !== undefined && !Array.isArray(claims.memory?.read)) return null
  if (claims.liveActor !== undefined && typeof claims.liveActor !== 'boolean') return null
  if (claims.botActor !== undefined && typeof claims.botActor !== 'boolean') return null
  if (claims.liveAuthor !== undefined && typeof claims.liveAuthor !== 'boolean') return null
  if (claims.blob !== undefined && claims.blob?.dir !== 'read' && claims.blob?.dir !== 'write') return null
  if (claims.drop !== undefined && typeof claims.drop !== 'string') return null
  if (now >= claims.exp) return null
  return claims
}

/**
 * Resolve a signed payload into typed `CapabilityClaims`, transparently
 * decompressing the opt-in compressed envelope. Returns `null` on any
 * decode failure (fail-closed) so callers can treat compressed and
 * legacy tokens through a single return-shape contract.
 */
async function resolveCapabilityEnvelope(outer: Record<string, unknown>): Promise<CapabilityClaims | null> {
  if (outer[CAPABILITY_COMPRESS_MARKER] !== COMPRESS_FLAG) {
    // Legacy envelope — wire shape unchanged since the qm-verbatim port.
    return outer as unknown as CapabilityClaims
  }
  if (typeof outer.data !== 'string') return null
  let claimsJson: string
  try {
    claimsJson = decompressPayload(outer.data)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(claimsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // Restore `orgId` from the outer envelope so downstream callers see
  // the same shape whether the token was minted compressed or legacy.
  if (typeof outer.orgId === 'string') {
    (parsed as Record<string, unknown>).orgId = outer.orgId
  }
  return parsed as CapabilityClaims
}

const BLOB_ID = /^[0-9a-f]{32}$/

export async function verifyBlobTransferCapability(
  token: string,
  secret: string | string[],
  expected: { dir: 'read'; id: string } | { dir: 'write' },
  now: number = Date.now(),
): Promise<BlobTransferClaims | null> {
  const claims = await verifyCapabilityToken(token, secret, now)
  const grant = claims?.blob
  if (!claims || claims.aud !== BLOB_TRANSFER_AUD || !grant || grant.dir !== expected.dir) return null
  if (grant.id !== undefined && (typeof grant.id !== 'string' || !BLOB_ID.test(grant.id))) return null
  if (expected.dir === 'read' ? grant.id !== expected.id : grant.id !== undefined) return null
  return claims as BlobTransferClaims
}
