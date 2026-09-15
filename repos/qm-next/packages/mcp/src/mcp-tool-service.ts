/**
 * Turns registered MCP servers into callable agent tools.
 *
 * Maintains a cached snapshot of each enabled server's tool list (refreshed
 * when the registry changes and on a slow interval), and executes calls with
 * the server's configured credential. Every call is audited. Tool names are
 * namespaced `<serverId>_<toolName>` so two servers can't collide with each
 * other or with built-in tools.
 *
 * qm parity port: `repos/qm/src/mcp/mcp-tool-service.ts`. Adapations:
 * (a) the audit port is `@qm/admin`'s `AuditLog` (qm re-exports the same
 * `record({...})` shape — we keep the audit attributes identical so an
 * admin's `audit mcp.*` filters continue to match across the swap).
 * (b) The persistent `setInterval` is `unref()`'d so it doesn't keep the
 * process alive past consumer shutdown; `close()` clears it before the
 * `McpServerStore` listener is detached.
 * (c) The snapshot rebuild is best-effort per server: a `listTools`
 * failure records `error: <message>` and skips that server (the others
 * still populate); the next `refresh()` retries on the same scheduler.
 * (d) Server-config changes invalidate the per-server `McpClient` via a
 * structural equality check (qm's `JSON.stringify` approach).
 */
import type { AuditLog } from '@qm/admin'
import {
  createMcpClient,
  mcpResultText,
  type McpAuth,
  type McpClient,
  type McpFetch,
} from './mcp-client.ts'
import type { McpServer, McpServerStore } from './mcp-server-store.ts'
import { errMessage } from './util.ts'

const REFRESH_INTERVAL_MS = 5 * 60_000
const MAX_TOOLS_PER_SERVER = 64
const MAX_RESULT_CHARS = 60_000

export interface McpToolDescriptor {
  name: string
  serverId: string
  remoteName: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

export interface McpToolService {
  toolDefs(): McpToolDescriptor[]
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>
  refresh(): Promise<void>
  probe(server: McpServer): Promise<string[]>
  close(): void
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === 'bearer') return { mode: 'bearer', token: server.bearerToken ?? '' }
  if (server.auth === 'client-credentials') {
    return {
      mode: 'client-credentials',
      clientId: server.clientId ?? '',
      clientSecret: server.clientSecret ?? '',
    }
  }
  return { mode: 'none' }
}

export interface CreateMcpToolServiceOptions {
  servers: McpServerStore
  audit?: AuditLog
  fetchImpl?: McpFetch
  now?: () => number
  refreshIntervalMs?: number
}

export function createMcpToolService(opts: CreateMcpToolServiceOptions): McpToolService {
  const now = opts.now ?? (() => Date.now())
  const clients = new Map<string, { client: McpClient; server: McpServer }>()
  let snapshot: McpToolDescriptor[] = []
  let closed = false
  let refreshPromise: Promise<void> | null = null

  function record(action: string, resource: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || 'system',
      action: `mcp.${action}`,
      resource,
      scopeLabel: 'mcp-connectors',
      status,
    })
  }

  function clientFor(server: McpServer): McpClient {
    const cached = clients.get(server.id)
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client
    const client = createMcpClient({
      url: server.url,
      auth: authOf(server),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    })
    clients.set(server.id, { client, server })
    return client
  }

  async function refreshOnce(): Promise<void> {
    const servers = (await opts.servers.list()).filter((s) => s.enabled)
    const next: McpToolDescriptor[] = []
    for (const server of servers) {
      try {
        const tools = (await clientFor(server).listTools()).slice(0, MAX_TOOLS_PER_SERVER)
        for (const tool of tools) {
          next.push({
            name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
            serverId: server.id,
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: tool.inputSchema,
            readOnly: server.readOnly,
          })
        }
        record('list', server.id, `ok tools=${tools.length}`)
      } catch (e) {
        record('list', server.id, `error: ${errMessage(e)}`)
      }
    }
    // De-duplicate on the namespaced name; first server wins deterministically.
    const seen = new Set<string>()
    snapshot = next.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
  }

  async function refresh(): Promise<void> {
    if (closed) return
    // Coalesce concurrent refreshes (registry change + interval tick race).
    if (refreshPromise) {
      await refreshPromise
      return
    }
    refreshPromise = refreshOnce().catch((e: unknown) => {
      // Last-ditch: a refresh-cycle failure shouldn't crash the service.
      record('refresh', 'all', `error: ${errMessage(e)}`)
    })
    try {
      await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  const unsubscribe = opts.servers.onChange(() => {
    void refresh()
  })
  const timer = setInterval(() => {
    if (!closed) void refresh()
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS)
  // Don't pin the event loop alive past the consumer's lifetime.
  timer.unref?.()
  void refresh()

  return {
    toolDefs: () => snapshot,
    async call(name, args, principalId) {
      const def = snapshot.find((t) => t.name === name)
      if (!def) throw new Error(`unknown MCP tool: ${name}`)
      const server = await opts.servers.get(def.serverId)
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`)
      try {
        const result = await clientFor(server).callTool(def.remoteName, args)
        record('call', `${def.serverId}/${def.remoteName}`, 'ok', principalId)
        const text =
          mcpResultText(result) || JSON.stringify(result.structuredContent ?? '') || ''
        return text.length > MAX_RESULT_CHARS
          ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
          : text
      } catch (e) {
        record('call', `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId)
        throw e
      }
    },
    refresh,
    async probe(server) {
      const client = createMcpClient({
        url: server.url,
        auth: authOf(server),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      })
      const tools = await client.listTools()
      return tools.map((t) => t.name)
    },
    close() {
      closed = true
      clearInterval(timer)
      unsubscribe()
      clients.clear()
      snapshot = []
    },
  }
}