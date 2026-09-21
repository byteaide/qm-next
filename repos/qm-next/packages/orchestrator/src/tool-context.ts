/**
 * P1 ToolContext assembly over a Sandbox: execute/read/write/computer status
 * and background process sessions are real; every M3 surface (publish,
 * memory, skills, crons, webhooks, soul, playground, MCP) answers with its
 * graceful-unavailable value so harness tools render honest messages.
 * Parity source: qm src/tools/primitives.ts createToolContext (P1 face).
 */
import {
  CONTROL_UNAVAILABLE,
  CapabilityUnsupportedError,
  hasParentPathSegment,
  supportsProcessSessions,
  type ComputerStatus,
  type ExecResult,
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

export interface SandboxToolContextDeps {
  sandbox: Sandbox
  handle: SandboxHandle
  scopeId: ScopeId
  execTimeoutMs?: number
  execTimeoutCeilingMs?: number
  processRegistrar?: ProcessRegistrar
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
  const ceiling = deps.execTimeoutCeilingMs ?? DEFAULT_EXEC_TIMEOUT_CEILING_MS
  const processes: ProcessSandbox | null = supportsProcessSessions(sandbox) ? sandbox : null

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
      return sandbox.run(handle, command, opts)
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
      const content = await sandbox.readFile(handle, path)
      return { content, sourceScopeId: content === null ? null : scopeId }
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

    mcpToolDefs: (): McpToolDescriptor[] => [],
    callMcpTool: async () => unavailable('MCP tools'),

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

    cronCreate: async () => CONTROL_UNAVAILABLE,
    cronList: async () => CONTROL_UNAVAILABLE,
    cronGet: async () => CONTROL_UNAVAILABLE,
    cronRuns: async () => CONTROL_UNAVAILABLE,
    cronPatch: async () => CONTROL_UNAVAILABLE,
    cronDelete: async () => CONTROL_UNAVAILABLE,
    cronSetEnabled: async () => CONTROL_UNAVAILABLE,
    cronRun: async () => CONTROL_UNAVAILABLE,
    cronRetarget: async () => CONTROL_UNAVAILABLE,
    webhookCreate: async () => CONTROL_UNAVAILABLE,
    webhookList: async () => CONTROL_UNAVAILABLE,
    webhookDisable: async () => CONTROL_UNAVAILABLE,
    soulRead: () => CONTROL_UNAVAILABLE,
    soulWrite: async () => CONTROL_UNAVAILABLE,
    shareArtifact: async (_req: ShareArtifactRequest): Promise<ShareArtifactResult> => unavailable('artifact sharing'),
  }
}
