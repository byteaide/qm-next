/**
 * Lane-A deployment store: app deployments with versions, archive state,
 * viewer visibility (owner scope or grant), and the manage/share surface
 * the deployment routes use. There is no live runtime in lane A — fetch
 * and logs answer the qm unreachable/no-logs shapes.
 */
import { randomUUID } from 'node:crypto'
import type { GrantLedger } from './grant-ledger.ts'

export type DeploymentStatus = 'live' | 'archived'

export interface DeploymentVersion {
  version: number
  createdAt: number
  commit?: string
  parentCommit?: string
}

export interface DeploymentRecord {
  id: string
  ownerScopeId: string
  createdBy: string
  createdInScope?: string
  name?: string
  displayName?: string
  currentVersion: number
  appliedVersion?: number
  status: DeploymentStatus
  lastAccessAt?: number
  versions: DeploymentVersion[]
}

export interface DeploymentView {
  id: string
  ownerScopeId: string
  createdBy: string
  createdInScope?: string
  name?: string
  displayName?: string
  currentVersion: number
  appliedVersion?: number
  status: DeploymentStatus
  lastAccessAt?: number
  createdAt?: number
  updatedAt?: number
  versions: DeploymentVersion[]
}

export interface ViewerDeployment extends DeploymentView {
  permission: 'read' | 'write'
}

export interface DeployInput {
  ownerScopeId: string
  createdBy: string
  entrypoint: string
  files: unknown[]
  name?: string
}

export function deploymentView(d: DeploymentRecord): DeploymentView {
  const versions = d.versions.map(({ version, createdAt, commit, parentCommit }) => ({
    version,
    createdAt,
    ...(commit ? { commit } : {}),
    ...(parentCommit ? { parentCommit } : {}),
  }))
  return {
    id: d.id,
    ownerScopeId: d.ownerScopeId,
    createdBy: d.createdBy,
    ...(d.createdInScope ? { createdInScope: d.createdInScope } : {}),
    ...(d.name ? { name: d.name } : {}),
    ...(d.displayName ? { displayName: d.displayName } : {}),
    currentVersion: d.currentVersion,
    ...(d.appliedVersion !== undefined ? { appliedVersion: d.appliedVersion } : {}),
    status: d.status,
    ...(d.lastAccessAt !== undefined ? { lastAccessAt: d.lastAccessAt } : {}),
    ...(versions[0] ? { createdAt: versions[0].createdAt } : {}),
    ...(versions.at(-1) ? { updatedAt: versions.at(-1)!.createdAt } : {}),
    versions,
  }
}

export interface DeploymentStore {
  deploy(input: DeployInput): Promise<DeploymentRecord>
  list(): Promise<DeploymentRecord[]>
  listForViewer(viewer: string): Promise<ViewerDeployment[]>
  getByIdOrName(idOrName: string): Promise<DeploymentRecord | null>
  canManage(id: string, principalId: string): Promise<boolean>
  rollback(id: string, version: number): Promise<void>
  redeploy(id: string, input: { entrypoint: string; files: unknown[] }): Promise<DeploymentRecord>
  archive(id: string): Promise<void>
  restore(id: string): Promise<DeploymentRecord>
  rename(id: string, name: string): Promise<DeploymentRecord>
  setDisplayName(id: string, displayName: string): Promise<DeploymentRecord>
  share(id: string, targetScope: string, permission: 'read' | 'write' | null, opts: { createdBy: string }): Promise<Array<{ scope: string; permission: 'read' | 'write' }>>
  logsFor(id: string, viewer: string, opts: { tailLines: number }): Promise<{ status: 'ok' | 'missing'; logs: string | null }>
  reach(id: string, viewer: string): Promise<{ status: 'ok' | 'missing' }>
}

export function createMemoryDeploymentStore(deps: { grants: GrantLedger }): DeploymentStore {
  const deployments = new Map<string, DeploymentRecord>()

  const find = (idOrName: string): DeploymentRecord | null =>
    deployments.get(idOrName) ?? [...deployments.values()].find((d) => d.name === idOrName) ?? null

  return {
    async deploy(input) {
      const now = Date.now()
      const record: DeploymentRecord = {
        id: randomUUID(),
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        ...(input.name ? { name: input.name } : {}),
        currentVersion: 1,
        status: 'live',
        versions: [{ version: 1, createdAt: now }],
      }
      deployments.set(record.id, record)
      return record
    },
    async list() {
      return [...deployments.values()].map((d) => ({ ...d }))
    },
    async listForViewer(viewer) {
      const viewerScope = `personal:${viewer}`
      const out: ViewerDeployment[] = []
      for (const d of deployments.values()) {
        const owner = d.ownerScopeId === viewerScope
        const granted = owner ? false : await deps.grants.hasGrant(d.ownerScopeId, viewerScope)
        if (!owner && !granted) continue
        out.push({ ...deploymentView(d), permission: owner ? 'write' : 'read' })
      }
      return out
    },
    async getByIdOrName(idOrName) {
      const d = find(idOrName)
      return d ? { ...d } : null
    },
    async canManage(id, principalId) {
      const d = deployments.get(id)
      if (!d) return false
      if (d.ownerScopeId === `personal:${principalId}`) return true
      return deps.grants.hasGrant(d.ownerScopeId, `personal:${principalId}`, 'write')
    },
    async rollback(id, version) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      if (!d.versions.some((v) => v.version === version)) throw new Error(`version ${version} does not exist`)
      d.currentVersion = version
      d.appliedVersion = version
    },
    async redeploy(id, _input) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      const next = d.currentVersion + 1
      d.versions.push({ version: next, createdAt: Date.now() })
      d.currentVersion = next
      d.appliedVersion = next
      d.status = 'live'
      return { ...d }
    },
    async archive(id) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      d.status = 'archived'
    },
    async restore(id) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      d.status = 'live'
      return { ...d }
    },
    async rename(id, name) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      d.name = name
      return { ...d }
    },
    async setDisplayName(id, displayName) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      d.displayName = displayName
      return { ...d }
    },
    async share(id, targetScope, permission, opts) {
      const d = deployments.get(id)
      if (!d) throw new Error(`no such app: ${id}`)
      if (d.ownerScopeId !== `personal:${opts.createdBy}` && permission !== null) {
        if (!(await deps.grants.hasGrant(d.ownerScopeId, `personal:${opts.createdBy}`, 'write'))) {
          throw new Error('only the owner can share this app')
        }
      }
      const grantees: Array<{ scope: string; permission: 'read' | 'write' }> = []
      if (permission === null) {
        for (const g of await deps.grants.grantsFor(d.ownerScopeId, `deployment:${d.id}`)) {
          await deps.grants.revokeGrant(d.ownerScopeId, g.ref, g.granteeScopeId, opts.createdBy)
        }
      } else {
        await deps.grants.grant({
          ownerScopeId: d.ownerScopeId,
          ref: `deployment:${d.id}`,
          granteeScopeId: targetScope,
          permission,
          grantedBy: opts.createdBy,
        })
        grantees.push({ scope: targetScope, permission })
      }
      return grantees
    },
    async logsFor(id, _viewer, _opts) {
      const d = deployments.get(id)
      if (!d) return { status: 'missing', logs: null }
      return { status: 'ok', logs: null }
    },
    async reach(id, viewer) {
      const d = await this.listForViewer(viewer)
      return d.some((v) => v.id === id) ? { status: 'ok' } : { status: 'missing' }
    },
  }
}
