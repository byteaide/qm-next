/**
 * Smaller parity lanes (12.0 control-plane wired): the credential broker
 * (aud-gated over the keychain service-credential reader), secret drops
 * (capability-minted credential request links), emoji upload (capability
 * gate + browser-session 404), the egress audit sink ingest, and the auth
 * broker (single-use nonce claims over the durable replay store → qm's 503
 * when not durable; email allow-list → identity-unwired false).
 */
import { CREDENTIAL_BROKER_AUD, type ReplayDedupe } from '@qm/auth'
import type { AuditLog, CredentialUsageSink } from '@qm/admin'
import type { SecretDropStore } from '../services/secret-drop-store.ts'
import type { EgressAuditSink } from '../services/egress-audit-sink.ts'
import { brokerCredentialCall, realBrokerFetch, type BrokerFetch, type ServiceCredentialReader } from '../credential-broker.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

// --- credentials broker ---

export interface CredentialDeps {
  orgScope: string
  /** Service credential reader (the keychain); the route 404s without one. */
  reader?: ServiceCredentialReader
  fetchImpl?: BrokerFetch
  usage?: CredentialUsageSink
  auditLog?: AuditLog
}

export function credentialRoutes(deps: CredentialDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/credentials/broker',
      auth: { aud: CREDENTIAL_BROKER_AUD },
      handle: async (ctx) => {
        if (!deps.reader) return sendJson(ctx, 404, { error: 'not_found' })
        const capability = ctx.capability!
        const result = await brokerCredentialCall({
          claims: capability,
          body: (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>,
          orgScopeId: deps.orgScope,
          reader: deps.reader,
          fetchImpl: deps.fetchImpl ?? realBrokerFetch,
          ...(deps.usage ? { usage: deps.usage } : {}),
          audit: (event) =>
            deps.auditLog?.record({
              at: Date.now(),
              principalId: event.principalId,
              action: event.action,
              resource: event.resource,
              scopeLabel: event.scopeLabel,
              ...(event.status !== undefined ? { status: event.status } : {}),
              ...(event.detail !== undefined ? { detail: event.detail } : {}),
            }),
        })
        return sendJson(ctx, result.status, result.json)
      },
    },
  ]
}

// --- secret drops ---

export interface SecretDropDeps {
  drops: SecretDropStore
  /** Public web base URL; without it `url` is the form path itself. */
  publicUrl?: string
  orgId?: string
}

const MAX_DROP_FIELDS = 8
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface DropFieldInput {
  key: string
  label?: string
  secret?: boolean
}

function parseDropFields(raw: unknown): DropFieldInput[] | 'invalid' {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DROP_FIELDS) return 'invalid'
  const out: DropFieldInput[] = []
  const seen = new Set<string>()
  for (const f of raw) {
    const key = (f as { key?: unknown })?.key
    if (typeof key !== 'string' || !ENV_KEY_RE.test(key) || seen.has(key)) return 'invalid'
    seen.add(key)
    const labelRaw = (f as { label?: unknown })?.label
    const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, 80) : undefined
    const secretRaw = (f as { secret?: unknown })?.secret
    const secret = secretRaw === false ? false : true
    out.push({ key, ...(label ? { label } : {}), ...(secret === false ? { secret } : {}) })
  }
  return out
}

function formFieldsHtml(fields?: Array<{ key: string; label?: string; secret?: boolean }>): string {
  const resolved =
    fields?.length
      ? fields.map((f) => ({ key: f.key, label: f.label ?? f.key, secret: f.secret !== false }))
      : [{ key: 'secret', label: 'Paste the secret here', secret: true }]
  return resolved
    .map((f) => `<input name="${f.key}" type="password" placeholder="${f.label}" autocomplete=off style="width:100%;padding:.5rem;margin-bottom:.6rem">`)
    .join('\n')
}

async function mintDrop(ctx: ApiRouteContext, deps: SecretDropDeps): Promise<unknown> {
  const capability = ctx.capability
  if (!capability) {
    return sendJson(ctx, 401, {
      error: 'unauthorized',
      message: 'secret-drop mint requires an agent capability token',
    })
  }
  if (capability.triggered) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'automated triggers cannot mint secret drops' })
  }
  const b = (isObj(ctx.body) ? ctx.body : {}) as {
    title?: unknown
    purpose?: unknown
    fields?: unknown
    grantMode?: unknown
  }
  const purpose = typeof b.purpose === 'string' && b.purpose.trim() ? b.purpose.trim().slice(0, 200) : undefined
  if (!purpose) return badRequest(ctx, 'purpose required')
  const service = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 120) : 'credential'
  let fields: DropFieldInput[] | undefined
  if (b.fields !== undefined) {
    const parsed = parseDropFields(b.fields)
    if (parsed === 'invalid') {
      return badRequest(ctx, `fields must hold 1 to ${MAX_DROP_FIELDS} { key, label?, secret? } entries with unique env-style keys`)
    }
    fields = parsed
  }
  if (b.grantMode !== undefined && b.grantMode !== 'once' && b.grantMode !== 'standing') {
    return badRequest(ctx, 'grantMode must be "once" or "standing"')
  }
  const { dropId } = await deps.drops.mint({
    ownerId: capability.actorId,
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
    service,
    purpose,
    requestedBy: capability.actorId,
    ...(fields ? { fields } : {}),
    ...(b.grantMode !== undefined ? { grantMode: b.grantMode } : {}),
    ...(capability.threadRef ? { threadRef: capability.threadRef } : {}),
    ...(capability.scopeId ? { audienceScopeId: capability.scopeId } : {}),
    requiresToken: true,
  })
  const formPath = `/v1/keychain/drops/${dropId}/form`
  return {
    dropId,
    formPath,
    url: deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, '')}${formPath}` : formPath,
  }
}

async function dropForm(ctx: ApiRouteContext, deps: SecretDropDeps): Promise<void> {
  const id = ctx.params.id
  const peeked = id ? await deps.drops.peek(id) : ({ ok: false, reason: 'invalid' } as const)
  if (!peeked.ok) {
    ctx.reply.raw.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    ctx.reply.raw.end('<!doctype html><meta charset=utf-8><title>Secret drop</title><body><h2>This link has expired</h2><p>Secret-drop links are single-use. Ask the agent for a fresh one.</p></body>')
    return
  }
  const rec = peeked.rec
  ctx.reply.raw.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  ctx.reply.raw.end(
    `<!doctype html><meta charset=utf-8><title>Provide a credential</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h2>Provide your ${rec.service} credential</h2>
<p style="color:#555">The agent asked for this so it can: <b>${rec.purpose}</b></p>
<form method="POST" action="/v1/keychain/drops/${rec.dropId}">
${formFieldsHtml(rec.fields)}
<button style="font-size:1rem;padding:.6rem 1.2rem">Submit securely</button>
</form>
<p style="color:#888;font-size:.85rem">What you enter goes straight to the keychain and is encrypted at rest. It is never shown in chat. This link works once.</p>
</body>`,
  )
}

async function redeemDrop(ctx: ApiRouteContext, deps: SecretDropDeps): Promise<unknown> {
  const id = ctx.params.id
  const b = isObj(ctx.body) ? (ctx.body as { secret?: unknown; values?: unknown }) : {}
  const peeked = id ? await deps.drops.peek(id) : null
  if (!peeked || !peeked.ok) {
    const message =
      peeked && peeked.reason === 'expired'
        ? 'this drop link has expired — ask the agent for a fresh one'
        : 'this drop link is invalid or was already used — ask the agent for a fresh one'
    return sendJson(ctx, 404, { error: 'not_found', message })
  }
  const drop = peeked.rec
  let fields: Array<{ envKey: string; value: string; secret: boolean }> | undefined
  if (drop.fields?.length) {
    const vmap = (isObj(b.values) ? b.values : {}) as Record<string, unknown>
    fields = []
    for (const f of drop.fields) {
      const v = vmap[f.key]
      if (typeof v !== 'string' || !v.trim()) {
        return sendJson(ctx, 400, { error: 'bad_request', message: `missing value for ${f.key}` })
      }
      fields.push({ envKey: f.key, value: v.trim(), secret: f.secret !== false })
    }
  } else if (typeof b.secret !== 'string' || !b.secret.trim()) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'expected { secret }' })
  }
  const redeemed = await deps.drops.redeem(id!)
  if (!redeemed.ok) {
    return sendJson(ctx, 404, {
      error: 'not_found',
      message:
        redeemed.reason === 'expired'
          ? 'this drop link has expired — ask the agent for a fresh one'
          : 'this drop link is invalid or was already used — ask the agent for a fresh one',
    })
  }
  return {
    ok: true,
    credential: {
      service: drop.service,
      ownerId: drop.ownerId,
      ...(drop.envKey ? { envKey: drop.envKey } : {}),
      fields: fields?.length ?? 0,
    },
  }
}

export function secretDropRoutes(deps: SecretDropDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/keychain/drops', auth: 'either', handle: (ctx) => mintDrop(ctx, deps) },
    { method: 'GET', path: '/v1/keychain/drops/:id/form', auth: 'source', handle: async (ctx) => dropForm(ctx, deps) },
    { method: 'POST', path: '/v1/keychain/drops/:id', auth: 'source', handle: (ctx) => redeemDrop(ctx, deps) },
  ]
}

// --- emoji ---

export function emojiRoutes(deps: { service: import('@qm/connectors').EmojiUploadService }): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/emoji',
      auth: 'either',
      handle: async (ctx) => {
        const principal = ctx.actor
        if (!principal) {
          return sendJson(ctx, 401, { error: 'unauthorized', message: 'agent capability token required' })
        }
        const body = ctx.body
        if (!isObj(body)) {
          return badRequest(ctx, 'expected JSON body with {name, contentType, bytes}', 'invalid_body')
        }
        const name = typeof body.name === 'string' ? body.name : ''
        const contentType = typeof body.contentType === 'string' ? body.contentType : ''
        const bytesField = body.bytes
        let bytes: Uint8Array
        if (typeof bytesField === 'string') {
          try {
            bytes = new Uint8Array(Buffer.from(bytesField, 'base64'))
          } catch {
            return badRequest(ctx, 'bytes must be base64-encoded', 'invalid_bytes')
          }
        } else if (bytesField instanceof Uint8Array) {
          bytes = bytesField
        } else if (Array.isArray(bytesField)) {
          bytes = Uint8Array.from(bytesField as number[])
        } else {
          return badRequest(ctx, 'bytes must be a base64 string, Uint8Array, or number[]', 'invalid_bytes')
        }
        const result = await deps.service.upload(principal.id, { name, contentType, bytes })
        if (!result.ok) {
          const status = result.error === 'too_large' ? 413 : 400
          return sendJson(ctx, status, { error: result.error, message: result.message })
        }
        return sendJson(ctx, 200, {
          ok: true,
          blobKey: result.blobKey,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          pendingProviderRegistration: result.pendingProviderRegistration,
        })
      },
    },
  ]
}

// --- egress audit ---

const MAX_BATCH = 500
const MAX_FIELD = 512

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_FIELD) : undefined
}

export function egressAuditRoutes(deps: { sink: EgressAuditSink }): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/egress-audit',
      auth: 'source',
      handle: async (ctx) => {
        const records = (ctx.body as { records?: unknown } | null)?.records
        if (!Array.isArray(records) || records.length === 0 || records.length > MAX_BATCH) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: `records must be a non-empty array of at most ${MAX_BATCH}`,
          })
        }
        let accepted = 0
        for (const raw of records) {
          if (typeof raw !== 'object' || raw === null) continue
          const r = raw as Record<string, unknown>
          const host = str(r.host)
          const verdict = str(r.verdict)
          if (!host || !verdict) continue
          const via = str(r.via)
          const peerIp = str(r.peerIp)
          const principalId = str(r.principalId)
          deps.sink.record({
            source: 'proxy',
            host,
            allowed: verdict === 'ok',
            verdict,
            scopeLabel: (str(r.scopeLabel) ?? 'unknown') as string,
            ...(via !== undefined ? { via } : {}),
            ...(peerIp !== undefined ? { peerIp } : {}),
            ...(principalId !== undefined ? { principalId } : {}),
            ...(typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 0 && r.port <= 65535 ? { port: r.port } : {}),
          })
          accepted++
        }
        return { accepted, rejected: records.length - accepted }
      },
    },
  ]
}

// --- auth broker ---

const CLAIM_NAMESPACE = 'authbroker:'
const MAX_CLAIM_IDS = 64
const MAX_CLAIM_ID_LENGTH = 200
const MAX_CLAIM_HORIZON_MS = 24 * 60 * 60 * 1000

export interface AuthBrokerDeps {
  replayDedupe?: ReplayDedupe
}

export function authBrokerRoutes(deps: AuthBrokerDeps = {}): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/auth/broker/claim',
      auth: 'source',
      handle: async (ctx) => {
        if (!deps.replayDedupe?.durable) {
          return sendJson(ctx, 503, {
            error: 'not_configured',
            message:
              'single-use claims need the Postgres-backed replay store; set DATABASE_URL so a restart cannot resurrect a spent sign-in link',
          })
        }
        const b = isObj(ctx.body) ? ctx.body : {}
        const ids: unknown[] = Array.isArray(b.ids) ? b.ids : []
        if (
          ids.length === 0 ||
          ids.length > MAX_CLAIM_IDS ||
          !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_CLAIM_ID_LENGTH)
        ) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: `ids must hold 1 to ${MAX_CLAIM_IDS} non-empty strings of at most ${MAX_CLAIM_ID_LENGTH} characters`,
          })
        }
        const now = Date.now()
        const expiresAtMs = b.expiresAtMs
        if (
          typeof expiresAtMs !== 'number' ||
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= now ||
          expiresAtMs > now + MAX_CLAIM_HORIZON_MS
        ) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: 'expiresAtMs must be a future epoch-millisecond timestamp within 24 hours',
          })
        }
        for (const id of ids as string[]) {
          if (await deps.replayDedupe.claim(`${CLAIM_NAMESPACE}${id}`, expiresAtMs)) {
            return sendJson(ctx, 200, { claimed: id })
          }
        }
        return sendJson(ctx, 200, { claimed: null })
      },
    },
    {
      method: 'GET',
      path: '/v1/auth/broker/email-allowed',
      auth: 'source',
      handle: async (ctx) => {
        const email = (ctx.query.email ?? '').trim()
        if (!email) return badRequest(ctx, 'email required')
        return { allowed: false }
      },
    },
  ]
}
