/**
 * Skill registry + lookup port (15.0): 14.0's collision-checked names and
 * scope-chain resolution, plus the qm full lifecycle (create/review/publish
 * with HMAC signatures and capability grants), pack ingest/sync, bundles,
 * and sandbox materialization. `register` keeps the M3 simplified path
 * (creates a published skill in one call); the full draft → reviewed →
 * published surface is the optional `create`/`review`/`promote` set so
 * older deployments stay runnable.
 */
import type { ScopeId } from '@qm/types'

export type SkillStatus = 'draft' | 'reviewed' | 'published' | 'archived'

/** One asset file shipped under a skill directory. */
export interface SkillFile {
  path: string
  content: string
  executable?: boolean
}

/** One full skill description, normalized by `normalizeSkill` for ingest. */
export interface SkillManifest {
  name: string
  description: string
  requiredCapabilities: string[]
  body: string
  files?: SkillFile[]
}

/** Reference to the pack a skill was imported from. */
export interface SkillPackRef {
  packId: string
  commit: string
  upstreamName: string
}

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
  /** Files shipped with the skill (15.0; pack-ingest flow). */
  files?: SkillFile[]
  /** Capabilities granted by reviewers; publish requires these to cover requiredCapabilities. */
  grantedCapabilities?: string[]
  /** Reviewers who approved the skill before publish. */
  approvals?: string[]
  /** HMAC of the canonical manifest, verified on review and promote. */
  signature?: string
  /** Pack provenance for ingest-imported skills. */
  pack?: SkillPackRef
}

export interface SkillRegisterInput {
  scopeId: ScopeId
  name: string
  description: string
  body: string
  requiredCapabilities?: string[]
  createdBy: string
  files?: SkillFile[]
  pack?: SkillPackRef
}

export interface SkillCreateInput {
  scopeId: ScopeId
  manifest: SkillManifest
  createdBy: string
  pack?: SkillPackRef
  /** Reviewer actor id (15.0 lifecycle). */
  reviewer: string
  /** Capabilities the reviewer grants; must cover manifest.requiredCapabilities for publish. */
  grantCapabilities?: string[]
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
  /** Full lifecycle (15.0): draft → reviewed → published. Optional for backward compatibility. */
  create?(input: SkillCreateInput): Promise<SkillRecord>
  /** Verifies the manifest signature with the store's signing secret. */
  verify?(skill: SkillRecord): boolean
  /** Restores an archived skill by writing its full record back. */
  restore?(skill: SkillRecord): Promise<void>
  /** Re-publishes a skill into a target scope; refuses when capability grants don't cover. */
  promote?(id: string, targetScopeId: ScopeId): Promise<SkillRecord>
  /** Cedes a skill to a non-org scope without re-granting capabilities. */
  move?(id: string, toScopeId: ScopeId): Promise<SkillRecord>
  close?(): Promise<void>
}

export function skillCollisionMessage(scopeId: ScopeId, name: string): string {
  return `skill name collision in scope ${scopeId}: ${name}`
}

export function unknownSkillMessage(id: string): string {
  return `unknown skill: ${id}`
}
