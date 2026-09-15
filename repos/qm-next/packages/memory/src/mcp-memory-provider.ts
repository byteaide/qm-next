/**
 * Memory provider that bridges a remote MCP server's tools to the qm-next
 * `ScopeMemory` contract. Each provider instance owns one read tool
 * (always required) and an optional write tool; reads use the recall/query
 * paths, writes use capture. The notebook methods (head/get/replace/…)
 * throw because the remote is the source of truth, not a notebook the
 * admin can edit through this surface.
 *
 * qm parity port: `repos/qm/src/memory/mcp-memory-provider.ts`. Adapts to
 * the qm-next `ScopeMemory` interface (no `read(scopeId)` overload — it
 * collapses into `get(scopeId)` with an empty query), and threads
 * `MemoryCaptureContext` through to the write op.
 */
import type { ScopeId } from '@qm/types'
import { mcpResultText, type McpClient, type McpToolResult } from '@qm/mcp'
import type { MemoryCaptureContext, ScopeMemory } from './contract.ts'

export interface McpMemoryOperation {
  client: McpClient
  tool: string
  queryArg?: string
  contentArg?: string
  actorArg?: string
  scopeArg?: string
  maxCharsArg?: string
  inputArg?: string
  replyArg?: string
  capturedAtArg?: string
  sourceArg?: string
  idempotencyArg?: string
  timeoutMs: number
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`memory provider timed out after ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resultText(result: McpToolResult): string {
  const text = mcpResultText(result)
  if (text) return text
  return result.structuredContent == null ? '' : JSON.stringify(result.structuredContent)
}

export function createMcpMemoryProvider(opts: {
  read: McpMemoryOperation
  write?: McpMemoryOperation
}): ScopeMemory {
  const read = async (
    scopeId: ScopeId,
    query: string,
    actorId?: string,
    maxChars?: number,
  ): Promise<string> => {
    const op = opts.read
    const args: Record<string, unknown> = { [op.queryArg ?? 'query']: query }
    if (actorId) args[op.actorArg ?? 'acting_user'] = actorId
    if (op.scopeArg) args[op.scopeArg] = scopeId
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars
    const text = resultText(await withTimeout(op.client.callTool(op.tool, args), op.timeoutMs))
    return maxChars && text.length > maxChars ? text.slice(0, maxChars) : text
  }

  const notEditable = (): never => {
    throw new Error('MCP memory providers do not support notebook replacement')
  }

  return {
    async head(): Promise<{ content: string; revision: string }> {
      return { content: '', revision: '0' }
    },

    async get(scopeId) {
      return read(scopeId, '')
    },

    replace: notEditable,

    async replaceIfRevision() {
      return false
    },

    async append(scopeId, facts, at, author) {
      return captureInternal(scopeId, facts, at, author, undefined)
    },

    async capture(scopeId, facts, at, author, context) {
      return captureInternal(scopeId, facts, at, author, context)
    },

    async recall(scopeId, recOpts) {
      const query = recOpts?.query ?? ''
      const text = await read(scopeId, query, undefined, recOpts?.maxChars)
      return text
    },

    async query(scopeId, q, limit = 20) {
      const text = await read(scopeId, q)
      return text ? text.split('\n').filter((line) => line.length > 0).slice(0, limit) : []
    },

    async history() {
      return []
    },

    async restore() {
      return false
    },
  }

  async function captureInternal(
    scopeId: ScopeId,
    facts: string[],
    at: number,
    author: string | undefined,
    context: MemoryCaptureContext | undefined,
  ): Promise<number> {
    const op = opts.write
    if (!op) throw new Error('brain write is not configured')
    const args: Record<string, unknown> = { [op.contentArg ?? 'content']: facts.join('\n') }
    if (context?.input && op.inputArg) args[op.inputArg] = context.input
    if (context?.reply && op.replyArg) args[op.replyArg] = context.reply
    if (op.capturedAtArg) args[op.capturedAtArg] = at
    if (op.sourceArg) args[op.sourceArg] = context?.mode ?? 'explicit'
    if (context?.idempotencyKey && op.idempotencyArg) args[op.idempotencyArg] = context.idempotencyKey
    const actorId = context?.actorId ?? author
    if (actorId) args[op.actorArg ?? 'acting_user'] = actorId
    if (op.scopeArg) args[op.scopeArg] = scopeId
    await withTimeout(op.client.callTool(op.tool, args), op.timeoutMs)
    return facts.length
  }
}