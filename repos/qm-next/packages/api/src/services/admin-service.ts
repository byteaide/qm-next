/**
 * Lane-A admin service: org-admin grants with qm's AdminError vocabulary
 * and guard semantics (only org admins grant/revoke; the last org admin is
 * irrevocable), plus the slack-installation store. Grants seed from config;
 * a Postgres swap lands behind the same interface.
 */
export type AdminRole = 'org_admin'

export interface AdminGrant {
  principalId: string
  scopeId: string
  role: AdminRole
  grantedBy?: string
  createdAt?: number
}

export interface AdminStatus {
  isAdmin: boolean
  role?: AdminRole
  scopeId?: string
}

export class AdminError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AdminError'
    this.status = status
  }
}

export function adminStatusFromGrants(grants: readonly AdminGrant[], principalId: string): AdminStatus {
  for (const g of grants) {
    if (g.principalId !== principalId) continue
    if (g.role === 'org_admin') return { isAdmin: true, role: 'org_admin', scopeId: g.scopeId }
  }
  return { isAdmin: false }
}

export interface SlackInstallationRecord {
  botToken: string
  teamId: string
  teamName?: string
  installedBy: string
  createdAt: number
}

export interface AdminService {
  adminStatusOf(principalId: string): Promise<AdminStatus>
  listGrants(): Promise<AdminGrant[]>
  createGrant(
    actorId: string,
    input: { principalId: string; role: AdminRole; scopeId: string },
  ): Promise<AdminGrant>
  revokeGrant(actorId: string, principalId: string, scope: string, role: AdminRole): Promise<void>
  getSlackInstallation(): SlackInstallationRecord | null
  putSlackInstallation(rec: Omit<SlackInstallationRecord, 'createdAt'>): SlackInstallationRecord
  deleteSlackInstallation(): boolean
}

export function createMemoryAdminService(opts: { orgId: string; seedAdmins?: string[] }): AdminService {
  const orgScope = `org:${opts.orgId}`
  const grants: AdminGrant[] = (opts.seedAdmins ?? []).map((principalId) => ({
    principalId,
    scopeId: orgScope,
    role: 'org_admin' as const,
  }))
  let slackInstallation: SlackInstallationRecord | null = null

  return {
    async adminStatusOf(principalId) {
      return adminStatusFromGrants(grants, principalId)
    },
    async listGrants() {
      return grants.map((g) => ({ ...g }))
    },
    async createGrant(actorId, input) {
      if (adminStatusFromGrants(grants, actorId).role !== 'org_admin') {
        throw new AdminError(403, 'only an org admin may grant admin roles')
      }
      const principalId = input.principalId?.trim()
      if (!principalId) throw new AdminError(400, 'principalId required')
      if (input.role !== 'org_admin') throw new AdminError(400, 'role must be org_admin')
      if (input.scopeId !== orgScope) throw new AdminError(400, `org_admin scope must be ${orgScope}`)
      const grant: AdminGrant = { principalId, scopeId: input.scopeId, role: input.role, grantedBy: actorId, createdAt: Date.now() }
      grants.push(grant)
      return grant
    },
    async revokeGrant(actorId, principalId, scope, role) {
      if (adminStatusFromGrants(grants, actorId).role !== 'org_admin') {
        throw new AdminError(403, 'only an org admin may revoke admin roles')
      }
      const matched = grants.filter((g) => g.principalId === principalId && g.scopeId === scope && g.role === role)
      if (role === 'org_admin') {
        const distinctOrgAdmins = new Set(grants.filter((g) => g.role === 'org_admin').map((g) => g.principalId))
        if (matched.length > 0 && distinctOrgAdmins.size <= 1) {
          throw new AdminError(400, 'cannot revoke the last org admin')
        }
      }
      for (const g of matched) {
        const index = grants.indexOf(g)
        if (index >= 0) grants.splice(index, 1)
      }
    },
    getSlackInstallation() {
      return slackInstallation ? { ...slackInstallation } : null
    },
    putSlackInstallation(rec) {
      slackInstallation = { ...rec, createdAt: Date.now() }
      return { ...slackInstallation }
    },
    deleteSlackInstallation() {
      const existed = slackInstallation !== null
      slackInstallation = null
      return existed
    },
  }
}
