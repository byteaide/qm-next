/**
 * MEMORY_PROVIDER_CONFIG parsing, ported from qm's `provider-config.ts`.
 * Parity 15.0 carries the memorable provider type; `type: "mcp"` entries
 * are refused until the mcp client package lands (16.0, deviation).
 */
import { parseScopeId, type ScopeId, type ScopeKind } from '@qm/types'
import type { MemoryCapturePolicy, MemoryProviderRoute } from './provider-router.ts'
import { parseMemorableProvider, type MemorableMemoryProviderConfig } from './memorable/config.ts'

const KINDS = new Set<ScopeKind>(['personal', 'channel', 'team', 'org', 'group'])
const ID = /^[a-z][a-z0-9-]{0,62}$/

export type AnyMemoryProviderConfig = MemorableMemoryProviderConfig

/** Which capture policies a route may set against a provider. */
function capturePoliciesOf(provider: AnyMemoryProviderConfig): ReadonlySet<MemoryCapturePolicy> {
  return provider.capturePolicies
}

export interface MemoryProviderConfig {
  providers: AnyMemoryProviderConfig[]
  routes: MemoryProviderRoute[]
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${at} must be a non-empty string`)
  return value
}

function scope(value: unknown, at: string): ScopeKind | ScopeId {
  const raw = string(value, at)
  if (KINDS.has(raw as ScopeKind)) return raw as ScopeKind
  if (!parseScopeId(raw).kind) throw new Error(`${at} must be a scope kind or scope id`)
  return raw
}

export function parseMemoryProviderConfig(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): MemoryProviderConfig | undefined {
  if (!value) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('MEMORY_PROVIDER_CONFIG must be valid JSON')
  }
  const root = object(parsed, 'MEMORY_PROVIDER_CONFIG')
  if (!Array.isArray(root.providers) || !Array.isArray(root.routes))
    throw new Error('MEMORY_PROVIDER_CONFIG requires providers and routes arrays')
  const providers = root.providers.map((value, i): AnyMemoryProviderConfig => {
    const raw = object(value, `MEMORY_PROVIDER_CONFIG.providers[${i}]`)
    const id = string(raw.id, `MEMORY_PROVIDER_CONFIG.providers[${i}].id`)
    if (!ID.test(id) || id === 'default') throw new Error(`invalid memory provider id: ${id}`)
    if (raw.type === 'mcp') throw new Error('memory provider type "mcp" needs the mcp package (parity 16.0)')
    if (raw.type !== 'memorable') throw new Error(`memory provider ${id} has unsupported type`)
    return parseMemorableProvider(raw, id, env)
  })
  const ids = new Set(['default', ...providers.map(({ id }) => id)])
  if (ids.size !== providers.length + 1) throw new Error('memory provider ids must be unique')
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const routes = root.routes.map((value, i): MemoryProviderRoute => {
    const raw = object(value, `MEMORY_PROVIDER_CONFIG.routes[${i}]`)
    const provider = string(raw.provider, `MEMORY_PROVIDER_CONFIG.routes[${i}].provider`)
    if (!ids.has(provider)) throw new Error(`unknown memory provider in route: ${provider}`)
    if (!Array.isArray(raw.scopes) || !raw.scopes.length) throw new Error(`memory route ${i} requires scopes`)
    const capture = raw.capture ?? 'off'
    if (!(['off', 'explicit', 'automatic'] as unknown[]).includes(capture))
      throw new Error(`memory route ${i} has invalid capture policy`)
    const target = providerById.get(provider)
    if (target && !capturePoliciesOf(target).has(capture as MemoryCapturePolicy))
      throw new Error(
        `memory route ${i}: provider ${provider} does not support capture "${String(capture)}" (allowed: ${[...capturePoliciesOf(target)].join(', ')})`,
      )
    return {
      provider,
      scopes: raw.scopes.map((value, j) => scope(value, `memory route ${i}.scopes[${j}]`)),
      capture: capture as MemoryCapturePolicy,
      ...(typeof raw.recall === 'boolean' ? { recall: raw.recall } : {}),
      manage: provider === 'default',
      ...(typeof raw.manage === 'boolean' ? { manage: raw.manage } : {}),
      ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
      failOpen: provider !== 'default',
      ...(typeof raw.failOpen === 'boolean' ? { failOpen: raw.failOpen } : {}),
    }
  })
  return { providers, routes }
}
