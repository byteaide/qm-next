/**
 * /v1/admin — the qm admin surface over the 12.0 control plane. Guard
 * ladder is qm-verbatim: no admin service → 404; missing `?scope=` → 400;
 * a caller without an org-admin grant → 403 "admin grant required for this
 * scope"; every handler is timed()-wrapped. Observability reads the real
 * sinks (turn metrics, error log, credential usage, egress audit, operator
 * audit log); model credentials, MCP servers, slack-emoji, and the
 * sandbox-routes surface still answer qm's unwired shapes until their
 * subsystems converge (deviation #46).
 */
import { parseScopeId } from '@qm/types'
import { cacheHitRatio, isStablePrefixMiss, type CredentialUsageSink, type EgressAuditSink, type ErrorLog, type AuditLog, type MetricsSink, type TurnMetricSample } from '@qm/admin'
import type { ScopeMemory } from '@qm/memory'
import { isValidMcpServerId, type McpServer, type McpServerAuthMode, type McpServerStore, type McpToolService } from '@qm/mcp'
import type { SessionStore, RunStore } from '@qm/types'
import type { CronStore } from '@qm/triggers'
import { defaultModelForHarness, HARNESS_IDS, selectableCatalogForHarness, builtInModelCatalog } from '../services/model-catalog.ts'
import {
  AdminError,
  adminStatusFromGrants,
  type AdminService,
} from '../services/admin-service.ts'
import type { DirectoryStore } from '@qm/directory'
import type { EnvironmentRegistry } from '../services/environment-registry.ts'
import type { SkillStore } from '@qm/skills'
import type { DeploymentStore } from '../services/deployment-store.ts'
import type { BlobTransferService } from '../services/blob-transfer.ts'
import { ByteSourceTooLargeError, type FileStoreService } from '../services/file-store.ts'
import { badRequest, isObj, notFound, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface AdminDeps {
  admin: AdminService
  orgScope: string
  sessions?: SessionStore
  runs?: RunStore
  memory?: ScopeMemory
  files?: FileStoreService
  blobTransfer?: BlobTransferService
  deployments?: DeploymentStore
  skills?: SkillStore
  skillPacks?: import('../services/skill-pack-store.ts').SkillPackStore
  crons?: () => CronStore | undefined
  deliveries?: () => import('@qm/im-core').ImDeliveryQueue | undefined
  directory?: DirectoryStore
  environments?: EnvironmentRegistry
  egressAudit?: EgressAuditSink
  auditLog?: AuditLog
  metrics?: MetricsSink
  errors?: ErrorLog
  credentialUsage?: CredentialUsageSink
  ambientJudgments?: import('@qm/approvals').AmbientJudgmentStore
  ackEmojiPicks?: import('@qm/approvals').AckEmojiPickStore
  mcp?: { servers: McpServerStore; toolService: McpToolService }
}

interface Authz {
  actorId: string
  scope: string
}

type AdminCtx = ApiRouteContext & { deps: AdminDeps }

function adminActorFrom(ctx: ApiRouteContext): string | null {
  if (ctx.actor?.id) return ctx.actor.id
  const header = ctx.req.headers['x-admin-actor']
  const value = Array.isArray(header) ? header[0] : header
  return typeof value === 'string' && value ? value : null
}

async function authorizeAdmin(ctx: ApiRouteContext, deps: AdminDeps, _scope: string): Promise<string | null> {
  if (!deps.admin) {
    notFound(ctx)
    return null
  }
  const actorId = adminActorFrom(ctx)
  if (!actorId) {
    sendJson(ctx, 403, { error: 'forbidden', message: 'admin grant required for this scope' })
    return null
  }
  const status = await deps.admin.adminStatusOf(actorId)
  if (status.isAdmin) return actorId
  sendJson(ctx, 403, { error: 'forbidden', message: 'admin grant required for this scope' })
  return null
}

async function requireScopedAdmin(ctx: ApiRouteContext, deps: AdminDeps): Promise<Authz | null> {
  const scope = ctx.query.scope ?? ''
  if (!scope) {
    sendJson(ctx, 400, { error: 'bad_request', message: 'scope required' })
    return null
  }
  const actorId = await authorizeAdmin(ctx, deps, scope)
  return actorId ? { actorId, scope } : null
}

function timed(handle: (ctx: ApiRouteContext) => Promise<unknown>): (ctx: ApiRouteContext) => Promise<unknown> {
  return async (ctx) => {
    const started = Date.now()
    let status = 200
    try {
      const result = await handle(ctx)
      return result
    } catch (error) {
      status = 500
      throw error
    } finally {
      console.log(`[admin] ${ctx.req.method} ${ctx.req.url} ${status} ${Date.now() - started}ms`)
    }
  }
}

// --- configuration & manifest ---

async function whoami(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  if (!deps.admin) return notFound(ctx)
  const actorId = adminActorFrom(ctx)
  if (!actorId) return { isAdmin: false, permissions: [] }
  const status = await deps.admin.adminStatusOf(actorId)
  return { ...status, permissions: status.isAdmin ? ['admin'] : [] }
}

async function listAdminScopes(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = deps.orgScope
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  const cronStore = deps.crons?.()
  const crons = cronStore ? await cronStore.list() : []
  const deployments = (await deps.deployments?.list()) ?? []
  const skills = (await deps.skills?.list()) ?? []
  const environments = deps.environments ? await deps.environments.list() : []
  const environmentRows = await Promise.all(
    environments.map(async ({ environment, attachments }) => ({
      id: environment.id,
      name: environment.name,
      ownerActorId: environment.ownerActorId,
      attachedScopes: attachments.map((a) => a.scopeId).sort(),
    })),
  )
  const owners = [
    ...crons.map((c) => c.scopeId),
    ...deployments.map((d) => d.ownerScopeId),
    ...skills.map((s) => s.scopeId),
    ...environmentRows.flatMap((e) => [e.id, ...e.attachedScopes]),
  ]
  const countBy = (ids: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  }
  const cronN = countBy(crons.map((c) => c.scopeId))
  const deployN = countBy(deployments.map((d) => d.ownerScopeId))
  const skillN = countBy(skills.map((s) => s.scopeId))
  const labels = new Map(owners.map((id) => [id, id]))
  const scopes = [...labels.keys()].map((id) => ({
    scopeId: id,
    sessions: 0,
    backgroundSessions: 0,
    lastActivity: 0,
    lastConversationActivity: 0,
    lastMessage: '',
    crons: cronN.get(id) ?? 0,
    deployments: deployN.get(id) ?? 0,
    skills: skillN.get(id) ?? 0,
  }))
  return { scopeId: scope, scopes, environments: environmentRows }
}

async function getScopeConfig(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const targetScope = ctx.params.scope
  if (!targetScope || targetScope.includes('/')) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, targetScope)
  if (!actorId) return undefined
  void actorId
  const harnessId = 'pi'
  const catalog = builtInModelCatalog()
  const models = selectableCatalogForHarness(catalog, harnessId)
  const directoryMembers = parseScopeId(targetScope).kind === 'org' ? ((await deps.directory?.listPeople()) ?? []) : []
  return {
    scopeId: targetScope,
    soulVersion: (await deps.memory?.updatedAt?.(targetScope as never)) ? 1 : 0,
    directoryMembers,
    baseModelDefault: defaultModelForHarness(harnessId),
    baseModelOptions: models,
    harnessDefault: harnessId,
    harnessOptions: HARNESS_IDS.filter((id) => id !== 'mock'),
    modelsByHarness: Object.fromEntries(HARNESS_IDS.map((id) => [id, selectableCatalogForHarness(catalog, id)])),
    serviceCredentials: [],
  }
}

async function putScopeConfig(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const targetScope = ctx.params.scope
  const resource = ctx.params.resource
  if (!targetScope || !resource) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, targetScope)
  if (!actorId) return undefined
  if (resource === 'command-policy-simulate') {
    return sendJson(ctx, 501, {
      error: 'not_configured',
      message: 'command policy simulation needs the policy engine (lands with the convergence milestone)',
    })
  }
  return sendJson(ctx, 404, { error: 'not_found', message: `unknown admin resource: ${resource}` })
}

async function getAdminResources(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = deps.orgScope
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  return { resources: [] }
}

async function retention(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = ctx.query.scope ?? deps.orgScope
  if (parseScopeId(scope).kind !== 'org') {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'retention is org-wide; request an org scope' })
  }
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  return { scopeId: scope }
}

async function testAutoFlagger(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const targetScope = ctx.params.scope
  if (!targetScope) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, targetScope)
  if (!actorId) return undefined
  if (parseScopeId(targetScope).kind !== 'org') {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'the auto-flagger is org-wide' })
  }
  return sendJson(ctx, 501, { error: 'not_configured', message: 'no auto-flagger wired' })
}

// --- observability ---

function latencySummary(values: number[]): { count: number; p50: number | null; p95: number | null; p99: number | null } {
  const sorted = [...values].sort((a, b) => a - b)
  const pct = (p: number): number | null => {
    if (!sorted.length) return null
    const rank = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!
  }
  return { count: sorted.length, p50: pct(50), p95: pct(95), p99: pct(99) }
}

const METRICS_SCAN_LIMIT = 10000

async function metrics(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const orgWide = parseScopeId(authz.scope).kind === 'org'
  const samples =
    (await deps.metrics?.list({
      limit: METRICS_SCAN_LIMIT,
      ...(orgWide ? {} : { scopeId: authz.scope }),
    })) ?? []
  const relevant = samples.filter((s) => s.status !== 'capture')
  const ttft = latencySummary(relevant.map((s) => s.ttftMs).filter((n): n is number => typeof n === 'number'))
  const turnLatency = latencySummary(relevant.map((s) => s.totalMs))
  const byDay = new Map<string, { ttfts: number[]; turns: number }>()
  for (const s of relevant) {
    const day = new Date(s.ts).toISOString().slice(0, 10)
    const bucket = byDay.get(day) ?? { ttfts: [] as number[], turns: 0 }
    bucket.turns += 1
    if (typeof s.ttftMs === 'number') bucket.ttfts.push(s.ttftMs)
    byDay.set(day, bucket)
  }
  const series = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, b]) => {
      const t = latencySummary(b.ttfts)
      return { day, turns: b.turns, ttftP50: t.p50, ttftP95: t.p95 }
    })
  const ratios = relevant.map((s) => cacheHitRatio(s)).filter((r): r is number => r !== null)
  const missFlags = relevant.map((s) => isStablePrefixMiss(s)).filter((m): m is boolean => m !== null)
  const misses = missFlags.filter((m) => m).length
  const sum = (f: (s: TurnMetricSample) => number | undefined) =>
    relevant.reduce((n, s) => n + (f(s) ?? 0), 0)
  const cache = {
    samples: ratios.length,
    avgHitRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    missTurns: misses,
    missRate: missFlags.length ? misses / missFlags.length : null,
    cacheReadTotal: sum((s) => s.cacheRead),
    cacheWriteTotal: sum((s) => s.cacheWrite),
    uncachedInputTotal: sum((s) => s.uncachedInput),
  }
  const runs = (await deps.runs?.list({ limit: 500 })) ?? []
  const done = runs.filter((r) => r.status === 'done').length
  const failed = runs.filter((r) => r.status === 'failed').length
  const finished = done + failed
  return {
    scopeId: authz.scope,
    ttft,
    turnLatency,
    runLatency: latencySummary([]),
    queueWait: latencySummary([]),
    throughput: { total: runs.length, done, failed, failureRate: finished ? failed / finished : 0 },
    series,
    cache,
  }
}

async function egress(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const brokerRows = ((await deps.credentialUsage?.list({ scopeId: authz.scope, limit: 1000 })) ?? []).map((s) => ({
    ts: s.ts,
    source: 'broker' as string,
    host: s.host,
    scopeLabel: s.scopeLabel,
    principalId: s.principalId,
    allowed: s.status !== 'denied',
    status: s.status,
    slug: s.slug,
    ...(s.upstreamStatus !== undefined ? { upstreamStatus: s.upstreamStatus } : {}),
  }))
  const firewallRows = ((await deps.egressAudit?.list({ scopeId: authz.scope, limit: 1000 })) ?? []).map((e) => ({
    ts: e.ts,
    source: e.source,
    host: e.host,
    scopeLabel: e.scopeLabel,
    allowed: e.allowed,
    status: e.verdict ?? (e.allowed ? 'ok' : 'denied'),
    ...(e.principalId !== undefined ? { principalId: e.principalId } : {}),
    ...(e.port !== undefined ? { port: e.port } : {}),
    ...(e.via !== undefined ? { via: e.via } : {}),
    ...(e.peerIp !== undefined ? { peerIp: e.peerIp } : {}),
  }))
  const records = [...brokerRows, ...firewallRows].sort((a, b) => b.ts - a.ts).slice(0, 1000)
  const denied = records.filter((r) => !r.allowed).length
  const hosts = new Set(records.map((r) => r.host).filter(Boolean)).size
  const bySource = { broker: brokerRows.length, firewall: firewallRows.length }
  return { scopeId: authz.scope, records, total: records.length, denied, hosts, bySource }
}

async function listAdminRuns(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const rawRuns = (await deps.runs?.list({ limit: 200 })) ?? []
  const ACTIVE = new Set(['pending', 'running'])
  const runs = rawRuns.map((r) => ({
    id: r.id,
    status: r.status,
    sessionScope: null,
    sessionType: null,
    threadRef: r.sessionId,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    workerId: r.workerId,
    leaseExpiresAt: r.leaseExpiresAt,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }))
  const active = runs.filter((r) => ACTIVE.has(r.status)).length
  return { scopeId: authz.scope, active, runs }
}

async function listAdminErrors(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const orgWide = parseScopeId(authz.scope).kind === 'org'
  const sessionId = ctx.query.sessionId || undefined
  const query = {
    ...(orgWide ? {} : { scopeId: authz.scope }),
    ...(sessionId ? { sessionId } : {}),
  }
  if (ctx.query.count) {
    const total = (await deps.errors?.count(query)) ?? 0
    return { scopeId: authz.scope, total }
  }
  const errors = ((await deps.errors?.list(query)) ?? []).sort((a, b) => b.ts - a.ts).slice(0, 200)
  return { scopeId: authz.scope, errors }
}

async function listAdminAudit(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const orgWide = parseScopeId(authz.scope).kind === 'org'
  const events = (await deps.auditLog?.tail({ limit: 200, ...(orgWide ? {} : { scopeLabel: authz.scope }) })) ?? []
  return {
    scopeId: authz.scope,
    events: events.map((e) => ({
      ts: e.at,
      principalId: e.principalId,
      action: e.action,
      scopeLabel: e.scopeLabel,
      resource: e.resource,
      ...(e.status ? { status: e.status } : {}),
    })),
  }
}

// --- sessions / slack-mirror ---

async function listAdminSessions(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  return { scopeId: authz.scope, sessions: [] }
}

async function getAdminSession(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const turnSeq = ctx.query.turnSeq
  if (turnSeq !== undefined && turnSeq !== 'orphan' && !Number.isInteger(Number(turnSeq))) {
    return sendJson(ctx, 400, { error: 'bad_request' })
  }
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const session = (await deps.sessions?.get(id)) ?? null
  if (!session) return sendJson(ctx, 404, { error: 'not_found' })
  return { session, requests: [] }
}

async function getAdminSessionLlm(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const session = (await deps.sessions?.get(id)) ?? null
  if (!session) return sendJson(ctx, 404, { error: 'not_found' })
  const requests = (await deps.sessions?.listLlmRequests(id)) ?? []
  return { sessionId: id, requests }
}

async function listAdminShadowDeliveries(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  // Trigger-provenanced deliveries (cron fires, consent/edit notices):
  // qm's shadow view consumed dry-run fires; qm-next has no shadow mode,
  // so the admin sees the live provenance instead.
  const queue = deps.deliveries?.()
  const rows = (await queue?.list?.({ limit: 200 })) ?? []
  const orgWide = authz.scope.startsWith('org:')
  const shadow = rows
    .filter((d) => d.origin?.fireKey !== undefined)
    .filter((d) => orgWide || d.origin?.sourceScopeId === authz.scope)
    .map((d) => ({
      deliveryId: d.id,
      provider: d.provider,
      ...(d.op.op === 'send' ? { destination: d.op.destination } : {}),
      createdAt: d.createdAt,
      idempotencyKey: d.idempotencyKey,
      origin: d.origin ?? null,
      deliveredAt: d.deliveredAt,
    }))
  return { scopeId: authz.scope, shadow }
}

async function listSlackMirrorContainers(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  return { scopeId: authz.scope, containers: [] }
}

async function listSlackMirrorMessages(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const container = ctx.query.container
  const q = ctx.query.q
  if (!container && !q) return sendJson(ctx, 400, { error: 'bad_request', message: 'container or q required' })
  return {
    scopeId: authz.scope,
    mode: q ? 'search' : 'timeline',
    messages: [],
    ...(q ? {} : { limit: 200 }),
  }
}

async function listAmbientJudgments(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const store = deps.ambientJudgments
  if (!store) return { scopeId: authz.scope, judgments: [], counts: { act: 0, ignore: 0, fastlane: 0 } }
  const id = ctx.query.id
  if (id) {
    const judgment = await store.get(Number(id))
    if (!judgment) return notFound(ctx)
    return { scopeId: authz.scope, judgment }
  }
  const container = ctx.query.container
  const decisionParam = ctx.query.decision
  const decisions = decisionParam
    ? (decisionParam.split(',').filter((d) => d === 'act' || d === 'ignore' || d === 'fastlane') as Array<
        'act' | 'ignore' | 'fastlane'
      >)
    : undefined
  const limit = Math.max(1, Math.min(1000, Number(ctx.query.limit ?? 100) || 100))
  const before = ctx.query.before !== undefined ? Number(ctx.query.before) : undefined
  const beforeId = ctx.query.beforeId !== undefined ? Number(ctx.query.beforeId) : undefined
  const opts = {
    ...(container ? { container } : {}),
    ...(decisions?.length ? { decision: decisions } : {}),
    ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
    ...(beforeId !== undefined && Number.isFinite(beforeId) ? { beforeId } : {}),
    limit,
  }
  const [judgments, counts] = await Promise.all([store.list(opts), store.counts(container ? { container } : {})])
  return { scopeId: authz.scope, judgments, counts, hasMore: judgments.length === limit, limit }
}

async function listAckEmojiPicks(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const store = deps.ackEmojiPicks
  const limit = Math.max(1, Math.min(1000, Number(ctx.query.limit ?? 50) || 50))
  if (!store) {
    return { scopeId: authz.scope, picks: [], counts: { picked: 0, declined: 0 }, hasMore: false, limit }
  }
  const id = ctx.query.id
  if (id) {
    const pick = await store.get(Number(id))
    if (!pick) return notFound(ctx)
    return { scopeId: authz.scope, pick }
  }
  const channel = ctx.query.channel
  const outcomeParam = ctx.query.outcome
  const outcomes = outcomeParam
    ? (outcomeParam.split(',').filter((o) => o === 'picked' || o === 'declined') as Array<'picked' | 'declined'>)
    : undefined
  const before = ctx.query.before !== undefined ? Number(ctx.query.before) : undefined
  const beforeId = ctx.query.beforeId !== undefined ? Number(ctx.query.beforeId) : undefined
  const opts = {
    ...(channel ? { channel } : {}),
    ...(outcomes?.length ? { outcome: outcomes } : {}),
    ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
    ...(beforeId !== undefined && Number.isFinite(beforeId) ? { beforeId } : {}),
    limit,
  }
  const [picks, counts] = await Promise.all([store.list(opts), store.counts(channel ? { channel } : {})])
  return { scopeId: authz.scope, picks, counts, hasMore: picks.length === limit, limit }
}

// --- files ---

async function listAdminFiles(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  if (!deps.files) return { scopeId: authz.scope, files: [] }
  const orgWide = parseScopeId(authz.scope).kind === 'org'
  const page = await deps.files.listByScopes(orgWide ? [] : [authz.scope], { limit: 200 })
  const files = page.files.map((f) => ({
    id: f.id,
    scopeId: f.ownerScopeId,
    name: f.name,
    path: f.name,
    mimetype: f.mimetype ?? 'application/octet-stream',
    size: f.sizeBytes,
    direction: 'in',
    createdAt: f.createdAt,
    openable: true,
  }))
  return { scopeId: authz.scope, files }
}

async function readAdminFile(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const id = ctx.query.id ?? ''
  if (!id) return badRequest(ctx, 'id required')
  if (!deps.files) return notFound(ctx)
  const actorId = adminActorFrom(ctx)
  const opened = actorId ? await deps.files.openForViewer(id, actorId) : null
  if (!opened) return notFound(ctx)
  const actorId2 = await authorizeAdmin(ctx, deps, opened.ownerScopeId)
  if (!actorId2) return undefined
  const previewCap = 256 * 1024
  const truncated = opened.bytes.byteLength > previewCap
  return {
    id: opened.id,
    scopeId: opened.ownerScopeId,
    path: opened.name,
    name: opened.name,
    mimetype: opened.mimetype ?? 'application/octet-stream',
    content: opened.bytes.subarray(0, previewCap).toString('utf8'),
    truncated,
  }
}

async function downloadAdminFile(ctx: ApiRouteContext, deps: AdminDeps): Promise<void> {
  const id = ctx.query.id ?? ''
  if (!id) return sendJson(ctx, 400, { error: 'bad_request', message: 'id required' })
  if (!deps.files) return notFound(ctx)
  const actorId = adminActorFrom(ctx)
  const opened = actorId ? await deps.files.openForViewer(id, actorId) : null
  if (!opened) return notFound(ctx)
  const actorId2 = await authorizeAdmin(ctx, deps, opened.ownerScopeId)
  if (!actorId2) return undefined
  ctx.reply.raw.writeHead(200, {
    'content-type': opened.mimetype ?? 'application/octet-stream',
    'content-length': String(opened.sizeBytes),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
    'x-content-type-options': 'nosniff',
  })
  ctx.reply.raw.end(opened.bytes)
}

async function uploadAdminFile(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  if (!deps.files) return sendJson(ctx, 404, { error: 'not_found', message: 'file store not wired' })
  if (!deps.blobTransfer) return sendJson(ctx, 501, { error: 'not_configured', message: 'blob transfer store not wired' })
  const b = isObj(ctx.body) ? ctx.body : {}
  const blobId = typeof b.blobId === 'string' ? b.blobId.trim() : ''
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'upload.bin'
  const mimetype = typeof b.mimetype === 'string' && b.mimetype ? b.mimetype : undefined
  if (!blobId) return badRequest(ctx, 'blobId required')
  const opened = await deps.blobTransfer.open(blobId)
  if (!opened) return sendJson(ctx, 404, { error: 'not_found', message: 'staged blob not found' })
  try {
    const file = await deps.files.uploadForViewer(authz.actorId, {
      ...(parseScopeId(authz.scope).kind === 'personal' ? { scopeId: authz.scope } : {}),
      name,
      ...(mimetype ? { mimetype } : {}),
      bytes: opened.bytes,
    })
    if (!file) return sendJson(ctx, 403, { error: 'forbidden', message: 'admin uploads land in your personal scope in this deployment' })
    return {
      file: {
        id: file.id,
        scopeId: file.ownerScopeId,
        name: file.name,
        path: file.name,
        mimetype: file.mimetype ?? 'application/octet-stream',
        size: file.sizeBytes,
        direction: 'in',
        createdAt: file.createdAt,
        openable: true,
      },
    }
  } catch (error) {
    if (error instanceof ByteSourceTooLargeError) {
      return sendJson(ctx, 413, { error: 'payload_too_large', message: error.message })
    }
    throw error
  } finally {
    await deps.blobTransfer.delete(blobId)
  }
}

// --- artifacts ---

async function listAdminArtifacts(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const pathname = ctx.req.url.split('?')[0] ?? ''
  const resource = pathname.slice('/v1/admin/'.length)
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  const orgWide = parseScopeId(authz.scope).kind === 'org'
  if (resource === 'crons') {
    const cronStore = deps.crons?.()
    const crons = cronStore
      ? (await cronStore.list()).filter((c) => orgWide || c.scopeId === authz.scope)
      : []
    return { scopeId: authz.scope, crons }
  }
  if (resource === 'deployments') {
    const deployments = ((await deps.deployments?.list()) ?? [])
      .filter((d) => orgWide || d.ownerScopeId === authz.scope)
      .map((d) => ({
        id: d.id,
        ownerScopeId: d.ownerScopeId,
        name: d.displayName || d.name,
        status: d.status,
        currentVersion: d.currentVersion,
        versions: d.versions.length,
        createdBy: d.createdBy,
        createdAt: d.versions[0]?.createdAt,
        lastAccessAt: d.lastAccessAt,
      }))
    return { scopeId: authz.scope, deployments }
  }
  const skills = ((await deps.skills?.list()) ?? [])
    .filter((s) => orgWide || s.scopeId === authz.scope)
    .map((s) => ({
      id: s.id,
      ownerScopeId: s.scopeId,
      name: s.name,
      description: s.description,
      status: s.status,
      version: s.version,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(s.lastUsedAt !== undefined ? { lastUsedAt: s.lastUsedAt } : {}),
    }))
  return { scopeId: authz.scope, skills }
}

async function putAdminCronDestination(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const crons = deps.crons ? deps.crons() : undefined
  const cron = crons ? await crons.get(id) : null
  if (!cron) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, cron.scopeId)
  if (!actorId) return undefined
  if (!isObj(ctx.body) || !('destination' in ctx.body)) {
    return badRequest(ctx, 'destination is required; use null to clear')
  }
  const destination = (ctx.body as Record<string, unknown>).destination
  if (destination !== null) {
    const d = destination as Record<string, unknown> | null
    const keys = d && typeof d === 'object' ? Object.keys(d) : []
    const valid =
      d !== null &&
      typeof d === 'object' &&
      (d.type === 'principal' || d.type === 'slack') &&
      typeof d.target === 'string' &&
      d.target.trim() !== '' &&
      keys.every((k) => k === 'type' || k === 'target' || k === 'audienceScopeId' || k === 'onBehalfOf')
    if (!valid) return badRequest(ctx, 'destination must be a principal or slack destination with a target')
  }
  const updated = await crons!.update(id, destination === null ? { destination: null } : { destination: destination as never })
  return { cron: updated }
}

async function getAdminSkill(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const skill = (await deps.skills?.get(id)) ?? null
  if (!skill) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, skill.scopeId)
  if (!actorId) return undefined
  return {
    id: skill.id,
    ownerScopeId: skill.scopeId,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    requiredCapabilities: skill.requiredCapabilities,
    status: skill.status,
    version: skill.version,
    createdBy: skill.createdBy,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

async function archiveAdminSkill(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const skill = (await deps.skills?.get(id)) ?? null
  if (!skill) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, skill.scopeId)
  if (!actorId) return undefined
  await deps.skills!.archive(id)
  return { ok: true }
}

// --- memory / sandbox ---

async function listMemoryScopes(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = deps.orgScope
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  if (!deps.memory) return notFound(ctx)
  const meta = (await deps.memory.metadata?.()) ?? null
  const labels = new Set<string>([scope])
  if (meta) for (const id of meta.keys()) labels.add(id)
  const scopes = await Promise.all(
    [...labels].map(async (id) => {
      let bytes = 0
      let updatedAt: number | undefined
      if (meta) {
        const m = meta.get(id as never)
        bytes = m?.bytes ?? 0
        updatedAt = m?.updatedAt
      } else {
        const content = await deps.memory!.get(id as never)
        bytes = Buffer.byteLength(content)
      }
      return { scopeId: id, hasMemory: bytes > 0, bytes, ...(updatedAt ? { updatedAt } : {}) }
    }),
  )
  scopes.sort((a, b) => Number(b.hasMemory) - Number(a.hasMemory) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.scopeId.localeCompare(b.scopeId))
  return { scopeId: scope, scopes }
}

async function getAdminMemory(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  if (!deps.memory) return notFound(ctx)
  return { scopeId: authz.scope, content: await deps.memory.get(authz.scope as never) }
}

async function putAdminMemory(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  if (!deps.memory) return notFound(ctx)
  const content = (ctx.body as { content?: unknown } | null)?.content
  if (typeof content !== 'string') {
    return badRequest(ctx, 'memory requires { content: string }')
  }
  await deps.memory.replace(authz.scope as never, content, authz.actorId)
  return { ok: true, scopeId: authz.scope }
}

async function listSandboxRoutes(ctx: ApiRouteContext): Promise<unknown> {
  void ctx
  return sendJson(ctx, 404, { error: 'not_supported' })
}

async function migrateSandboxScope(ctx: ApiRouteContext): Promise<unknown> {
  void ctx
  return sendJson(ctx, 404, { error: 'not_supported' })
}

// --- slack-installation / providers / mcp ---

async function getSlackInstallation(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const stored = deps.admin.getSlackInstallation()
  if (!stored) return notFound(ctx)
  return { ...stored, source: 'admin', createUrl: '/v1/admin/slack-installation' }
}

async function putSlackInstallation(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const b = isObj(ctx.body) ? ctx.body : {}
  if (typeof b.botToken !== 'string' || !b.botToken || typeof b.teamId !== 'string' || !b.teamId) {
    return sendJson(ctx, 400, { error: 'invalid_slack_installation', message: 'botToken and teamId are required' })
  }
  const status = deps.admin.putSlackInstallation({
    botToken: b.botToken,
    teamId: b.teamId,
    ...(typeof b.teamName === 'string' ? { teamName: b.teamName } : {}),
    installedBy: actorId,
  })
  return { ...status, configured: true, managed: true, source: 'admin' }
}

async function deleteSlackInstallation(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  deps.admin.deleteSlackInstallation()
  return { configured: false, managed: true, source: 'admin' }
}

async function getSlackEmojiList(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

async function getModelProviders(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

async function putModelProvider(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

async function deleteModelProvider(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

async function getCustomProviders(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return { providers: [] }
}

async function putCustomProvider(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const b = isObj(ctx.body) ? ctx.body : {}
  if (typeof b.name !== 'string' || !b.name || typeof b.baseUrl !== 'string' || !b.baseUrl) {
    return badRequest(ctx, 'name and baseUrl are required')
  }
  return notFound(ctx)
}

async function deleteCustomProvider(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

type McpServerRedacted = Omit<McpServer, 'bearerToken' | 'clientSecret'> & {
  hasBearerToken: boolean
  hasClientSecret: boolean
}

function redactMcpServer(server: McpServer): McpServerRedacted {
  const { bearerToken, clientSecret, ...rest } = server
  return { ...rest, hasBearerToken: !!bearerToken, hasClientSecret: !!clientSecret }
}

async function getMcpServers(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  if (!deps.mcp) return notFound(ctx)
  const servers = await deps.mcp.servers.list()
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actorId,
    action: 'mcp-servers.read',
    resource: 'mcp-servers',
    scopeLabel: deps.orgScope,
  })
  const tools = deps.mcp.toolService.toolDefs().map(({ name, serverId, description, readOnly }) => ({
    name,
    serverId,
    description,
    readOnly,
  }))
  return { servers: servers.map(redactMcpServer), tools }
}

async function putMcpServer(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  if (!deps.mcp) return notFound(ctx)
  const id = ctx.params.id ?? ''
  if (!isValidMcpServerId(id)) {
    return badRequest(ctx, 'id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter')
  }
  const b = isObj(ctx.body) ? ctx.body : {}
  const rawUrl = typeof b.url === 'string' ? b.url.trim() : ''
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return badRequest(ctx, 'url must be a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return badRequest(ctx, 'url must be http(s)')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return badRequest(ctx, 'url must not carry credentials, query, or fragment')
  }
  const authModes: McpServerAuthMode[] = ['none', 'bearer', 'client-credentials']
  const auth = (typeof b.auth === 'string' ? b.auth : 'none') as McpServerAuthMode
  if (!authModes.includes(auth)) {
    return badRequest(ctx, `auth must be one of ${authModes.join(', ')}`)
  }
  const existing = await deps.mcp.servers.get(id)
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : id
  const bearerToken =
    typeof b.bearerToken === 'string' && b.bearerToken ? b.bearerToken : existing?.bearerToken
  const clientIdRaw =
    typeof b.clientId === 'string' && b.clientId ? b.clientId : existing?.clientId
  const clientSecretRaw =
    typeof b.clientSecret === 'string' && b.clientSecret ? b.clientSecret : existing?.clientSecret
  const server: McpServer = {
    id,
    name,
    url: rawUrl,
    auth,
    ...(auth === 'bearer' && bearerToken ? { bearerToken } : {}),
    ...(auth === 'client-credentials' && clientIdRaw
      ? { clientId: clientIdRaw }
      : {}),
    ...(auth === 'client-credentials' && clientSecretRaw
      ? { clientSecret: clientSecretRaw }
      : {}),
    readOnly: b.readOnly !== false,
    enabled: b.enabled !== false,
    updatedAt: Date.now(),
    updatedBy: actorId,
  }
  if (auth === 'bearer' && !server.bearerToken) {
    return badRequest(ctx, 'bearer auth requires bearerToken')
  }
  if (auth === 'client-credentials' && (!server.clientId || !server.clientSecret)) {
    return badRequest(ctx, 'client-credentials auth requires clientId and clientSecret')
  }
  let toolNames: string[] | undefined
  if (b.validate !== false) {
    try {
      toolNames = await deps.mcp.toolService.probe(server)
    } catch (e) {
      return sendJson(ctx, 400, {
        error: 'unreachable',
        message: `tools/list against ${parsed.host} failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
  await deps.mcp.servers.put(server)
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actorId,
    action: 'mcp-servers.update',
    resource: id,
    scopeLabel: deps.orgScope,
  })
  return toolNames !== undefined
    ? { ok: true, server: redactMcpServer(server), tools: toolNames }
    : { ok: true, server: redactMcpServer(server) }
}

async function deleteMcpServer(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  if (!deps.mcp) return notFound(ctx)
  const id = ctx.params.id ?? ''
  if (!(await deps.mcp.servers.get(id))) return notFound(ctx)
  await deps.mcp.servers.delete(id)
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actorId,
    action: 'mcp-servers.delete',
    resource: id,
    scopeLabel: deps.orgScope,
  })
  return { ok: true }
}

// --- security ---

async function listSecurityFlags(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = deps.orgScope
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  const events = (await deps.auditLog?.tail({ limit: 200 })) ?? []
  const flags = events
    .filter((e) => e.action === 'security_posture.flagged' || e.action === 'security_posture.quarantine')
    .map((e) => ({ at: e.at, principal: e.principalId, scope: e.scopeLabel, surface: e.resource, detail: e.detail }))
  return { flags }
}

async function releaseSecurityTaint(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = deps.orgScope
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  const sessionId = (ctx.body as { sessionId?: unknown } | null)?.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return badRequest(ctx, 'sessionId required')
  }
  void deps.sessions
  return notFound(ctx)
}

// --- users / directory / grants / impersonate ---

async function listUsers(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const scope = deps.orgScope
  const actorId = await authorizeAdmin(ctx, deps, scope)
  if (!actorId) return undefined
  const grants = (await deps.admin.listGrants()) ?? []
  const members = (await deps.directory?.listPeople()) ?? []
  const users = members.map((m) => ({
    principalId: m.principalId,
    ...(m.displayName ? { displayName: m.displayName } : {}),
    isAdmin: adminStatusFromGrants(grants, m.principalId).isAdmin,
  }))
  for (const g of grants) {
    if (!users.some((u) => u.principalId === g.principalId)) {
      users.push({ principalId: g.principalId, isAdmin: true })
    }
  }
  return {
    scopeId: scope,
    users,
    grants,
    externalUsers: [],
    inviteEmail: { configured: false },
  }
}

async function getUserDetail(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const principalId = ctx.params.principalId
  if (!principalId) return notFound(ctx)
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const member = (await deps.directory?.listPeople())?.find((m) => m.principalId === principalId) ?? null
  const grants = (await deps.admin.listGrants()).filter((g) => g.principalId === principalId)
  if (!member && grants.length === 0) return notFound(ctx)
  const personal = `personal:${principalId}`
  const sessions = (await deps.sessions?.listByParticipant(principalId)) ?? []
  const deployments = ((await deps.deployments?.list()) ?? [])
    .filter((d) => d.ownerScopeId === personal)
    .map((d) => ({ id: d.id, name: d.displayName || d.name, status: d.status, currentVersion: d.currentVersion }))
  return {
    principalId,
    scopeId: personal,
    ...(member?.displayName ? { displayName: member.displayName } : {}),
    admin: adminStatusFromGrants(await deps.admin.listGrants(), principalId),
    stats: { sessions: sessions.filter((s) => s.scopeId === personal).length, turns: 0 },
    conversations: [],
    files: [],
    deployments,
    crons: [],
    config: null,
    onboarding: null,
  }
}

async function setUserOnboarding(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  if (!deps.memory) return notFound(ctx)
  const principalId = ctx.params.principalId
  if (!principalId) return notFound(ctx)
  const status = (ctx.body as { status?: unknown } | null)?.status
  if (typeof status !== 'string' || !['not_started', 'pending', 'completed', 'dismissed'].includes(status)) {
    return badRequest(ctx, 'onboarding requires { status: not_started|pending|completed|dismissed }')
  }
  const personal = `personal:${principalId}`
  await deps.memory.replace(personal as never, `[onboarding:${status}:${new Date().toISOString().slice(0, 10)}]\n`, actorId)
  return { ok: true, scopeId: personal, status }
}

async function resetUserToBrandNew(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  if (!deps.memory) return notFound(ctx)
  const principalId = ctx.params.principalId
  if (!principalId) return notFound(ctx)
  const personal = `personal:${principalId}`
  await deps.memory.replace(personal as never, '[onboarding:not_started]\n', actorId)
  let deletedSessions = 0
  if (deps.sessions) {
    const own = (await deps.sessions.listByParticipant(principalId)).filter((s) => s.scopeId === personal)
    for (const s of own) {
      await deps.sessions.discardSession(s.id, actorId)
      deletedSessions++
    }
  }
  return { ok: true, scopeId: personal, deletedSessions }
}

async function createAdminGrant(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const b = (ctx.body ?? {}) as { principalId?: unknown; role?: unknown; scopeId?: unknown }
  try {
    const grant = await deps.admin.createGrant(actorId, {
      principalId: String(b.principalId ?? ''),
      role: 'org_admin',
      scopeId: String(b.scopeId ?? ''),
    })
    return { ok: true, grant }
  } catch (error) {
    if (error instanceof AdminError) return sendJson(ctx, error.status, { error: 'grant_failed', message: error.message })
    throw error
  }
}

async function revokeAdminGrant(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const principalId = ctx.params.principalId
  const scope = ctx.query.scope ?? ''
  const role = ctx.query.role ?? ''
  if (!principalId || !scope || role !== 'org_admin') {
    return badRequest(ctx, 'principalId (path), and scope + role=org_admin (query) required')
  }
  try {
    await deps.admin.revokeGrant(actorId, principalId, scope, 'org_admin')
    return { ok: true }
  } catch (error) {
    if (error instanceof AdminError) return sendJson(ctx, error.status, { error: 'revoke_failed', message: error.message })
    throw error
  }
}

async function inviteExternalUser(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

async function revokeExternalUser(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return notFound(ctx)
}

async function startImpersonation(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const target = String((ctx.body as { target?: string } | null)?.target ?? '').trim()
  if (!target) return badRequest(ctx, 'target principal required')
  if (target === actorId) return badRequest(ctx, 'cannot impersonate yourself')
  const member = (await deps.directory?.listPeople())?.find((m) => m.principalId === target) ?? null
  return { ok: true, target, displayName: member?.displayName ?? target }
}

async function stopImpersonation(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  return { ok: true }
}

async function searchDirectory(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const actorId = await authorizeAdmin(ctx, deps, deps.orgScope)
  if (!actorId) return undefined
  const q = (ctx.query.q ?? '').trim().toLowerCase()
  const members = (await deps.directory?.listPeople()) ?? []
  const filtered = q
    ? members.filter(
        (m) =>
          m.principalId.toLowerCase().includes(q) ||
          (m.displayName ?? '').toLowerCase().includes(q),
      )
    : members
  return { members: filtered }
}

async function listKeychainStatus(ctx: ApiRouteContext, deps: AdminDeps): Promise<unknown> {
  const authz = await requireScopedAdmin(ctx, deps)
  if (!authz) return undefined
  return { scopeId: authz.scope, people: [], credentials: [], grants: [], asks: [] }
}

// --- table ---

export function adminRoutes(deps: AdminDeps): ReadonlyArray<Route> {
  const t = (handle: (ctx: ApiRouteContext) => Promise<unknown>) => timed(handle)
  const h = (fn: (ctx: AdminCtx) => Promise<unknown>) => async (ctx: ApiRouteContext) => fn(ctx as AdminCtx)
  const table: ReadonlyArray<Route> = [
    { method: 'GET', path: '/v1/admin/whoami', auth: 'either', handle: t(h((ctx) => whoami(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/scopes', auth: 'either', handle: t(h((ctx) => listAdminScopes(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/scopes/:scope', auth: 'either', handle: t(h((ctx) => getScopeConfig(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/scopes/:scope/:resource', auth: 'either', handle: t(h((ctx) => putScopeConfig(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/resources', auth: 'either', handle: t(h((ctx) => getAdminResources(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/retention', auth: 'either', handle: t(h((ctx) => retention(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/scopes/:scope/auto-flagger/test', auth: 'either', handle: t(h((ctx) => testAutoFlagger(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/metrics', auth: 'either', handle: t(h((ctx) => metrics(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/egress', auth: 'either', handle: t(h((ctx) => egress(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/runs', auth: 'either', handle: t(h((ctx) => listAdminRuns(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/errors', auth: 'either', handle: t(h((ctx) => listAdminErrors(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/audit', auth: 'either', handle: t(h((ctx) => listAdminAudit(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/sessions', auth: 'either', handle: t(h((ctx) => listAdminSessions(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/sessions/:id/llm', auth: 'either', handle: t(h((ctx) => getAdminSessionLlm(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/sessions/:id', auth: 'either', handle: t(h((ctx) => getAdminSession(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/deliveries/shadow', auth: 'either', handle: t(h((ctx) => listAdminShadowDeliveries(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/slack-mirror', auth: 'either', handle: t(h((ctx) => listSlackMirrorContainers(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/slack-mirror/messages', auth: 'either', handle: t(h((ctx) => listSlackMirrorMessages(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/ambient-judgments', auth: 'either', handle: t(h((ctx) => listAmbientJudgments(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/ack-emoji-picks', auth: 'either', handle: t(h((ctx) => listAckEmojiPicks(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/files', auth: 'either', handle: t(h((ctx) => listAdminFiles(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/files/read', auth: 'either', handle: t(h((ctx) => readAdminFile(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/files/download', auth: 'either', handle: t(h((ctx) => downloadAdminFile(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/files/upload', auth: 'either', handle: t(h((ctx) => uploadAdminFile(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/crons', auth: 'either', handle: t(h((ctx) => listAdminArtifacts(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/deployments', auth: 'either', handle: t(h((ctx) => listAdminArtifacts(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/skills', auth: 'either', handle: t(h((ctx) => listAdminArtifacts(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/crons/:id/destination', auth: 'either', handle: t(h((ctx) => putAdminCronDestination(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/skills/:id', auth: 'either', handle: t(h((ctx) => getAdminSkill(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/skills/:id', auth: 'either', handle: t(h((ctx) => archiveAdminSkill(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/memory/scopes', auth: 'either', handle: t(h((ctx) => listMemoryScopes(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/memory', auth: 'either', handle: t(h((ctx) => getAdminMemory(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/memory', auth: 'either', handle: t(h((ctx) => putAdminMemory(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/sandbox-routes', auth: 'either', handle: t(h((ctx) => listSandboxRoutes(ctx))) },
    { method: 'POST', path: '/v1/admin/sandbox-routes/:scopeId/migrate', auth: 'either', handle: t(h((ctx) => migrateSandboxScope(ctx))) },
    { method: 'GET', path: '/v1/admin/slack-installation', auth: 'either', handle: t(h((ctx) => getSlackInstallation(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/slack-installation', auth: 'either', handle: t(h((ctx) => putSlackInstallation(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/slack-installation', auth: 'either', handle: t(h((ctx) => deleteSlackInstallation(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/slack-emoji', auth: 'either', handle: t(h((ctx) => getSlackEmojiList(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/model-providers', auth: 'either', handle: t(h((ctx) => getModelProviders(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/model-providers/:provider', auth: 'either', handle: t(h((ctx) => putModelProvider(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/model-providers/:provider', auth: 'either', handle: t(h((ctx) => deleteModelProvider(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/custom-providers', auth: 'either', handle: t(h((ctx) => getCustomProviders(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/custom-providers/:provider', auth: 'either', handle: t(h((ctx) => putCustomProvider(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/custom-providers/:provider', auth: 'either', handle: t(h((ctx) => deleteCustomProvider(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/mcp-servers', auth: 'either', handle: t(h((ctx) => getMcpServers(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/mcp-servers/:id', auth: 'either', handle: t(h((ctx) => putMcpServer(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/mcp-servers/:id', auth: 'either', handle: t(h((ctx) => deleteMcpServer(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/security/flags', auth: 'either', handle: t(h((ctx) => listSecurityFlags(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/security/release', auth: 'either', handle: t(h((ctx) => releaseSecurityTaint(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/users', auth: 'either', handle: t(h((ctx) => listUsers(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/directory', auth: 'either', handle: t(h((ctx) => searchDirectory(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/keychain', auth: 'either', handle: t(h((ctx) => listKeychainStatus(ctx, deps))) },
    { method: 'GET', path: '/v1/admin/users/:principalId', auth: 'either', handle: t(h((ctx) => getUserDetail(ctx, deps))) },
    { method: 'PUT', path: '/v1/admin/users/:principalId/onboarding', auth: 'either', handle: t(h((ctx) => setUserOnboarding(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/users/:principalId/reset', auth: 'either', handle: t(h((ctx) => resetUserToBrandNew(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/grants', auth: 'either', handle: t(h((ctx) => createAdminGrant(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/grants/:principalId', auth: 'either', handle: t(h((ctx) => revokeAdminGrant(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/external-users', auth: 'either', handle: t(h((ctx) => inviteExternalUser(ctx, deps))) },
    { method: 'DELETE', path: '/v1/admin/external-users/:email', auth: 'either', handle: t(h((ctx) => revokeExternalUser(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/impersonate/stop', auth: 'either', handle: t(h((ctx) => stopImpersonation(ctx, deps))) },
    { method: 'POST', path: '/v1/admin/impersonate', auth: 'either', handle: t(h((ctx) => startImpersonation(ctx, deps))) },
  ]
  return table
}
