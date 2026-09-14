/**
 * Route-facing admin service: the @qm/admin control plane (qm
 * admin-service.ts grant ladder, person-key matching, resolveActor) plus
 * the slack-installation record lane. Grants persist through the injected
 * AdminGrantStore (memory in tests, Postgres in production); the slack
 * record rides a DurableMap.
 */
import {
  AdminError,
  adminStatusFromGrants,
  createAdminService,
  createMemoryAdminGrantPersistence,
  createAdminGrantStore,
  type AdminGrant,
  type AdminGrantStore,
  type AdminRole,
  type AdminService as ControlPlaneAdminService,
  type AdminStatus,
} from '@qm/admin'
import { createMemoryMap, createPostgresMap, type DurableMap, type PgPool } from '@qm/store'

export { AdminError, adminStatusFromGrants }
export type { AdminGrant, AdminRole, AdminStatus }

export interface SlackInstallationRecord {
  botToken: string
  teamId: string
  teamName?: string
  installedBy: string
  createdAt: number
}

export interface AdminService extends ControlPlaneAdminService {
  getSlackInstallation(): SlackInstallationRecord | null
  putSlackInstallation(rec: Omit<SlackInstallationRecord, 'createdAt'>): SlackInstallationRecord
  deleteSlackInstallation(): boolean
}

export interface CreateAdminServiceOptions {
  orgId: string
  seedAdmins?: string[]
  /** Prebuilt grant store (Postgres in production); memory persistence otherwise. */
  grants?: AdminGrantStore
  /** DurableMap for the slack-installation record (Postgres map in production). */
  slackMap?: DurableMap<SlackInstallationRecord>
}

export function createMemoryAdminService(opts: CreateAdminServiceOptions): AdminService {
  const orgScope = `org:${opts.orgId}`
  const controlPlane: ControlPlaneAdminService = opts.grants
    ? createAdminService(opts.grants, { orgId: opts.orgId })
    : createAdminService(
        createAdminGrantStore(createMemoryAdminGrantPersistence(), {
          seed: (opts.seedAdmins ?? []).map((principalId) => ({
            principalId,
            scopeId: orgScope,
            role: 'org_admin' as const,
          })),
        }),
        { orgId: opts.orgId },
      )
  const slackMap: DurableMap<SlackInstallationRecord> = opts.slackMap ?? createMemoryMap<SlackInstallationRecord>()
  let slackCache: SlackInstallationRecord | null = null

  return {
    resolveActor: (header) => controlPlane.resolveActor(header),
    canAdminister: (actorId, target) => controlPlane.canAdminister(actorId, target),
    adminStatusOf: (actorId) => controlPlane.adminStatusOf(actorId),
    listGrants: () => controlPlane.listGrants(),
    createGrant: (actorId, input) => controlPlane.createGrant(actorId, input),
    revokeGrant: (actorId, principalId, scope, role) => controlPlane.revokeGrant(actorId, principalId, scope, role),
    getSlackInstallation() {
      return slackCache ? { ...slackCache } : null
    },
    putSlackInstallation(rec) {
      slackCache = { ...rec, createdAt: Date.now() }
      void slackMap.put('installation', slackCache)
      return { ...slackCache }
    },
    deleteSlackInstallation() {
      const existed = slackCache !== null
      slackCache = null
      void slackMap.delete('installation')
      return existed
    },
  }
}

export function createPostgresSlackMap(pg: PgPool): DurableMap<SlackInstallationRecord> {
  return createPostgresMap<SlackInstallationRecord>(pg, 'admin_slack_installation')
}
