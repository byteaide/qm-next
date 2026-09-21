/**
 * Lane-A deployment store: app deployments with versions, archive state,
 * viewer visibility (owner scope or grant), and the manage/share surface
 * the deployment routes use. With the optional `provider` / `materializer`
 * deps the store drives a live deploy runtime (cluster 1 MVP); without
 * them it answers the qm unreachable/no-logs shapes (parity-deviations.md
 * #45b lane-A fallback).
 */
import { randomUUID } from 'node:crypto'
import type { DeployFile, DeployMaterializer, DeployProvider } from '@qm/types'
import type { GrantLedger } from './grant-ledger.ts'

export type DeploymentStatus = 'live' | 'archived'

export interface DeploymentVersion {
  version: number
  createdAt: number
  commit?: string
  parentCommit?: string
  env?: Record<string, string>
  /** Entrypoint shell command captured at deploy time; reused by `apply`/`rollback`. */
  entrypoint?: string
  /** Snapshot files captured at deploy time (preserved across materializations). */
  files?: DeployFile[]
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
  /** Endpoint reported by the live provider; absent in lane-A fallback. */
  endpoint?: { host: string; port: number }
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
  files: DeployFile[]
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

export interface DeploymentStoreDeps {
  grants: GrantLedger
  provider?: DeployProvider
  materializer?: DeployMaterializer
  /** Logger; used to surface runtime hook failures without crashing the store. */
  logger?: { warn(msg: string, extra?: unknown): void; error?(msg: string, extra?: unknown): void }
}

export interface DeploymentStore {
  deploy(input: DeployInput): Promise<DeploymentRecord>
  list(): Promise<DeploymentRecord[]>
  listForViewer(viewer: string): Promise<ViewerDeployment[]>
  getByIdOrName(idOrName: string): Promise<DeploymentRecord | null>
  canManage(id: string, principalId: string): Promise<boolean>
  rollback(id: string, version: number): Promise<void>
  redeploy(id: string, input: { entrypoint: string; files: DeployFile[] }): Promise<DeploymentRecord>
  archive(id: string): Promise<void>
  restore(id: string): Promise<DeploymentRecord>
  rename(id: string, name: string): Promise<DeploymentRecord>
  setDisplayName(id: string, displayName: string): Promise<DeploymentRecord>
  share(id: string, targetScope: string, permission: 'read' | 'write' | null, opts: { createdBy: string }): Promise<Array<{ scope: string; permission: 'read' | 'write' }>>
  logsFor(id: string, viewer: string, opts: { tailLines: number }): Promise<{ status: 'ok' | 'missing'; logs: string | null }>
  reach(id: string, viewer: string): Promise<{ status: 'ok' | 'missing' }>
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createMemoryDeploymentStore(deps: DeploymentStoreDeps): DeploymentStore {
  const deployments = new Map<string, DeploymentRecord>()
  const runtime = deps.provider && deps.materializer
    ? { provider: deps.provider, materializer: deps.materializer }
    : undefined

  const find = (idOrName: string): DeploymentRecord | null =>
    deployments.get(idOrName) ?? [...deployments.values()].find((d) => d.name === idOrName) ?? null

  const applyRuntime = async (
    record: DeploymentRecord,
    versionNumber: number,
    entrypoint: string,
    files: DeployFile[],
  ): Promise<void> => {
    if (!runtime) return
    const workspaceDir = await runtime.materializer.materialize({
      deploymentId: record.id,
      version: versionNumber,
      entrypoint,
      files,
    })
    const endpoint = await runtime.provider.apply({
      deploymentId: record.id,
      version: versionNumber,
      workspaceDir,
      entrypoint,
      env: {},
    })
    record.endpoint = endpoint
  }

  const destroyRuntime = async (record: DeploymentRecord): Promise<void> => {
    if (!runtime) return
    try {
      await runtime.provider.destroy(record.id)
    } catch (error) {
      deps.logger?.warn?.(`deployment-store: provider.destroy ${record.id} failed: ${errMessage(error)}`, { error })
    }
    delete record.endpoint
  }

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
        versions: [{ version: 1, createdAt: now, entrypoint: input.entrypoint, files: input.files, env: {} }],
      }
      deployments.set(record.id, record)
      if (runtime) {
        try {
          await applyRuntime(record, 1, input.entrypoint, input.files)
          record.appliedVersion = 1
        } catch (error) {
          deps.logger?.warn?.(`deployment-store: deploy ${record.id} runtime hook failed: ${errMessage(error)}`, { error })
        }
      }
      return { ...record }
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
      const target = d.versions.find((v) => v.version === version)
      if (!target) throw new Error(`version ${version} does not exist`)
      d.currentVersion = version
      if (runtime) {
        try {
          await applyRuntime(d, version, target.entrypoint ?? '', target.files ?? [])
          d.appliedVersion = version
        } catch (error) {
          deps.logger?.warn?.(`deployment-store: rollback ${id} → ${version} failed: ${errMessage(error)}`, { error })
        }
      }
    },
    async redeploy(id, input) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      const next = d.currentVersion + 1
      d.versions.push({ version: next, createdAt: Date.now(), entrypoint: input.entrypoint, files: input.files, env: {} })
      d.currentVersion = next
      d.status = 'live'
      if (runtime) {
        try {
          await applyRuntime(d, next, input.entrypoint, input.files)
          d.appliedVersion = next
        } catch (error) {
          deps.logger?.warn?.(`deployment-store: redeploy ${id} runtime hook failed: ${errMessage(error)}`, { error })
        }
      }
      return { ...d }
    },
    async archive(id) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      d.status = 'archived'
      await destroyRuntime(d)
    },
    async restore(id) {
      const d = deployments.get(id)
      if (!d) throw new Error('no such app')
      const target = d.versions.find((v) => v.version === d.currentVersion) ?? d.versions[d.versions.length - 1]
      d.status = 'live'
      if (runtime && target) {
        try {
          await applyRuntime(d, target.version, target.entrypoint ?? '', target.files ?? [])
          d.appliedVersion = target.version
        } catch (error) {
          deps.logger?.warn?.(`deployment-store: restore ${id} runtime hook failed: ${errMessage(error)}`, { error })
        }
      }
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
    async logsFor(id, _viewer, opts) {
      const d = deployments.get(id)
      if (!d) return { status: 'missing', logs: null }
      if (!runtime) return { status: 'ok', logs: null }
      try {
        const logs = await runtime.provider.logs(id, { tailLines: opts.tailLines })
        return { status: 'ok', logs }
      } catch (error) {
        deps.logger?.warn?.(`deployment-store: logsFor ${id} runtime hook failed: ${errMessage(error)}`, { error })
        return { status: 'ok', logs: null }
      }
    },
    async reach(id, viewer) {
      const d = await this.listForViewer(viewer)
      return d.some((v) => v.id === id) ? { status: 'ok' } : { status: 'missing' }
    },
  }
}
