/**
 * Cutover-rehearsal worker entry (p002 P5 21.3): one OS process booted by
 * scripts/rehearsal-cutover.ts to prove the split deployment shape — api +
 * turn runner sharing `databaseUrl` with the parent instances, no sticky
 * routing, cross-process lease takeover.
 *
 * Environment:
 *   QM_CUTOVER_PG_URL         postgres connection string (required)
 *   QM_CUTOVER_INSTANCE_ID    instance registry id / run-claim worker id
 *   QM_CUTOVER_BUILD_SHA      build generation (same sha coexists, newer drains older)
 *   QM_CUTOVER_STALL_MS       optional: delay every handleTurn before delegating
 *                             (holds a claimed run so the rehearsal can SIGKILL mid-turn)
 *   QM_CUTOVER_TICK_MS / QM_CUTOVER_LEASE_TTL_MS / QM_CUTOVER_DRAIN_SWEEP_MS /
 *   QM_CUTOVER_DRAIN_LIVENESS_MS  runner + drain cadence knobs
 *
 * Prints `cutover-worker ready <instanceId> <port>` on stdout once the API
 * surface listens; SIGTERM/SIGINT disposes the service tree cleanly.
 */
import { ApiService, Context, Service } from '@qm/api'

const databaseUrl = process.env.QM_CUTOVER_PG_URL
const instanceId = process.env.QM_CUTOVER_INSTANCE_ID
if (!databaseUrl || !instanceId) {
  console.error('cutover-worker: QM_CUTOVER_PG_URL and QM_CUTOVER_INSTANCE_ID are required')
  process.exit(1)
}

const stallMs = process.env.QM_CUTOVER_STALL_MS ? Number(process.env.QM_CUTOVER_STALL_MS) : undefined
const tickMs = process.env.QM_CUTOVER_TICK_MS ? Number(process.env.QM_CUTOVER_TICK_MS) : undefined
const leaseTtlMs = process.env.QM_CUTOVER_LEASE_TTL_MS ? Number(process.env.QM_CUTOVER_LEASE_TTL_MS) : undefined
const drainSweepMs = process.env.QM_CUTOVER_DRAIN_SWEEP_MS ? Number(process.env.QM_CUTOVER_DRAIN_SWEEP_MS) : undefined
const drainLivenessMs = process.env.QM_CUTOVER_DRAIN_LIVENESS_MS
  ? Number(process.env.QM_CUTOVER_DRAIN_LIVENESS_MS)
  : undefined
const reapIntervalMs = process.env.QM_CUTOVER_REAP_MS ? Number(process.env.QM_CUTOVER_REAP_MS) : undefined

const svc = new ApiService(new Context(), {
  port: 0,
  secrets: [`cutover-worker-secret-${instanceId}`],
  databaseUrl,
  instanceId,
  ...(process.env.QM_CUTOVER_BUILD_SHA ? { buildSha: process.env.QM_CUTOVER_BUILD_SHA } : {}),
  ...(tickMs !== undefined ? { tickMs } : {}),
  ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
  ...(drainSweepMs !== undefined ? { drainSweepMs } : {}),
  ...(drainLivenessMs !== undefined ? { drainLivenessMs } : {}),
  ...(reapIntervalMs !== undefined ? { reapIntervalMs } : {}),
})

const dispose = (await svc[Service.init]()) ?? undefined

if (stallMs !== undefined) {
  const orchestrator = svc.orchestrator as unknown as {
    handleTurn: (input: unknown) => Promise<unknown>
  }
  const inner = orchestrator.handleTurn.bind(orchestrator)
  orchestrator.handleTurn = async (input: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, stallMs))
    return inner(input)
  }
  console.log(`cutover-worker: ${instanceId} stalling every turn for ${stallMs}ms`)
}

const { port } = svc.address
console.log(`cutover-worker ready ${instanceId} ${port}`)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`cutover-worker: ${signal} received, disposing ${instanceId}`)
  try {
    await dispose?.()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
