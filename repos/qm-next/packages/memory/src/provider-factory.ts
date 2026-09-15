/**
 * Config → routed ScopeMemory factory, ported from qm's
 * `provider-factory.ts`. Two provider types: memorable (procedural
 * recall over a CLI) and mcp (HTTP tool calls into a remote memory
 * server). Both fold into the routed ScopeMemory via
 * `createRoutedMemoryService`.
 */
import type { McpFetch } from '@qm/mcp'
import { createMcpClient } from '@qm/mcp'
import type { SessionEntry } from '@qm/types'
import type { ScopeMemory } from './contract.ts'
import { createMemorableMemoryProvider } from './memorable/provider.ts'
import { createMcpMemoryProvider, type McpMemoryOperation } from './mcp-memory-provider.ts'
import type { AnyMemoryProviderConfig, McpMemoryOperationConfig, MemoryProviderConfig } from './provider-config.ts'
import { createRoutedMemoryService } from './provider-router.ts'
import { errMessage } from './util.ts'

function mcpOperation(
  url: string,
  spec: McpMemoryOperationConfig,
  timeoutMs: number,
  fetchImpl?: McpFetch,
): McpMemoryOperation {
  return {
    client: createMcpClient({
      url,
      auth: { mode: 'client-credentials', ...spec.auth },
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    tool: spec.tool,
    timeoutMs,
    ...(spec.queryArg ? { queryArg: spec.queryArg } : {}),
    ...(spec.contentArg ? { contentArg: spec.contentArg } : {}),
    ...(spec.actorArg ? { actorArg: spec.actorArg } : {}),
    ...(spec.scopeArg ? { scopeArg: spec.scopeArg } : {}),
    ...(spec.maxCharsArg ? { maxCharsArg: spec.maxCharsArg } : {}),
    ...(spec.inputArg ? { inputArg: spec.inputArg } : {}),
    ...(spec.replyArg ? { replyArg: spec.replyArg } : {}),
    ...(spec.capturedAtArg ? { capturedAtArg: spec.capturedAtArg } : {}),
    ...(spec.sourceArg ? { sourceArg: spec.sourceArg } : {}),
    ...(spec.idempotencyArg ? { idempotencyArg: spec.idempotencyArg } : {}),
  }
}

export function createConfiguredMemoryService(opts: {
  defaultMemory: ScopeMemory
  config?: MemoryProviderConfig
  fetchImpl?: McpFetch
  /** Session trace access for providers that derive memory from tool-call history (currently "memorable"). */
  sessionEntries?: (sessionId: string) => Promise<SessionEntry[]>
  onError?: (error: unknown, provider: string, operation: 'recall' | 'query' | 'capture') => void
}): ScopeMemory {
  if (!opts.config) return opts.defaultMemory
  const providers: Record<string, ScopeMemory> = { default: opts.defaultMemory }
  for (const provider of opts.config.providers) {
    installProvider(providers, provider, opts)
  }
  return createRoutedMemoryService({
    providers,
    routes: opts.config.routes,
    onError:
      opts.onError ??
      ((error, provider, operation) => console.error(`[memory] ${provider} ${operation} failed: ${errMessage(error)}`)),
  })
}

function installProvider(
  providers: Record<string, ScopeMemory>,
  provider: AnyMemoryProviderConfig,
  opts: {
    fetchImpl?: McpFetch
    sessionEntries?: (sessionId: string) => Promise<SessionEntry[]>
  },
): void {
  if (provider.type === 'memorable') {
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
    return
  }
  providers[provider.id] = createMcpMemoryProvider({
    read: mcpOperation(provider.url, provider.read, provider.timeoutMs, opts.fetchImpl),
    ...(provider.write ? { write: mcpOperation(provider.url, provider.write, provider.timeoutMs, opts.fetchImpl) } : {}),
  })
}

/** Replaces every configured secret value occurrence before relay. */
function createSecretValueMasker(values: Record<string, string>): (text: string) => string {
  const entries = Object.entries(values).filter(([v]) => v.length >= 3)
  return (text) => {
    let out = text
    for (const [value] of entries) out = out.split(value).join('[redacted]')
    return out
  }
}