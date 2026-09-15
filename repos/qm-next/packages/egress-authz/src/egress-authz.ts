/**
 * Egress authz server + audit relay (qm `src/egress-authz-main.ts`):
 * capability-token gated CONNECT proxy with a hard-coded deny list
 * for loopback/link-local/metadata IPs and a DNS-rebinding defence
 * that resolves every request and re-checks the resolved IPs against
 * the deny rules and the optional `denyPrivateNetworks` policy.
 *
 * The audit sink records every decision; the relay buffers + batches
 * to a signed upstream `/v1/egress-audit` endpoint. The standalone
 * `main()` entry point is intentionally not exported.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { EGRESS_PROXY_AUD, signedRequestHeaders, verifyCapabilityToken, type CapabilityClaims } from '@qm/auth'
import type { EgressAuditRecord, EgressAuditSink } from '@qm/admin'
import { createSweeper } from '@qm/runs'
import { errMessage } from '@qm/store'
import type { EgressPolicy, ScopeId } from '@qm/types'
import { egressDecision, hostMatches, isHostDenied, type EgressVerdict } from './egress-policy.ts'
import { isPrivateNetworkIp } from './network.ts'

const OPEN: EgressPolicy = { allowedHosts: [], deniedHosts: [] }

const DENY_ALL: EgressPolicy = { allowedHosts: ['deny.invalid'], deniedHosts: [] }

const METADATA_HOSTS = ['metadata.google.internal', 'metadata.goog']

const BLOCKED = new BlockList()
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4')
BLOCKED.addSubnet('fe80::', 10, 'ipv6')
BLOCKED.addAddress('fd00:ec2::254', 'ipv6')
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4')
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4')
BLOCKED.addAddress('::1', 'ipv6')
BLOCKED.addAddress('::', 'ipv6')

export function isBlockedDestinationIp(ip: string): boolean {
  const s = ip
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/%.*$/, '')
  const fam = isIP(s)
  if (!fam) return false
  return BLOCKED.check(s, fam === 4 ? 'ipv4' : 'ipv6')
}

function isAlwaysBlockedHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
  if (isIP(h)) return isBlockedDestinationIp(h)
  return METADATA_HOSTS.some((m) => h === m || h.endsWith(`.${m}`))
}

export function tokenFromRequest(req: IncomingMessage): string | null {
  const raw = req.headers['proxy-authorization'] as string | undefined
  if (!raw) return null
  const [scheme, value] = raw.split(/\s+/, 2)
  if (!scheme || !value) return null
  if (scheme.toLowerCase() === 'bearer') return value
  if (scheme.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    return colon >= 0 ? decoded.slice(colon + 1) : decoded
  }
  return null
}

export function hostFromAuthority(authority: string): string | null {
  const a = authority.trim()
  if (!a) return null
  const m = /^\[(.+)\](?::\d+)?$/.exec(a)
  if (m) return m[1]!
  const i = a.lastIndexOf(':')
  if (i > 0 && !a.slice(i + 1).includes(':') && /^\d+$/.test(a.slice(i + 1))) return a.slice(0, i)
  return a
}

export type EgressAuditRecorder = Pick<EgressAuditSink, 'record'>

export interface EgressAuthzDeps {
  capabilitySecret?: string
  audit: EgressAuditRecorder
  tokenless?: 'open' | 'deny'
  now?: () => number
  lookup?: (host: string) => Promise<string[]>
}

function defaultLookup(host: string): Promise<string[]> {
  if (isIP(host)) return Promise.resolve([host])
  return dnsLookup(host, { all: true, verbatim: true }).then((rs) => rs.map((r) => r.address))
}

async function claimsFor(token: string | null, deps: EgressAuthzDeps): Promise<CapabilityClaims | null> {
  const claims =
    token && deps.capabilitySecret ? await verifyCapabilityToken(token, deps.capabilitySecret, deps.now?.()) : null
  return claims && claims.aud === EGRESS_PROXY_AUD ? claims : null
}

async function decide(
  host: string,
  policy: EgressPolicy | undefined,
  lookup: (h: string) => Promise<string[]>,
): Promise<{ allow: boolean; verdict: EgressVerdict; address?: string }> {
  if (isAlwaysBlockedHost(host)) return { allow: false, verdict: 'denied' }
  const byName = egressDecision(host, policy)
  if (!byName.allow) return byName
  let ips: string[]
  try {
    ips = await lookup(host)
  } catch {
    return { allow: false, verdict: 'denied' }
  }
  if (!ips.length) return { allow: false, verdict: 'denied' }
  const privateAllowed = policy?.privateNetworkAllowedHosts?.some((rule) => hostMatches(host, rule)) === true
  if (
    ips.some(
      (ip) =>
        isBlockedDestinationIp(ip) ||
        isHostDenied(ip, policy?.deniedHosts) ||
        (policy?.denyPrivateNetworks === true && !privateAllowed && isPrivateNetworkIp(ip)),
    )
  ) {
    return { allow: false, verdict: 'denied' }
  }
  const first = ips[0]
  return first === undefined ? { allow: false, verdict: 'denied' } : { allow: true, verdict: 'ok', address: first }
}

export function buildEgressAuthzServer(deps: EgressAuthzDeps): Server {
  const lookup = deps.lookup ?? defaultLookup
  async function checkStatus(
    req: IncomingMessage,
    authority: string,
  ): Promise<{ status: 200 | 403; upstream?: string }> {
    const host = hostFromAuthority(authority)
    if (!host) return { status: 403 }
    const portText = authority.match(/:(\d+)$/)?.[1]
    const scheme = req.headers['x-egress-scheme']
    let port = scheme === 'http' ? 80 : 443
    if (portText) port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { status: 403 }
    const token = tokenFromRequest(req)
    const claims = await claimsFor(token, deps)
    let policy: EgressPolicy | undefined = DENY_ALL
    if (claims) policy = (claims.egress as EgressPolicy | undefined) ?? undefined
    else if (!token && deps.tokenless === 'open') policy = OPEN
    const d = await decide(host, policy, lookup)
    try {
      deps.audit.record({
        source: 'proxy',
        host,
        allowed: d.allow,
        verdict: d.verdict,
        scopeLabel: (claims?.scopeId ?? 'unknown') as ScopeId,
        principalId: claims?.actorId ?? 'unknown',
      })
    } catch (error) {
      void error
    }
    if (!d.allow || !d.address) return { status: 403 }
    return { status: 200, upstream: isIP(d.address) === 6 ? `[${d.address}]:${port}` : `${d.address}:${port}` }
  }
  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const authority = (req.headers['x-egress-authority'] as string | undefined) ?? req.headers.host ?? ''
      const result = await checkStatus(req, authority)
      res
        .writeHead(result.status, result.upstream ? { 'x-egress-upstream-address': result.upstream } : undefined)
        .end()
    } catch {
      if (!res.headersSent) res.writeHead(403)
      res.end()
    }
  }
  return createServer((req, res) => void onRequest(req, res))
}

const RELAY_FLUSH_MS = 2_000
const RELAY_MAX_BATCH = 500
const RELAY_MAX_BUFFER = 5_000
const RELAY_PATH = '/v1/egress-audit'

export function createRelayAuditSink(
  coreApiUrl: string,
  signingSecret: string,
  fetchImpl: typeof fetch = fetch,
): EgressAuditRecorder & { flush(): Promise<void>; start(): void; stop(): void } {
  const url = coreApiUrl.replace(/\/$/, '') + RELAY_PATH
  const pathWithQuery = new URL(url).pathname
  const buffer: Array<Omit<EgressAuditRecord, 'ts' | 'source'>> = []
  let flushing = false
  let dropped = 0
  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return
    flushing = true
    try {
      const batch = buffer.slice(0, RELAY_MAX_BATCH)
      const body = JSON.stringify({ records: batch })
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: signedRequestHeaders(signingSecret, 'POST', pathWithQuery, body, {
          'content-type': 'application/json',
        }),
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`core responded ${res.status}`)
      buffer.splice(0, batch.length)
      if (dropped > 0) {
        console.warn(`[egress-authz] audit relay recovered; ${dropped} records were dropped while the buffer was full`)
        dropped = 0
      }
    } catch (e) {
      console.warn(`[egress-authz] audit relay to ${url} failed (${buffer.length} buffered): ${errMessage(e)}`)
    } finally {
      flushing = false
    }
  }
  const sweeper = createSweeper(flush, RELAY_FLUSH_MS, { label: 'egress-audit-relay' })
  return {
    record(r) {
      if (buffer.length >= RELAY_MAX_BUFFER) {
        dropped++
        return
      }
      const { source: _source, ...rest } = r
      buffer.push(rest)
    },
    flush,
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
  }
}