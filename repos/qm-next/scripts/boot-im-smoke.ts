/**
 * Real-machine IM smoke boot (task 10.0).
 *
 * Boots `profiles/im-smoke.yml` (api + im-bridge + feishu provider), then
 * swaps the echo-only mock harness for a scripted one: the first turn
 * replies normally (10.1 @bot → thread reply) and the second pauses on
 * approval so the delivered card can be clicked (10.2 approve/reject →
 * approval turn → delivery).
 *
 * Run from `repos/qm-next/` via `aidevops secret run` so FEISHU_* ride the
 * process environment for the profile's `!!js` interpolation. Stop with
 * Ctrl-C (or SIGTERM); shutdown unmounts the profile tree and drains the
 * provider.
 */
import { bootProfile } from '../packages/boot/src/index.ts'
import { createMockHarness } from '../packages/orchestrator/src/index.ts'
import { fileURLToPath } from 'node:url'

const ctx = await bootProfile(fileURLToPath(new URL('../profiles/im-smoke.yml', import.meta.url)))

const api = ctx.api
api.orchestrator.deps.harness.register(
  createMockHarness({
    script: [
      { reply: 'smoke 10.1 echo: thread reply is live' },
      {
        reply: '',
        pausedOnApproval: true,
        pendingApprovals: [{ command: 'smoke-approve', reason: '10.2 real-machine approval smoke' }],
      },
    ],
  }),
)

const { port } = api.address
const health = await fetch(`http://127.0.0.1:${port}/healthz`)
console.log(`im-smoke: booted, api 127.0.0.1:${port}, healthz ${health.status}`)
console.log('im-smoke: 10.1 — @机器人 in the test chat; expect the scripted echo reply in-thread')
console.log('im-smoke: 10.2 — send another @机器人 message; expect the approval card, then click Approve/Reject')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`im-smoke: ${signal} received, unmounting profile tree`)
  try {
    await ctx.loader.remove('include')
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
