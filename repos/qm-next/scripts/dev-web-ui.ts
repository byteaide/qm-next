/**
 * Web chat surface dev boot (16.0).
 *
 * Boots `profiles/cordis.yml` (demo + api + im-bridge + web-ui) and prints
 * the loopback address the SPA is served from. The mock harness echoes;
 * the skills/crons/contexts views run against dev-local memory stores.
 *
 * Build the SPA first: `pnpm --filter @qm/web-ui build`.
 * Run from `repos/qm-next/`; stop with Ctrl-C (or SIGTERM).
 */
import { bootProfile } from '../packages/boot/src/index.ts'
import { fileURLToPath } from 'node:url'

const ctx = await bootProfile(fileURLToPath(new URL('../profiles/cordis.yml', import.meta.url)))

const { host, port } = ctx['web-ui'].address
console.log(`web-ui: booted, surface http://${host}:${port} (dev sign-in: any principal)`)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`web-ui: ${signal} received, unmounting profile tree`)
  try {
    await ctx.loader.remove('include')
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
