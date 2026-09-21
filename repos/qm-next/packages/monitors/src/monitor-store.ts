/**
 * Monitor store contract (qm `src/monitors/monitor-store.ts`):
 * durable records keyed by `id` describing a single watch over a
 * background process — what pattern to match, where to deliver the
 * reply, when to expire, and the cursor into the underlying stream.
 *
 * The store backs both the broker (arm/re-arm/unwatch) and the poller
 * (`./monitor-poller.ts`), which drives armed watches from the
 * composition root's sandbox and fire engine.
 */
import { randomUUID } from 'node:crypto'
import { samePerson } from '@qm/admin'
import type { Destination, ScopeId } from '@qm/types'
import { createMemoryMap, createPgPool, createPostgresMap, type DurableMap } from '@qm/store'

export interface Monitor extends Record<string, unknown> {
  id: string
  ownerScopeId: ScopeId
  owner: string
  createdBy: string
  ownerConsentedAt?: number
  destination?: Destination
  enabled: boolean
  createdAt: number
  lastFiredAt?: number
  processId: string
  command: string
  threadRef: string
  instructions?: string
  pattern?: string
  cursor: number
  tail?: string
  expiresAt: number
  lastError?: string
}

export interface CreateMonitorInput {
  owner: string
  createdBy: string
  ownerScopeId: ScopeId
  destination?: Destination
  ownerConsentedAt?: number
  processId: string
  command: string
  threadRef: string
  instructions?: string
  pattern?: string
  cursor?: number
  expiresAt: number
}

export interface MonitorStore {
  create(input: CreateMonitorInput): Promise<Monitor>
  get(id: string): Promise<Monitor | null>
  list(): Promise<Monitor[]>
  enabled(): Promise<Monitor[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
  delete(id: string): Promise<void>
  advance(id: string, fields: { cursor: number; tail?: string; firedAt?: number }): Promise<void>
  update(id: string, fields: { instructions?: string; pattern?: string; cursor?: number }): Promise<void>
  recordError(id: string, error: string): Promise<void>
  close?(): Promise<void>
}

function assertNoEscalation(input: { owner: string; createdBy: string; ownerConsentedAt?: number }): void {
  if (!samePerson(input.owner, input.createdBy) && !input.ownerConsentedAt) {
    throw new Error("assigning a different owner requires that owner's consent")
  }
}

function buildTriggerBase(input: CreateMonitorInput, id: string, createdAt: number): Pick<
  Monitor,
  | 'id'
  | 'ownerScopeId'
  | 'owner'
  | 'createdBy'
  | 'enabled'
  | 'createdAt'
  | 'destination'
  | 'ownerConsentedAt'
> {
  return {
    id,
    ownerScopeId: input.ownerScopeId,
    owner: input.owner,
    createdBy: input.createdBy,
    enabled: true,
    createdAt,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.ownerConsentedAt ? { ownerConsentedAt: input.ownerConsentedAt } : {}),
  }
}

async function setTriggerEnabled(backing: DurableMap<Monitor>, id: string, enabled: boolean): Promise<void> {
  await backing.merge(id, { enabled })
}

export function createMemoryMonitorStore(backing: DurableMap<Monitor> = createMemoryMap<Monitor>()): MonitorStore {
  return {
    async create(input: CreateMonitorInput): Promise<Monitor> {
      assertNoEscalation(input)
      const monitor: Monitor = {
        ...buildTriggerBase(input, randomUUID(), Date.now()),
        processId: input.processId,
        command: input.command,
        threadRef: input.threadRef,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        cursor: input.cursor ?? 0,
        expiresAt: input.expiresAt,
      }
      await backing.put(monitor.id, monitor)
      return monitor
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async enabled(): Promise<Monitor[]> {
      return (await backing.all()).filter((m) => m.enabled)
    },
    setEnabled: (id, enabled) => setTriggerEnabled(backing, id, enabled),
    delete: (id) => backing.delete(id),
    async advance(id, fields): Promise<void> {
      await backing.merge(id, {
        cursor: fields.cursor,
        ...(fields.tail !== undefined ? { tail: fields.tail } : { tail: undefined }),
        ...(fields.firedAt !== undefined ? { lastFiredAt: fields.firedAt } : {}),
      } as unknown as Partial<Monitor>)
    },
    async update(id, fields): Promise<void> {
      const patch: Partial<Monitor> = {
        ...(fields.instructions !== undefined ? { instructions: fields.instructions } : {}),
        ...(fields.pattern !== undefined ? { pattern: fields.pattern } : {}),
        ...(fields.cursor !== undefined ? { cursor: fields.cursor, tail: undefined } : {}),
      } as unknown as Partial<Monitor>
      if (Object.keys(patch).length) await backing.merge(id, patch)
    },
    async recordError(id, error): Promise<void> {
      await backing.merge(id, { lastError: error })
    },
  }
}

export function createPostgresMonitorStore(
  connectionString: string,
  table = 'monitors',
): MonitorStore {
  const pg = createPgPool(connectionString, [])
  const backing = createPostgresMap<Monitor>(pg, table)
  return {
    create: async (input: CreateMonitorInput): Promise<Monitor> => {
      assertNoEscalation(input)
      const monitor: Monitor = {
        ...buildTriggerBase(input, randomUUID(), Date.now()),
        processId: input.processId,
        command: input.command,
        threadRef: input.threadRef,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        cursor: input.cursor ?? 0,
        expiresAt: input.expiresAt,
      }
      await backing.put(monitor.id, monitor)
      return monitor
    },
    get: (id) => backing.get(id),
    list: () => backing.all(),
    async enabled(): Promise<Monitor[]> {
      return (await backing.all()).filter((m) => m.enabled)
    },
    setEnabled: (id, enabled) => setTriggerEnabled(backing, id, enabled),
    delete: (id) => backing.delete(id),
    async advance(id, fields): Promise<void> {
      await backing.merge(id, {
        cursor: fields.cursor,
        ...(fields.tail !== undefined ? { tail: fields.tail } : { tail: undefined }),
        ...(fields.firedAt !== undefined ? { lastFiredAt: fields.firedAt } : {}),
      } as unknown as Partial<Monitor>)
    },
    async update(id, fields): Promise<void> {
      const patch: Partial<Monitor> = {
        ...(fields.instructions !== undefined ? { instructions: fields.instructions } : {}),
        ...(fields.pattern !== undefined ? { pattern: fields.pattern } : {}),
        ...(fields.cursor !== undefined ? { cursor: fields.cursor, tail: undefined } : {}),
      } as unknown as Partial<Monitor>
      if (Object.keys(patch).length) await backing.merge(id, patch)
    },
    async recordError(id, error): Promise<void> {
      await backing.merge(id, { lastError: error })
    },
  }
}