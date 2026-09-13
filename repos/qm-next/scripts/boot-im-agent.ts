/**
 * Real-machine P1 agent boot (task 4.1/4.2).
 *
 * Boots `profiles/im-agent.yml` — api with the real pi engine as the default
 * harness (model registry + provider keys from the environment) + im-bridge
 * (ambient wiring) + cron/triggers runtime + Feishu WS provider. The Feishu
 * leg is the 4.2 对拍 surface: @机器人 with a real coding task and compare
 * against qm on the same task (result/latency/streaming).
 *
 * Run from `repos/qm-next/` via `aidevops secret run` so FEISHU_* and the
 * provider keys ride the process environment for the profile's `!!js`
 * interpolation. Stop with Ctrl-C (or SIGTERM); shutdown unmounts the
 * profile tree and closes the engine.
 */
import { bootProfile } from '../packages/boot/src/index.ts'
import { fileURLToPath } from 'node:url'

const ctx = await bootProfile(fileURLToPath(new URL('../profiles/im-agent.yml', import.meta.url)))

const api = ctx.api
const { port } = api.address
const health = await fetch(`http://127.0.0.1:${port}/healthz`)
console.log(`im-agent: booted, api 127.0.0.1:${port}, healthz ${health.status}`)
console.log(`im-agent: harnesses [${api.orchestrator.deps.harness.ids().join(', ')}], default pi`)
console.log('im-agent: @机器人 in the test chat with a real coding task; expect the reply in-thread')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`im-agent: ${signal} received, unmounting profile tree`)
  try {
    await ctx.loader.remove('include')
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
