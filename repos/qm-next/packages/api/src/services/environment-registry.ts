/**
 * Agent environment registry (11.0 tranche 5, lane A) — qm's app
 * `listEnvironments/createEnvironment/resolveEnvironmentByName/attachScope`
 * over an in-memory map; owner-gated attach is enforced at the route layer.
 */
import { randomUUID } from 'node:crypto'

export interface AgentEnvironment {
  id: string
  name: string
  ownerActorId: string
  createdAt: number
}

export interface EnvironmentAttachment {
  environmentId: string
  scopeId: string
  attachedAt: number
}

export interface EnvironmentRegistry {
  create(input: { name: string; ownerActorId: string }): AgentEnvironment
  resolveByName(name: string): AgentEnvironment | undefined
  list(): Array<{ environment: AgentEnvironment; attachments: EnvironmentAttachment[] }>
  attach(environmentId: string, scopeId: string): void
}

export function createMemoryEnvironmentRegistry(opts: { now?: () => number; id?: () => string } = {}): EnvironmentRegistry {
  const now = opts.now ?? Date.now
  const nextId = opts.id ?? randomUUID
  const environments = new Map<string, AgentEnvironment>()
  const attachments = new Map<string, EnvironmentAttachment[]>()
  return {
    create({ name, ownerActorId }) {
      const env: AgentEnvironment = { id: nextId(), name, ownerActorId, createdAt: now() }
      environments.set(env.id, env)
      attachments.set(env.id, [])
      return { ...env }
    },
    resolveByName(name) {
      for (const env of environments.values()) if (env.name === name) return { ...env }
      return undefined
    },
    list() {
      return [...environments.values()].map((env) => ({
        environment: { ...env },
        attachments: (attachments.get(env.id) ?? []).map((a) => ({ ...a })),
      }))
    },
    attach(environmentId, scopeId) {
      const rows = attachments.get(environmentId) ?? []
      if (!rows.some((a) => a.scopeId === scopeId)) {
        rows.push({ environmentId, scopeId, attachedAt: now() })
        attachments.set(environmentId, rows)
      }
    },
  }
}
