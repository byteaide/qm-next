/**
 * Memory provider routing, ported from qm's `provider-router.ts` onto the
 * ScopeMemory surface: routes bind providers to scope kinds or exact scope
 * ids with per-route recall/capture/manage switches; failures are
 * fail-open only where the route says so.
 */
import { parseScopeId, type ScopeId, type ScopeKind } from '@qm/types'
import type { MemoryCaptureContext, MemoryRevision, ScopeMemory } from './contract.ts'

export type MemoryCapturePolicy = 'off' | 'explicit' | 'automatic'

export interface MemoryProviderRoute {
  provider: string
  scopes: readonly (ScopeKind | ScopeId)[]
  recall?: boolean
  capture?: MemoryCapturePolicy
  manage?: boolean
  label?: string
  failOpen?: boolean
}

function matches(route: MemoryProviderRoute, scopeId: ScopeId): boolean {
  const kind = parseScopeId(scopeId).kind
  return route.scopes.some((scope) => scope === scopeId || scope === kind)
}

function captureAllowed(policy: MemoryCapturePolicy | undefined, mode: 'explicit' | 'automatic'): boolean {
  if (policy === 'automatic') return true
  return policy === 'explicit' && mode === 'explicit'
}

export function createRoutedMemoryService(opts: {
  providers: Readonly<Record<string, ScopeMemory>>
  routes: readonly MemoryProviderRoute[]
  onError?: (error: unknown, provider: string, operation: 'recall' | 'query' | 'capture') => void
}): ScopeMemory {
  const routesFor = (scopeId: ScopeId): MemoryProviderRoute[] => opts.routes.filter((route) => matches(route, scopeId))
  const providerFor = (route: MemoryProviderRoute): ScopeMemory => {
    const provider = opts.providers[route.provider]
    if (!provider) throw new Error(`unknown memory provider: ${route.provider}`)
    return provider
  }
  const managerFor = (scopeId: ScopeId): ScopeMemory | undefined => {
    const route = routesFor(scopeId).find((candidate) => candidate.manage !== false)
    return route ? providerFor(route) : undefined
  }

  return {
    async head(scopeId) {
      const manager = managerFor(scopeId)
      if (!manager) return { content: '', revision: '0' }
      return manager.head(scopeId)
    },

    async get(scopeId) {
      const manager = managerFor(scopeId)
      return manager ? manager.get(scopeId) : ''
    },

    async replace(scopeId, content, author) {
      const manager = managerFor(scopeId)
      if (!manager) throw new Error(`memory for ${scopeId} is not directly editable`)
      await manager.replace(scopeId, content, author)
    },

    async replaceIfRevision(scopeId, content, revision, author) {
      const manager = managerFor(scopeId)
      if (!manager) return false
      return manager.replaceIfRevision(scopeId, content, revision, author)
    },

    async append(scopeId, facts, at, author) {
      return captureInternal(scopeId, facts, at, author, undefined)
    },

    async capture(scopeId, facts, at, author, context) {
      return captureInternal(scopeId, facts, at, author, context)
    },

    async recall(scopeId, recOpts) {
      const routes = routesFor(scopeId).filter((route) => route.recall !== false)
      const recalled = await Promise.all(
        routes.map(async (route) => {
          try {
            return { route, body: (await providerFor(route).recall(scopeId, recOpts)).trim() }
          } catch (error) {
            if (!route.failOpen) throw error
            opts.onError?.(error, route.provider, 'recall')
            return { route, body: '' }
          }
        }),
      )
      const present = recalled.filter(({ body }) => body)
      if (present.length === 0) return ''
      if (present.length === 1) {
        const { route, body } = present[0]!
        return route.label ? `### ${route.label}\n${body}` : body
      }
      return present.map(({ route, body }) => `### ${route.label ?? route.provider}\n${body}`).join('\n\n')
    },

    async query(scopeId, q, limit = 20) {
      const routes = routesFor(scopeId).filter((route) => route.recall !== false)
      const rows = await Promise.all(
        routes.map(async (route) => {
          try {
            return await providerFor(route).query(scopeId, q, limit)
          } catch (error) {
            if (!route.failOpen) throw error
            opts.onError?.(error, route.provider, 'query')
            return []
          }
        }),
      )
      return [...new Set(rows.flat())].slice(0, limit)
    },

    async history(scopeId, limit): Promise<MemoryRevision[]> {
      return (await managerFor(scopeId)?.history?.(scopeId, limit)) ?? []
    },

    async restore(scopeId, revision, expectedRevision, author) {
      return (await managerFor(scopeId)?.restore?.(scopeId, revision, expectedRevision, author)) ?? false
    },

    async updatedAt(scopeId) {
      return managerFor(scopeId)?.updatedAt?.(scopeId)
    },

    async metadata() {
      const out = new Map<ScopeId, { bytes: number; updatedAt?: number }>()
      for (const route of new Set(opts.routes.filter((route) => route.manage !== false))) {
        const meta = await providerFor(route).metadata?.()
        if (!meta) continue
        for (const [scopeId, m] of meta) out.set(scopeId, m)
      }
      return out
    },
  }

  async function captureInternal(
    scopeId: ScopeId,
    facts: string[],
    at: number,
    author: string | undefined,
    context: MemoryCaptureContext | undefined,
  ): Promise<number> {
    const mode = context?.mode ?? 'explicit'
    const targets = routesFor(scopeId).filter((route) => captureAllowed(route.capture, mode))
    const counts = await Promise.all(
      targets.map(async (route) => {
        const provider = providerFor(route)
        try {
          if (provider.capture) return await provider.capture(scopeId, facts, at, author, context)
          return await provider.append(scopeId, facts, at, author)
        } catch (error) {
          if (!route.failOpen) throw error
          opts.onError?.(error, route.provider, 'capture')
          return 0
        }
      }),
    )
    return counts.length ? Math.max(...counts) : 0
  }
}
