/**
 * Config → routed ScopeMemory factory, ported from qm's
 * `provider-factory.ts` (memorable branch; the mcp branch lands with the
 * 16.0 mcp package). Session trace access backs providers that derive
 * memory from tool-call history.
 */
import type { SessionEntry } from '@qm/types'
import type { ScopeMemory } from './contract.ts'
import { createMemorableMemoryProvider } from './memorable/provider.ts'
import { errMessage } from './util.ts'
import type { MemoryProviderConfig } from './provider-config.ts'
import { createRoutedMemoryService } from './provider-router.ts'

export function createConfiguredMemoryService(opts: {
  defaultMemory: ScopeMemory
  config?: MemoryProviderConfig
  /** Session trace access for providers that derive memory from tool-call history (currently "memorable"). */
  sessionEntries?: (sessionId: string) => Promise<SessionEntry[]>
  onError?: (error: unknown, provider: string, operation: 'recall' | 'query' | 'capture') => void
}): ScopeMemory {
  if (!opts.config) return opts.defaultMemory
  const providers: Record<string, ScopeMemory> = { default: opts.defaultMemory }
  for (const provider of opts.config.providers) {
    if (!opts.sessionEntries)
      throw new Error(`memory provider ${provider.id} needs session access to record procedures`)
    providers[provider.id] = createMemorableMemoryProvider({
      argv: provider.argv,
      env: provider.env,
      injectTimeoutMs: provider.injectTimeoutMs,
      recordTimeoutMs: provider.recordTimeoutMs,
      mask: createSecretValueMasker(provider.redactValues),
      loadEntries: opts.sessionEntries,
    })
  }
  return createRoutedMemoryService({
    providers,
    routes: opts.config.routes,
    onError:
      opts.onError ??
      ((error, provider, operation) => console.error(`[memory] ${provider} ${operation} failed: ${errMessage(error)}`)),
  })
}

/** Replaces every configured secret value occurrence before relay. */
function createSecretValueMasker(values: Record<string, string>): (text: string) => string {
  const entries = Object.entries(values).filter(([v]) => v.length >= 3)
  return (text: string) => {
    let out = text
    for (const [value] of entries) out = out.split(value).join('[redacted]')
    return out
  }
}
