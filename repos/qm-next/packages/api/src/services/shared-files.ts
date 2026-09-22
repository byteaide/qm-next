/**
 * Shared-file handles (Q3, segment ⑫): derive qm GrantedHandles from the
 * lane-A grant ledger + file store. A grant to `personal:<viewer>` on an
 * owner scope makes the referenced file readable through `shared/<name>`;
 * the viewer's own files never count as "shared with them". The same
 * handles feed the composer manifest and the ToolContext read ladder, so
 * the prompt never promises a file the tool cannot fetch.
 */
import type { GrantedHandle, Principal } from '@qm/types'
import type { GrantLedger } from './grant-ledger.ts'
import type { FileStoreService } from './file-store.ts'

export interface SharedFilesDeps {
  grants: GrantLedger
  files: FileStoreService
}

/** Audiences default to every grantee the ledger names. */
async function viewersOf(deps: SharedFilesDeps, audience: readonly Principal[]): Promise<string[]> {
  if (audience.length > 0) return audience.map((p) => p.id)
  const active = (await deps.grants.list()).filter((g) => !g.revoked)
  const viewers = new Set<string>()
  for (const g of active) {
    if (g.granteeScopeId.startsWith('personal:')) viewers.add(g.granteeScopeId.slice('personal:'.length))
  }
  return [...viewers]
}

export async function sharedFileHandles(deps: SharedFilesDeps, audience: readonly Principal[] = []): Promise<GrantedHandle[]> {
  const active = (await deps.grants.list()).filter((g) => !g.revoked && g.ref.trim() !== '')
  if (active.length === 0) return []
  const viewers = await viewersOf(deps, audience)
  const handles = new Map<string, GrantedHandle>()
  for (const viewer of viewers) {
    for (const g of active) {
      if (g.granteeScopeId !== `personal:${viewer}`) continue
      const file = await deps.files.openForViewer(g.ref, viewer).catch(() => null)
      if (!file) continue
      if (file.principalId === viewer) continue
      handles.set(`${g.ownerScopeId}\0${g.ref}`, {
        handlePath: `shared/${file.name}`,
        ownerScopeId: g.ownerScopeId,
        ownerPath: g.ref,
        permission: g.permission,
      })
    }
  }
  return [...handles.values()]
}
