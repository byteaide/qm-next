/**
 * Skill registry + lookup port (14.0, frozen): collision-checked names and
 * name → materialized skill body resolution across an ordered scope chain,
 * per m3-scope 14.0. `register` creates a published skill — the M3 registry
 * is deployment-side, so qm's draft/review/capability-grant lifecycle,
 * manifest HMAC signatures, pack fetching, bundle stores and the sync
 * engine are OUT; `publish`/`archive` remain for later ingest paths.
 */
import type { ScopeId } from '@qm/types'

export type SkillStatus = 'draft' | 'published' | 'archived'

export interface SkillRecord {
  id: string
  scopeId: ScopeId
  name: string
  description: string
  body: string
  requiredCapabilities: string[]
  status: SkillStatus
  createdBy: string
  version: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface SkillRegisterInput {
  scopeId: ScopeId
  name: string
  description: string
  body: string
  requiredCapabilities?: string[]
  createdBy: string
}

export interface SkillPatch {
  description?: string
  body?: string
  requiredCapabilities?: string[]
}

export interface SkillResolution {
  skill: SkillRecord | null
  shadowed: SkillRecord[]
}

export interface SkillStore {
  /** Creates a published skill; rejects a published same-name skill in the same scope. */
  register(input: SkillRegisterInput): Promise<SkillRecord>
  /** Patches description/body/capabilities; names are immutable — register a new skill instead. */
  update(id: string, patch: SkillPatch): Promise<SkillRecord>
  get(id: string): Promise<SkillRecord | null>
  list(): Promise<SkillRecord[]>
  publish(id: string): Promise<SkillRecord>
  archive(id: string): Promise<SkillRecord>
  delete(id: string): Promise<void>
  recordUse(id: string, at?: number): Promise<void>
  /** First published record along the ordered scope chain wins; the rest shadow. */
  resolve(name: string, orderedScopes: ScopeId[]): Promise<SkillResolution>
  visibleFor(orderedScopes: ScopeId[]): Promise<SkillResolution[]>
  close?(): Promise<void>
}

export function skillCollisionMessage(scopeId: ScopeId, name: string): string {
  return `skill name collision in scope ${scopeId}: ${name}`
}

export function unknownSkillMessage(id: string): string {
  return `unknown skill: ${id}`
}
