/**
 * Parity memory routes (11.0 tranche 4, contract `docs/parity-api-contract.md`
 * "memory（个人 self + agent 双面）"): the personal memory face over
 * `ScopeMemory` plus the agent `memory/self|search|facts` match group.
 *
 * Lane-A equivalence (deviation #37/#43): qm gates the agent face on
 * capability-token memory grants (`capability.memory.{read,write,orgWrite}`);
 * qm-next's signed bearer carries only `{p}`, so the agent face derives the
 * grant set from the principal — read/write = the personal scope, orgWrite =
 * unset (org-scope requests 403 exactly like an unprivileged qm capability).
 * Audit events (`memory.self.*` / `memory.agent.*`) land with the 12.0 admin
 * sinks.
 */
import type { ScopeId } from '@qm/types'
import { personalScope } from '@qm/types'
import type { ScopeMemory } from '@qm/memory'
import type { ApiRouteContext, Route } from './framework.ts'
import { notFound, sendJson } from './framework.ts'

export interface MemoryRoutesDeps {
  memory?: ScopeMemory | undefined
  scopeFor: () => ScopeId
}

function badRequest(ctx: ApiRouteContext, message: string) {
  return sendJson(ctx, 400, { error: 'bad_request', message })
}

function forbidden(ctx: ApiRouteContext, message: string) {
  return sendJson(ctx, 403, { error: 'forbidden', message })
}

/** qm viewer resolution: lane A has no capability tokens, so the bearer principal is the viewer. */
function viewerOf(ctx: ApiRouteContext): string | undefined {
  return ctx.actor?.id ?? (typeof ctx.query.principalId === 'string' ? ctx.query.principalId : undefined)
}

function memoryScopeFor(deps: MemoryRoutesDeps, viewer: string, org: boolean): ScopeId {
  return org ? deps.scopeFor() : personalScope(viewer)
}

function parseFacts(body: Record<string, unknown>): string[] | string {
  const raw = body.facts
  const facts = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : []
  if (facts.length === 0) return 'facts (non-empty string array) required'
  if (facts.length > 20) return 'at most 20 facts per call'
  return facts
}

export function memoryRoutes(deps: MemoryRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/memory',
      auth: 'source',
      handle: async (ctx) => {
        const principalId = ctx.query.principalId
        if (typeof principalId !== 'string' || !principalId) return badRequest(ctx, 'principalId required')
        if (!deps.memory) return notFound(ctx)
        const head = await deps.memory.head(personalScope(principalId))
        return sendJson(ctx, 200, { content: head.content, revision: head.revision })
      },
    },
    {
      method: 'PUT',
      path: '/v1/memory',
      auth: 'source',
      handle: async (ctx) => {
        if (!deps.memory) return notFound(ctx)
        const body = (ctx.body ?? {}) as Record<string, unknown>
        const principalId = typeof body.principalId === 'string' ? body.principalId : undefined
        if (!principalId) return badRequest(ctx, 'principalId required')
        if (typeof body.content !== 'string') return badRequest(ctx, 'content (string) required')
        const scopeId = personalScope(principalId)
        const revision = typeof body.revision === 'string' && body.revision !== '' ? body.revision : undefined
        if (revision !== undefined) {
          const applied = await deps.memory.replaceIfRevision(scopeId, body.content, revision, principalId)
          if (!applied) {
            const head = await deps.memory.head(scopeId)
            return sendJson(ctx, 409, {
              error: 'conflict',
              message: 'Memory changed, or that revision no longer exists.',
              content: head.content,
              revision: head.revision,
            })
          }
        } else {
          await deps.memory.replace(scopeId, body.content, principalId)
        }
        const head = await deps.memory.head(scopeId)
        return sendJson(ctx, 200, { ok: true, content: head.content, revision: head.revision })
      },
    },
    {
      method: 'GET',
      path: '/v1/memory/history',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.memory) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const scopeParam = ctx.query.scope
        if (scopeParam !== undefined && scopeParam !== 'org') return badRequest(ctx, 'scope must be "org" when present')
        const principalId = typeof ctx.query.principalId === 'string' ? ctx.query.principalId : undefined
        if (principalId && principalId !== viewer) return notFound(ctx)
        const org = scopeParam === 'org'
        const revisions = (await deps.memory.history?.(memoryScopeFor(deps, viewer, org), 30)) ?? []
        return sendJson(ctx, 200, { revisions: revisions.slice(0, 30) })
      },
    },
    {
      method: 'POST',
      path: '/v1/memory/restore',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.memory) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const b = (ctx.body ?? {}) as Record<string, unknown>
        if (typeof b.revision !== 'string' || typeof b.expectedRevision !== 'string') {
          return badRequest(ctx, 'revision and expectedRevision (strings) required')
        }
        const scopeParam = b.scope
        if (scopeParam !== undefined && scopeParam !== 'org') return badRequest(ctx, 'scope must be "org" when present')
        const principalId = typeof b.principalId === 'string' ? b.principalId : undefined
        if (principalId && principalId !== viewer) return notFound(ctx)
        const scopeId = memoryScopeFor(deps, viewer, scopeParam === 'org')
        const applied = await deps.memory.restore?.(scopeId, b.revision, b.expectedRevision, viewer)
        if (applied === undefined) return notFound(ctx)
        if (!applied) {
          const head = await deps.memory.head(scopeId)
          return sendJson(ctx, 409, {
            error: 'conflict',
            message: 'Memory changed, or that revision no longer exists.',
            content: head.content,
            revision: head.revision,
          })
        }
        const head = await deps.memory.head(scopeId)
        return sendJson(ctx, 200, { ok: true, content: head.content, revision: head.revision })
      },
    },
    ...(['GET', 'PUT'] as const).map((method) => ({
      method,
      path: '/v1/memory/self',
      auth: 'either' as const,
      handle: async (ctx: ApiRouteContext) => agentMemory(ctx, deps, method),
    })),
    {
      method: 'POST',
      path: '/v1/memory/search',
      auth: 'either',
      handle: async (ctx) => agentMemory(ctx, deps, 'POST', '/v1/memory/search'),
    },
    {
      method: 'POST',
      path: '/v1/memory/facts',
      auth: 'either',
      handle: async (ctx) => agentMemory(ctx, deps, 'POST', '/v1/memory/facts'),
    },
  ]
}

async function agentMemory(
  ctx: ApiRouteContext,
  deps: MemoryRoutesDeps,
  method: 'GET' | 'PUT' | 'POST',
  pathname = '/v1/memory/self',
): Promise<unknown> {
  if (!deps.memory) return notFound(ctx)
  const body = (ctx.body ?? {}) as Record<string, unknown>
  const viewer = ctx.actor?.id
  if (!viewer) return sendJson(ctx, 401, { error: 'unauthorized', message: 'agent capability token required' })

  if (['recipient', 'channel', 'participants'].some((key) => key in body)) {
    return badRequest(ctx, 'memory can only be changed from its own conversation')
  }

  // Lane-A capability grants (see file header): the personal scope only.
  const readScopes: ScopeId[] = [personalScope(viewer)]

  if (method === 'POST' && pathname === '/v1/memory/search') {
    if (typeof body.query !== 'string' || !body.query.trim()) return badRequest(ctx, 'query (string) required')
    if (readScopes.length === 0) return forbidden(ctx, 'memory recall is not enabled for this conversation')
    const limit = Math.max(1, Math.min(typeof body.limit === 'number' ? Math.floor(body.limit) : 20, 50))
    const results: Array<{ scopeId: ScopeId; fact: string }> = []
    for (const scope of readScopes) {
      if (results.length >= limit) break
      for (const fact of await deps.memory.query(scope, body.query, limit - results.length)) {
        results.push({ scopeId: scope, fact })
      }
    }
    return sendJson(ctx, 200, { results })
  }

  const requestedScope = method === 'GET' ? (typeof ctx.query.scope === 'string' ? ctx.query.scope : undefined) : typeof body.scope === 'string' ? body.scope : undefined
  if (requestedScope !== undefined && requestedScope !== 'org') {
    return badRequest(ctx, 'scope must be "org" when present')
  }
  // orgWrite is never set on lane-A capability grants → org requests 403.
  if (requestedScope === 'org') {
    return forbidden(ctx, 'org memory writes require an org admin')
  }
  const write = readScopes[0]
  if (!write) return forbidden(ctx, 'memory capture is not enabled for this conversation')

  if (method === 'POST' && pathname === '/v1/memory/facts') {
    const facts = parseFacts(body)
    if (typeof facts === 'string') return badRequest(ctx, facts)
    const added = await deps.memory.append(write, facts, Date.now(), viewer)
    return sendJson(ctx, 200, { ok: true, added, scopeId: write })
  }
  if (method === 'GET' && pathname === '/v1/memory/self') {
    return sendJson(ctx, 200, { scopeId: write, content: await deps.memory.get(write) })
  }
  if (method === 'PUT' && pathname === '/v1/memory/self') {
    if (typeof body.content !== 'string') return badRequest(ctx, 'content (string) required')
    await deps.memory.replace(write, body.content, viewer)
    return sendJson(ctx, 200, { ok: true, scopeId: write })
  }
  return notFound(ctx)
}
