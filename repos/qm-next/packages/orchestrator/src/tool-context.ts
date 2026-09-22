/**
 * P1 ToolContext assembly over a Sandbox: execute/read/write/computer status
 * and background process sessions are real; memory surfaces answer their
 * graceful-unavailable values so harness tools render honest messages. The
 * control-plane faces (cron×9, webhook×3, MCP, shareArtifact) delegate to
 * the optional composition ports below and keep CONTROL_UNAVAILABLE when a
 * port is not wired. Parity source: qm src/tools/primitives.ts
 * createToolContext (P1 face + control ops).
 */
import {
  CONTROL_UNAVAILABLE,
  CapabilityUnsupportedError,
  hasParentPathSegment,
  supportsProcessSessions,
  type ComputerStatus,
  type ControlUnavailable,
  type ExecResult,
  type GrantedHandle,
  type McpToolDescriptor,
  type ProcessSandbox,
  type ProcessState,
  type PublishInput,
  type PublishResult,
  type ReadResult,
  type Sandbox,
  type SandboxHandle,
  type ScopeId,
  type ShareArtifactRequest,
  type ShareArtifactResult,
  type ToolContext,
  type WriteResult,
} from '@qm/types'
import { createNullLedger, type ToolLedger } from '@qm/runs'

/** Control-plane port for the cron tool surface (T1 wiring): full results, never CONTROL_UNAVAILABLE — adapters answer it themselves when their store is missing. */
export type CronControlSurface = Pick<
  ToolContext,
  'cronCreate' | 'cronList' | 'cronGet' | 'cronRuns' | 'cronPatch' | 'cronDelete' | 'cronSetEnabled' | 'cronRun' | 'cronRetarget'
>

/** Control-plane port for the webhook tool surface (T2 wiring). */
export type WebhookControlSurface = Pick<ToolContext, 'webhookCreate' | 'webhookList' | 'webhookDisable'>

/** Control-plane port for the MCP tool surface (T3 wiring). */
export type McpControlSurface = Pick<ToolContext, 'mcpToolDefs' | 'callMcpTool'>

/** Control-plane port for artifact sharing (T4 wiring). */
export type ShareControlSurface = Pick<ToolContext, 'shareArtifact'>

export interface SandboxToolContextDeps {
  sandbox: Sandbox
  handle: SandboxHandle
  scopeId: ScopeId
  /** Turn actor principal id; control surfaces own resources under it when the composition binds one. */
  actorId?: string
  execTimeoutMs?: number
  execTimeoutCeilingMs?: number
  processRegistrar?: ProcessRegistrar
  /** Run replay context (qm parity #28): present for queued Run executions. */
  runId?: string
  attempt?: number
  ledger?: ToolLedger
  /** Cron control plane (@qm/triggers store + scheduler behind the api adapter). */
  crons?: CronControlSurface
  /** Webhook control plane (@qm/api webhook store behind the adapter). */
  webhooks?: WebhookControlSurface
  /** MCP connector service (@qm/mcp tool service). */
  mcp?: McpControlSurface
  /** Artifact sharing (@qm/acl grant ledger behind the adapter). */
  share?: ShareControlSurface
  /**
   * Shared-file face (Q3, segment ⑫): granted handles the conversation
   * audience may read through `shared/<name>` paths. read() resolves
   * handles first; text answers inline, binaries materialize into the
   * sandbox workspace (qm primitives.read ladder).
   */
  sharedFiles?: {
    handles(): Promise<GrantedHandle[]>
    readBytes(ref: string): Promise<Uint8Array | null>
  }
  /**
   * ADR-0018 guidance seam (M-Soul-2.4): conversation-scope standing
   * instructions. Read returns the effective soul (org federation composed);
   * writes are rejected for org scopes (the admin surface owns org policy),
   * matching qm's `soul_update_denied` ladder.
   */
  soul?: {
    read(): { effectiveSoul: string; soul: string | null; soulVersion: number }
    write(
      content: string,
    ): Promise<{ ok: true; version: number } | { ok: false; code: 'soul_update_denied'; message: string }>
  }
}

/**
 * Structural subset of the @qm/processes ProcessRegistry write face the
 * composition may bind: background starts register so records outlive the
 * turn (monitor poller, reaper, cross-instance visibility).
 */
export interface ProcessRegistrar {
  register(rec: {
    processId: string
    scopeId: ScopeId
    kind: 'background'
    command: string
    ttlMs: number
  }): Promise<unknown>
  markStatus?(processId: string, status: 'exited'): Promise<unknown>
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const DEFAULT_EXEC_TIMEOUT_CEILING_MS = 600_000
const DEFAULT_BACKGROUND_TTL_MS = 1_800_000

function guardPath(path: string): void {
  if (hasParentPathSegment(path)) throw new Error('paths must stay inside the workspace')
}

function unavailable(method: string): never {
  throw new Error(`${method} is not available on this deployment`)
}

export function createSandboxToolContext(deps: SandboxToolContextDeps): ToolContext {
  const { sandbox, handle, scopeId, processRegistrar } = deps
  const crons = deps.crons
  const webhooks = deps.webhooks
  const mcp = deps.mcp
  const share = deps.share
  const sharedFiles = deps.sharedFiles

  /**
   * qm primitives.read shared-handle ladder: exact handlePath match;
   * multiple distinct owners answer an ambiguity error; text answers
   * inline with the owner scope; binaries materialize into the workspace.
   */
  async function readSharedHandle(path: string): Promise<ReadResult | null> {
    if (!sharedFiles) return null
    const handles = await sharedFiles.handles()
    const matches = handles.filter((h) => h.handlePath === path)
    if (matches.length === 0) return null
    const distinct = new Set(matches.map((h) => `${h.ownerScopeId}\0${h.ownerPath}`))
    if (distinct.size > 1) {
      return {
        content: `ERROR: ambiguous shared handle "${path}" maps to ${distinct.size} different files`,
        sourceScopeId: null,
      }
    }
    const granted = matches[0]!
    const bytes = await sharedFiles.readBytes(granted.ownerPath)
    if (bytes === null) return { content: null, sourceScopeId: granted.ownerScopeId }
    let asText: string
    try {
      asText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      const name = granted.handlePath.split(/[\\/]/).pop() ?? granted.handlePath
      await sandbox.writeFileBytes(handle, name, bytes)
      return {
        content:
          `[binary file materialized into the sandbox at ${name} (${bytes.length} bytes) — ` +
          `to send it, attach it to a message: name \`${name}\` in the surface \`post\` action's \`files\`]`,
        sourceScopeId: granted.ownerScopeId,
      }
    }
    return { content: asText, sourceScopeId: granted.ownerScopeId }
  }
  const ceiling = deps.execTimeoutCeilingMs ?? DEFAULT_EXEC_TIMEOUT_CEILING_MS
  const processes: ProcessSandbox | null = supportsProcessSessions(sandbox) ? sandbox : null

  const ledger = deps.ledger ?? createNullLedger()
  const runId = deps.runId
  const attempt = deps.attempt ?? 1
  let callIndex = -1

  async function once<T>(produce: () => Promise<T>, shouldCache: (r: T) => boolean = () => true): Promise<T> {
    callIndex += 1
    if (runId === undefined) return produce()
    const prior = await ledger.begin(runId, attempt, callIndex)
    if (prior.cached) return JSON.parse(prior.output ?? 'null') as T
    const result = await produce()
    if (shouldCache(result)) await ledger.record(runId, attempt, callIndex, JSON.stringify(result ?? null))
    return result
  }

  const surfaceRefused = { ok: false, message: 'this deployment does not deliver to conversation surfaces' } as const

  return {
    post: async () => surfaceRefused,
    reach: async () => surfaceRefused,
    react: async () => surfaceRefused,
    edit: async () => surfaceRefused,
    delete: async () => surfaceRefused,
    readThread: async () => ({ ok: true }),
    whatsNew: async () => ({ ok: true, hereNew: 0 }),
    search: async () => ({ ok: true, hits: [], source: 'cache' }),
    readMembers: async () => ({ ok: true, members: [] }),
    readFile: async () => surfaceRefused,
    getStandingOrder: async () => ({ ok: true, orders: '' }),
    setStandingOrder: async () => ({ ok: false, message: 'standing instructions are not available on this deployment' }),
    staySilent: async () => ({ ok: true, message: 'noted' }),

    async execute(
      command: string,
      execOpts?: {
        timeoutSeconds?: number
        scratch?: boolean
        ownerAuth?: boolean
        reachTarget?: string
        signal?: AbortSignal
      },
    ): Promise<ExecResult> {
      if (execOpts?.scratch) throw new Error('scratch execution is not available on this deployment — run without scope:"scratch"')
      if (execOpts?.ownerAuth) throw new Error('owner-auth execution is not available on this deployment — run without scope:"owner"')
      if (execOpts?.reachTarget !== undefined) throw new Error('reach execution is not available on this deployment')
      const resolvedMs = execOpts?.timeoutSeconds != null ? execOpts.timeoutSeconds * 1000 : DEFAULT_EXEC_TIMEOUT_MS
      const timeoutMs = Math.min(resolvedMs, ceiling)
      const opts =
        execOpts?.signal
          ? { timeoutMs, signal: execOpts.signal }
          : { timeoutMs }
      return once(
        () => sandbox.run(handle, command, opts),
        (r) => r.code === 0,
      )
    },

    async computerStatus(): Promise<ComputerStatus> {
      if (!sandbox.computerStatus) return { machine: 'unknown', guestResponsive: false }
      return sandbox.computerStatus(scopeId)
    },

    async restartComputer(): Promise<void> {
      if (!sandbox.restartComputer) throw new CapabilityUnsupportedError(sandbox.profile.backend, 'computer restart')
      await sandbox.restartComputer(scopeId)
    },

    async read(path: string): Promise<ReadResult> {
      guardPath(path)
      return once(
        async () => {
          if (sharedFiles && path.startsWith('shared/')) {
            const shared = await readSharedHandle(path)
            if (shared) return shared
          }
          const content = await sandbox.readFile(handle, path)
          return { content, sourceScopeId: content === null ? null : scopeId }
        },
        (r) => r.content !== null,
      )
    },

    async write(path: string, data?: string): Promise<WriteResult> {
      guardPath(path)
      await sandbox.writeFile(handle, path, data ?? '')
      return { shared: [] }
    },

    publish: async (_input: PublishInput): Promise<PublishResult> => unavailable('publishing'),
    createPlayground: async (_input: { title: string; html: string }) => unavailable('the playground'),

    memorySearch: async () => null,
    memoryRead: async () => null,
    memoryRemember: async () => null,
    memoryRewrite: async () => null,
    history: async () => [],

    mcpToolDefs: mcp ? () => mcp.mcpToolDefs() : (): McpToolDescriptor[] => [],
    callMcpTool: mcp ? (name, args) => mcp.callMcpTool(name, args) : async () => unavailable('MCP tools'),

    async backgroundStart(command: string) {
      if (!processes) throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background processes')
      const start = await processes.startProcess(handle, command)
      if (processRegistrar) {
        await processRegistrar.register({
          processId: start.processId,
          scopeId,
          kind: 'background',
          command,
          ttlMs: DEFAULT_BACKGROUND_TTL_MS,
        })
      }
      const first = await processes.readProcess(handle, start.processId, { maxBytes: 8192 })
      if (first.status.state === 'exited') await processRegistrar?.markStatus?.(start.processId, 'exited')
      return { processId: start.processId, output: first.chunks, cursor: first.cursor, status: first.status satisfies ProcessState, reattached: false }
    },

    async backgroundPoll(processId: string, opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number }) {
      if (!processes) throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background processes')
      const r = await processes.readProcess(handle, processId, {
        ...(opts?.sinceCursor !== undefined ? { sinceCursor: opts.sinceCursor } : {}),
        ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
        ...(opts?.waitSeconds !== undefined ? { waitMs: opts.waitSeconds * 1000 } : {}),
      })
      if (r.status.state === 'exited') await processRegistrar?.markStatus?.(processId, 'exited')
      return { processId, chunks: r.chunks, cursor: r.cursor, status: r.status satisfies ProcessState }
    },

    async backgroundStop(processId: string, signal?: string) {
      if (!processes) throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background processes')
      await processes.signalProcess(handle, processId, signal ?? 'TERM')
      const after = await processes.readProcess(handle, processId, { waitMs: 1000 })
      if (after.status.state === 'exited') await processRegistrar?.markStatus?.(processId, 'exited')
      return { processId, status: after.status satisfies ProcessState, stopped: true }
    },

    async backgroundWrite(processId: string, data: string) {
      if (!processes) throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background processes')
      await processes.writeStdin(handle, processId, data)
      const after = await processes.readProcess(handle, processId, { waitMs: 0 })
      return { processId, bytes: data.length, status: after.status satisfies ProcessState }
    },

    async backgroundList() {
      if (!processes) throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background processes')
      const sessions = await processes.listProcesses(handle)
      return sessions.map((s) => ({
        processId: s.processId,
        command: s.command,
        status: s.status,
        registryStatus: s.status.state,
        startedAt: s.startedAt,
      }))
    },

    async backgroundWatch(): Promise<never> {
      throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background watch')
    },

    async backgroundUnwatch(_monitorId: string) {
      throw new CapabilityUnsupportedError(sandbox.profile.backend, 'background watch')
    },

    cronCreate: crons ? (req) => crons.cronCreate(req) : async () => CONTROL_UNAVAILABLE,
    cronList: crons ? () => crons.cronList() : async () => CONTROL_UNAVAILABLE,
    cronGet: crons ? (id) => crons.cronGet(id) : async () => CONTROL_UNAVAILABLE,
    cronRuns: crons ? (id, req) => crons.cronRuns(id, req) : async () => CONTROL_UNAVAILABLE,
    cronPatch: crons ? (id, req) => crons.cronPatch(id, req) : async () => CONTROL_UNAVAILABLE,
    cronDelete: crons ? (id) => crons.cronDelete(id) : async () => CONTROL_UNAVAILABLE,
    cronSetEnabled: crons ? (id, enabled) => crons.cronSetEnabled(id, enabled) : async () => CONTROL_UNAVAILABLE,
    cronRun: crons ? (id) => crons.cronRun(id) : async () => CONTROL_UNAVAILABLE,
    cronRetarget: crons ? (id, destinationKey) => crons.cronRetarget(id, destinationKey) : async () => CONTROL_UNAVAILABLE,
    webhookCreate: webhooks ? (req) => webhooks.webhookCreate(req) : async () => CONTROL_UNAVAILABLE,
    webhookList: webhooks ? () => webhooks.webhookList() : async () => CONTROL_UNAVAILABLE,
    webhookDisable: webhooks ? (id) => webhooks.webhookDisable(id) : async () => CONTROL_UNAVAILABLE,
    soulRead: () => deps.soul?.read() ?? CONTROL_UNAVAILABLE,
    soulWrite: async (content) => {
      if (!deps.soul) return CONTROL_UNAVAILABLE
      if (scopeId.startsWith('org:')) {
        return { ok: false, code: 'soul_update_denied', message: 'org soul is managed on the admin surface' }
      }
      return deps.soul.write(content)
    },
    shareArtifact: share
      ? (req: ShareArtifactRequest): Promise<ShareArtifactResult | ControlUnavailable> => share.shareArtifact(req)
      : async (_req: ShareArtifactRequest): Promise<ShareArtifactResult> => unavailable('artifact sharing'),
  }
}
