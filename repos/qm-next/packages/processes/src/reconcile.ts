/**
 * Reconcile the registry against the sandbox's live process list (qm
 * `src/processes/reconcile.ts`): records marked `running` whose backing
 * process has exited are flipped to `exited` so the registry reflects
 * reality after a restart or scope swap.
 */
import type { ProcessSandbox, ProcessSession, SandboxHandle } from '@qm/types'
import type { ProcessRegistry } from './process-registry.ts'

export async function reconcileProcesses(
  sandbox: ProcessSandbox,
  handle: SandboxHandle,
  registry: ProcessRegistry,
  scopeId: string,
): Promise<void> {
  const records = await registry.listByScope(scopeId)
  const running = records.filter((r) => r.status === 'running')
  if (!running.length) return

  const live = await sandbox.listProcesses(handle)
  const byId = new Map<unknown, ProcessSession>(live.map((s) => [s.processId, s]))
  for (const rec of running) {
    const backend = byId.get(rec.processId)
    if (!backend || backend.status.state === 'exited') {
      await registry.markStatus(rec.processId, 'exited')
    }
  }
}