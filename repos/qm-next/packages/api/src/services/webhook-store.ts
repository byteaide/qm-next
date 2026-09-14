/**
 * Lane-A webhook store + signature verifiers: a faithful port of qm's
 * four schemes (github, slack, stripe, hmac-sha256) with constant-time
 * comparison, redaction, and the deliver() contract the raw incoming
 * route uses (401 on bad signature, slack handshake echo, otherwise
 * accepted). Deliveries reach an agent with the 13.0 IM bridge.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export const WEBHOOK_SCHEMES = ['github', 'slack', 'stripe', 'hmac-sha256'] as const
export type WebhookScheme = (typeof WEBHOOK_SCHEMES)[number]

export interface WebhookVerification {
  scheme: WebhookScheme
  secret: string
}

export interface WebhookFilter {
  path: string
  in: string[]
}

export interface Webhook {
  id: string
  ownerScopeId: string
  owner: string
  createdBy: string
  action: string
  verification: WebhookVerification
  filters?: WebhookFilter[]
  destination?: Record<string, unknown>
  destinationKey?: string
  enabled: boolean
  createdAt: number
}

export interface CreateWebhookInput {
  ownerScopeId: string
  owner: string
  createdBy: string
  action: string
  verification: WebhookVerification
  filters?: WebhookFilter[]
  destination?: Record<string, unknown>
  destinationKey?: string
}

export interface VerifierInput {
  secret?: string
  headers: Record<string, string | string[] | undefined>
  rawBody: string
}

function header(headers: VerifierInput['headers'], name: string): string | undefined {
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const SLACK_TS_TOLERANCE_SECONDS = 60 * 5

const VERIFIERS: Record<WebhookScheme, { verify(input: VerifierInput): boolean; handshake?(input: VerifierInput, parsedBody: unknown): string | null }> = {
  github: {
    verify({ secret, headers, rawBody }) {
      if (!secret) return false
      const sig = header(headers, 'x-hub-signature-256')
      if (!sig) return false
      return constantTimeEqual(sig, `sha256=${hmacHex(secret, rawBody)}`)
    },
    handshake({ headers }) {
      return header(headers, 'x-github-event') === 'ping' ? 'pong' : null
    },
  },
  slack: {
    verify({ secret, headers, rawBody }) {
      if (!secret) return false
      const sig = header(headers, 'x-slack-signature')
      const ts = header(headers, 'x-slack-request-timestamp')
      if (!sig || !ts) return false
      const tsSeconds = Number(ts)
      if (!Number.isFinite(tsSeconds)) return false
      if (Math.abs(Date.now() / 1000 - tsSeconds) > SLACK_TS_TOLERANCE_SECONDS) return false
      return constantTimeEqual(sig, `v0=${hmacHex(secret, `v0:${ts}:${rawBody}`)}`)
    },
    handshake(_input, parsedBody) {
      if (typeof parsedBody === 'object' && parsedBody !== null && (parsedBody as Record<string, unknown>).type === 'url_verification') {
        const challenge = (parsedBody as Record<string, unknown>).challenge
        return typeof challenge === 'string' ? challenge : null
      }
      return null
    },
  },
  stripe: {
    verify({ secret, headers, rawBody }) {
      if (!secret) return false
      const sig = header(headers, 'stripe-signature')
      if (!sig) return false
      const parts = sig.split(',').map((p) => p.split('=') as [string, string])
      const t = parts.find(([k]) => k === 't')?.[1]
      const v1s = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v)
      if (!t || v1s.length === 0) return false
      const expected = hmacHex(secret, `${t}.${rawBody}`)
      return v1s.some((v1) => constantTimeEqual(v1, expected))
    },
  },
  'hmac-sha256': {
    verify({ secret, headers, rawBody }) {
      if (!secret) return false
      const raw = header(headers, 'x-signature')
      if (!raw) return false
      const sig = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw
      return constantTimeEqual(sig, hmacHex(secret, rawBody))
    },
  },
}

export function getVerifier(scheme: string): (typeof VERIFIERS)[WebhookScheme] | null {
  return (VERIFIERS as Record<string, (typeof VERIFIERS)[WebhookScheme]>)[scheme] ?? null
}

export function redactWebhook(w: Webhook): Webhook {
  if (!w.verification.secret) return w
  return { ...w, verification: { ...w.verification, secret: '***' } }
}

export interface WebhookStore {
  create(input: CreateWebhookInput): Promise<Webhook>
  list(): Promise<Webhook[]>
  get(id: string): Promise<Webhook | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  deliver(id: string, input: { headers: Record<string, string | string[] | undefined>; rawBody: string }): Promise<{ status: 200 | 202 | 401 | 404; body?: string }>
}

export function createMemoryWebhookStore(): WebhookStore {
  const webhooks = new Map<string, Webhook>()
  return {
    async create(input) {
      const webhook: Webhook = {
        id: randomUUID(),
        ownerScopeId: input.ownerScopeId,
        owner: input.owner,
        createdBy: input.createdBy,
        action: input.action,
        verification: { ...input.verification },
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.destination ? { destination: input.destination } : {}),
        ...(input.destinationKey ? { destinationKey: input.destinationKey } : {}),
        enabled: true,
        createdAt: Date.now(),
      }
      webhooks.set(webhook.id, webhook)
      return webhook
    },
    async list() {
      return [...webhooks.values()].map((w) => ({ ...w }))
    },
    async get(id) {
      const w = webhooks.get(id)
      return w ? { ...w } : null
    },
    async setEnabled(id, enabled) {
      const w = webhooks.get(id)
      if (!w) throw new Error('no such webhook')
      w.enabled = enabled
    },
    async deliver(id, input) {
      const webhook = webhooks.get(id)
      if (!webhook || !webhook.enabled) return { status: 404 }
      const verifier = getVerifier(webhook.verification.scheme)
      if (!verifier) return { status: 404 }
      let parsedBody: unknown = null
      try {
        parsedBody = JSON.parse(input.rawBody)
      } catch {
        parsedBody = null
      }
      const handshake = verifier.handshake?.({ secret: webhook.verification.secret, headers: input.headers, rawBody: input.rawBody }, parsedBody)
      if (handshake !== null && handshake !== undefined) return { status: 200, body: handshake }
      const verified = verifier.verify({ secret: webhook.verification.secret, headers: input.headers, rawBody: input.rawBody })
      if (!verified) return { status: 401 }
      return { status: 202 }
    },
  }
}
