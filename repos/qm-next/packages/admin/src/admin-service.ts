/**
 * Admin service (qm `src/admin/admin-service.ts`): org-admin grants with the
 * qm guard semantics — only org admins grant/revoke, the last org admin is
 * irrevocable, `resolveActor` parses the `id@org` admin-actor header qm's
 * console sends. The org id is injected (qm reads a global config) and
 * actors are plain principal-id strings (the bearer framework resolves them;
 * qm's Principal-typed surface collapses to `.id`).
 */
import { parseScopeId, type Principal } from '@qm/types'
import { samePerson, personKey } from './person-key.ts'
import {
  createAdminGrantStore,
  createMemoryAdminGrantPersistence,
  type AdminGrant,
  type AdminGrantStore,
  type AdminRole,
} from './admin-grant-store.ts'

export type { AdminGrant, AdminRole } from './admin-grant-store.ts'

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
    if (!samePerson(g.principalId, principalId)) continue
    if (g.role === 'org_admin') return { isAdmin: true, role: 'org_admin', scopeId: g.scopeId }
  }
  return { isAdmin: false }
}

export interface AdminService {
  resolveActor(header: string | undefined): Principal | null
  canAdminister(actorId: string, target: string): Promise<boolean>
  adminStatusOf(actorId: string): Promise<AdminStatus>
  listGrants(): Promise<AdminGrant[]>
  createGrant(actorId: string, input: { principalId: string; role: AdminRole; scopeId: string }): Promise<AdminGrant>
  revokeGrant(actorId: string, principalId: string, scope: string, role: AdminRole): Promise<void>
}

export function parseAdminGrants(raw: string | undefined, orgId: string): AdminGrant[] | undefined {
  if (raw === undefined) return undefined
  const grants: AdminGrant[] = []
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const separator = entry.lastIndexOf(':')
    const principalId = entry.slice(0, separator).trim()
    const role = entry.slice(separator + 1).trim()
    if (!principalId || role !== 'org_admin') continue
    grants.push({ principalId, scopeId: `org:${orgId}`, role })
  }
  return grants
}

function defaultAdminGrants(orgId: string): AdminGrant[] {
  return [
    { principalId: 'admin-alice', scopeId: `org:${orgId}`, role: 'org_admin' },
    { principalId: 'admin-bob', scopeId: `org:${orgId}`, role: 'org_admin' },
  ]
}

export function bootAdminGrantSeed(rawAdminGrants: string | undefined, orgId: string, durable: boolean): AdminGrant[] {
  return parseAdminGrants(rawAdminGrants, orgId) ?? (durable ? [] : defaultAdminGrants(orgId))
}

export interface AdminServiceOptions {
  orgId: string
  now?: () => number
}

export function createAdminService(store: AdminGrantStore | undefined, opts: AdminServiceOptions): AdminService {
  const orgId = opts.orgId
  const grants: AdminGrantStore =
    store ?? createAdminGrantStore(createMemoryAdminGrantPersistence(), { seed: defaultAdminGrants(orgId) })
  const now = opts.now ?? (() => Date.now())

  async function isOrgAdmin(actorId: string): Promise<boolean> {
    return adminStatusFromGrants(await grants.list(), actorId).role === 'org_admin'
  }

  return {
    resolveActor(header) {
      if (!header) return null
      const at = header.lastIndexOf('@')
      if (at <= 0 || at === header.length - 1) return null
      const id = header.slice(0, at)
      const org = header.slice(at + 1)
      if (org !== orgId) return null
      return { id, type: 'internal' }
    },
    async canAdminister(actorId) {
      return isOrgAdmin(actorId)
    },
    async adminStatusOf(actorId) {
      return adminStatusFromGrants(await grants.list(), actorId)
    },
    listGrants() {
      return grants.list()
    },
    async createGrant(actorId, input) {
      if (!(await isOrgAdmin(actorId))) throw new AdminError(403, 'only an org admin may grant admin roles')
      const principalId = input.principalId?.trim()
      if (!principalId) throw new AdminError(400, 'principalId required')
      const { role } = input
      if (role !== 'org_admin') {
        throw new AdminError(400, 'role must be org_admin')
      }
      const parsed = parseScopeId(input.scopeId)
      if (parsed.kind !== 'org' || parsed.ref !== orgId) {
        throw new AdminError(400, `org_admin scope must be org:${orgId}`)
      }
      const grant: AdminGrant = { principalId, scopeId: input.scopeId, role, grantedBy: actorId, createdAt: now() }
      await grants.add(grant)
      return grant
    },
    async revokeGrant(actorId, principalId, scope, role) {
      const list = await grants.list()
      if (adminStatusFromGrants(list, actorId).role !== 'org_admin') {
        throw new AdminError(403, 'only an org admin may revoke admin roles')
      }
      const matched = list.filter(
        (g) => samePerson(g.principalId, principalId) && g.scopeId === scope && g.role === role,
      )
      if (role === 'org_admin') {
        const distinctOrgAdmins = new Set(
          list.filter((g) => g.role === 'org_admin').map((g) => personKey(g.principalId)),
        )
        if (matched.length > 0 && distinctOrgAdmins.size <= 1) {
          throw new AdminError(400, 'cannot revoke the last org admin')
        }
      }
      for (const g of matched) await grants.revoke(g.principalId, scope, role)
    },
  }
}
