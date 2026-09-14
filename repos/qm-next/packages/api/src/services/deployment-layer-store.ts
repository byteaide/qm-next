/**
 * Lane-A deployment-layer store: the durable tools/skills bundle record
 * with content hashing and versioning. In memory the bundle is always
 * "applied" (live() reports the builtin source); the Postgres swap keeps
 * the same record shape and error classes.
 */
import { createHash } from 'node:crypto'

export interface DeploymentLayerBundle {
  contract: 1
  tools: unknown[]
  skills: unknown[]
}

export interface DeploymentLayerRecord {
  version: number
  contentHash: string
  updatedAt: number
  updatedBy: string
  bundle: DeploymentLayerBundle
  resolved: Record<string, unknown>
}

export class DeploymentLayerValidationError extends Error {}

export interface DeploymentLayerStore {
  readonly durable: boolean
  get(): Promise<DeploymentLayerRecord | null>
  live(): { source: string; contentHash: string | null; resolved: Record<string, unknown> }
  isApplied(contentHash: string): Promise<boolean>
  put(bundle: DeploymentLayerBundle, updatedBy: string): Promise<DeploymentLayerRecord>
}

export function createMemoryDeploymentLayerStore(): DeploymentLayerStore {
  let version = 0
  let record: DeploymentLayerRecord | null = null
  return {
    durable: true,
    async get() {
      return record ? { ...record } : null
    },
    live() {
      return { source: 'builtin', contentHash: null, resolved: { tools: [], skills: [] } }
    },
    async isApplied() {
      return true
    },
    async put(bundle, updatedBy) {
      const contentHash = createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
      version += 1
      record = {
        version,
        contentHash,
        updatedAt: Date.now(),
        updatedBy,
        bundle,
        resolved: { tools: [], skills: [] },
      }
      return { ...record }
    },
  }
}
