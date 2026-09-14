/**
 * Agent-request directives (14.0 tranche 3): the `[[ask-agent: <target> |
 * task]]` reply grammar, the target-ref parsing, and the durable request
 * registry with the target-only decision state machine. qm's surface
 * implementation is provider-shaped; here the directive targets any
 * provider-native user id and the DM/approval flow rides the im-core
 * bridge.
 */
import type {
  AgentRequestDecisionOutcome,
  AgentRequestRecord,
  AgentRequestStore,
} from './contract.ts'

/**
 * Rendered into the IM system prompt when agent requests are enabled.
 * qm's instruction, provider-neutralized.
 */
export const AGENT_REQUEST_INSTRUCTION =
  'In a shared channel, you may need a specific person\'s personal agent because the needed ' +
  'resource, login, environment variable, or private setup belongs to that person and cannot be ' +
  'borrowed by the channel agent. Do not claim you know what\'s in their personal setup unless the ' +
  'conversation says so. Instead, ask that person\'s personal agent by writing a directive somewhere ' +
  'in your reply: `[[ask-agent: <@USERID> | task for their personal agent]]`. Use the user id ' +
  'shown in the People here line, for example `<@U123>`. The task should say exactly what the ' +
  'personal agent should try and what result is safe to share back to this thread; never ask it to ' +
  'reveal secrets. The host strips this directive from what humans see, DMs that person for ' +
  'approval, runs their personal agent only if they approve, and posts the result back here with ' +
  'clear agent labels. If you do not know which person to ask, ask the channel who should be involved. ' +
  'This is only for a person\'s private setup: another agent already in the channel (shown as `agent` in ' +
  'the People here line) is a colleague, not a personal agent to hand off to — just @mention it in your ' +
  'normal reply using its `<@…>` id and it will answer here in the thread.'

const AGENT_REQUEST_DIRECTIVE = /\[\[ask-agent:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\]\]/gi
const TRAILING_OPEN_AGENT_REQUEST_DIRECTIVE = /\[\[ask-agent:[\s\S]*$/i
const USER_REF = /^(?:<@([A-Za-z0-9_-]+)(?:\|[^>]*)?>|@?([A-Za-z0-9_-]+))$/

export function parseUserRef(ref: string): string | undefined {
  const m = USER_REF.exec(ref.trim())
  return m?.[1] ?? m?.[2]
}

export function extractAgentRequests(reply: string): {
  text: string
  requests: Array<{ targetUserId: string; task: string }>
} {
  const requests: Array<{ targetUserId: string; task: string }> = []
  const text = reply
    .replace(AGENT_REQUEST_DIRECTIVE, (_match, targetRef: string, taskRaw: string) => {
      const targetUserId = parseUserRef(targetRef ?? '')
      const task = (taskRaw ?? '').trim()
      if (targetUserId && task) requests.push({ targetUserId, task })
      return ''
    })
    .replace(TRAILING_OPEN_AGENT_REQUEST_DIRECTIVE, '')
  return { text, requests }
}

export function stripAgentRequestDirectives(partial: string): string {
  if (!partial) return partial ?? ''
  return partial.replace(AGENT_REQUEST_DIRECTIVE, '').replace(TRAILING_OPEN_AGENT_REQUEST_DIRECTIVE, '')
}

/** In-memory registry; the Postgres twin satisfies the same semantics. */
export function createMemoryAgentRequestStore(): AgentRequestStore {
  const records = new Map<string, AgentRequestRecord>()
  return {
    async record(input) {
      const existing = records.get(input.requestId)
      if (existing) return existing
      const record: AgentRequestRecord = { ...input, status: 'pending' }
      records.set(input.requestId, record)
      return record
    },
    async get(requestId) {
      return records.get(requestId) ?? null
    },
    async decide(requestId, decision) {
      const record = records.get(requestId)
      if (!record) return { outcome: 'not_found' }
      if (record.status !== 'pending') {
        return { outcome: 'already_decided', approved: record.status === 'approved', record }
      }
      if (decision.decidedBy !== `${record.provider}:${record.targetUserId}`) {
        return { outcome: 'forbidden', record }
      }
      const next: AgentRequestRecord = {
        ...record,
        status: decision.approved ? 'approved' : 'declined',
        decidedBy: decision.decidedBy,
        decidedAt: Date.now(),
      }
      records.set(requestId, next)
      return { outcome: 'decided', approved: decision.approved, record: next }
    },
    async listPending(opts) {
      const limit = opts?.limit ?? 100
      return [...records.values()]
        .filter((r) => r.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
    },
    async close() {},
  }
}

export type { AgentRequestDecisionOutcome, AgentRequestRecord, AgentRequestStore }
