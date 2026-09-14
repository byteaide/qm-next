/**
 * Lane-A grant ledger: qm Grant records (ownerScopeId/ref/granteeScopeId/
 * permission/grantedBy) in memory. Visibility checks across files,
 * deployments, and share ask this store; a Postgres swap lands behind the
 * same interface.
 */
export interface Grant {
  ownerScopeId: string
  ref: string
  granteeScopeId: string
  permission: 'read' | 'write'
  grantedBy: string
}

export interface GrantLedger {
  grant(record: Grant): Promise<void>
  revokeGrant(ownerScopeId: string, ref: string, granteeScopeId: string, revokedBy: string): Promise<void>
  list(): Promise<Array<Grant & { revoked: boolean }>>
  /** Active grants where the grantee scope matches and permission suffices. */
  hasGrant(ownerScopeId: string, granteeScopeId: string, permission?: 'read' | 'write'): Promise<boolean>
  grantsFor(ownerScopeId: string, ref: string): Promise<Array<Grant & { revoked: boolean }>>
}

export function createMemoryGrantLedger(): GrantLedger {
  const records: Array<Grant & { revoked: boolean }> = []
  return {
    async grant(record) {
      const existing = records.find(
        (r) => !r.revoked && r.ownerScopeId === record.ownerScopeId && r.ref === record.ref && r.granteeScopeId === record.granteeScopeId,
      )
      if (existing) {
        existing.permission = record.permission
        existing.grantedBy = record.grantedBy
        return
      }
      records.push({ ...record, revoked: false })
    },
    async revokeGrant(ownerScopeId, ref, granteeScopeId, _revokedBy) {
      const match = records.find((r) => !r.revoked && r.ownerScopeId === ownerScopeId && r.ref === ref && r.granteeScopeId === granteeScopeId)
      if (!match) throw new Error('no such grant')
      match.revoked = true
    },
    async list() {
      return records.map((r) => ({ ...r }))
    },
    async hasGrant(ownerScopeId, granteeScopeId, permission = 'read') {
      return records.some(
        (r) => !r.revoked && r.ownerScopeId === ownerScopeId && r.granteeScopeId === granteeScopeId && (permission === 'read' || r.permission === 'write'),
      )
    },
    async grantsFor(ownerScopeId, ref) {
      return records.filter((r) => !r.revoked && r.ownerScopeId === ownerScopeId && r.ref === ref).map((r) => ({ ...r }))
    },
  }
}
