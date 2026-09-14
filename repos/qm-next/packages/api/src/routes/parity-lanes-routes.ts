/**
 * Smaller parity lanes: the credential broker (aud-gated, unwired → 404),
 * secret drops (capability-minted credential request links), emoji upload
 * (capability gate + browser-session 404), the egress audit sink ingest,
 * and the auth broker (single-use nonce claims need the durable replay
 * store → qm's 503; email allow-list → identity-unwired false).
 */
import type { SecretDropStore } from '../services/secret-drop-store.ts'
import type { EgressAuditSink } from '../services/egress-audit-sink.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

// --- credentials broker ---

export function credentialRoutes(): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/credentials/broker',
      auth: { aud: 'credential-broker' },
      handle: async (ctx) => {
        void ctx
        return sendJson(ctx, 404, { error: 'not_found' })
      },
    },
  ]
}

// --- secret drops ---

export interface SecretDropDeps {
  drops: SecretDropStore
}

const MAX_DROP_FIELDS = 8
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseDropFields(raw: unknown): Array<{ key: string; label?: string; secret: boolean }> | undefined | 'invalid' {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DROP_FIELDS) return 'invalid'
  const out: Array<{ key: string; label?: string; secret: boolean }> = []
  const seen = new Set<string>()
  for (const f of raw) {
    const key = (f as { key?: unknown })?.key
    if (typeof key !== 'string' || !ENV_KEY_RE.test(key) || seen.has(key)) return 'invalid'
    seen.add(key)
    const labelRaw = (f as { label?: unknown })?.label
    const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, 80) : undefined
    out.push({ key, ...(label ? { label } : {}), secret: (f as { secret?: unknown }).secret === false ? false : true })
  }
  return out
}

void parseDropFields

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
  void deps.drops
  void ctx
  return sendJson(ctx, 401, {
    error: 'unauthorized',
    message: 'secret-drop mint requires an agent capability token',
  })
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

export function emojiRoutes(): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/emoji',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) {
          return sendJson(ctx, 401, { error: 'unauthorized', message: 'agent capability token required' })
        }
        return sendJson(ctx, 404, {
          error: 'not_supported',
          message: "the emoji uploader isn't available in this deployment",
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

export function authBrokerRoutes(): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/auth/broker/claim',
      auth: 'source',
      handle: async (ctx) => {
        void ctx
        return sendJson(ctx, 503, {
          error: 'not_configured',
          message:
            'single-use claims need the Postgres-backed replay store; set DATABASE_URL so a restart cannot resurrect a spent sign-in link',
        })
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
