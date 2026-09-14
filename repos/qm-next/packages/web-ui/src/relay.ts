/**
 * The web-ui → api relay (13.0 convergence): qm's web-ui server signs every
 * /api/* relay to the core over the private network; qm-next runs one
 * process, so the relay is an in-process Fastify inject against the api app
 * carrying a short-TTL bearer minted for the acting principal — the same
 * trust shape (a signed surface naming its user) with no wire hop. Routes
 * that read `ctx.actor.id` therefore resolve to the signed-in user, exactly
 * like qm's portal-token or signed service relays.
 */
import { mintSignedPayload } from '@qm/auth'
import type { FastifyInstance } from 'fastify'

export interface RelayResponse {
  status: number
  text: string
  contentType: string
  body: Buffer
}

export interface ApiRelay {
  /** Relay a JSON (or empty-body) request; the reply body arrives as text. */
  json(user: string, method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT', pathWithQuery: string, rawBody?: string): Promise<RelayResponse>
  /** Relay a raw-byte request (blob staging); extra headers ride along. */
  raw(user: string, method: 'POST' | 'PUT', pathWithQuery: string, body: Buffer, headers?: Record<string, string>): Promise<RelayResponse>
}

const BEARER_TTL_MS = 60_000

export function createApiRelay(app: FastifyInstance, secret: string): ApiRelay {
  const mint = async (user: string): Promise<string> =>
    mintSignedPayload({ p: user, exp: Date.now() + BEARER_TTL_MS }, secret)
  const send = async (user: string, method: string, pathWithQuery: string, payload?: string | Buffer, headers?: Record<string, string>): Promise<RelayResponse> => {
    const authorization = `Bearer ${await mint(user)}`
    const res = await app.inject({
      method: method as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
      url: pathWithQuery,
      ...(payload !== undefined ? { payload } : {}),
      headers: { authorization, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    })
    return {
      status: res.statusCode,
      text: res.body,
      contentType: res.headers['content-type'] ?? 'application/json',
      body: res.rawPayload ?? Buffer.from(res.body),
    }
  }
  return {
    json: (user, method, pathWithQuery, rawBody) => send(user, method, pathWithQuery, rawBody),
    raw: (user, method, pathWithQuery, body, headers) => send(user, method, pathWithQuery, body, { 'content-type': 'application/octet-stream', ...headers }),
  }
}
