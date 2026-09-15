/**
 * Lighthouse accessibility probe (P5 18.2): boots profiles/cordis.yml and
 * audits the SPA through the portal front with headless Chrome. Prints the
 * a11y score (0-100) and fails below 95. Run after
 * `pnpm --filter @qm/web-ui build`; requires Chrome.
 */
import { spawn } from 'node:child_process'
import { bootProfile } from '../packages/boot/src/index.ts'
import { fileURLToPath } from 'node:url'

const ctx = await bootProfile(fileURLToPath(new URL('../profiles/cordis.yml', import.meta.url)))
const portal = (ctx as unknown as { portal?: { address: { host: string; port: number } } }).portal
if (!portal) throw new Error('portal service missing from the profile')
const url = `http://${portal.address.host}:${portal.address.port}/`
console.log(`lighthouse: auditing ${url}`)

const started = spawn('npx', [
  '--yes',
  'lighthouse',
  url,
  '--only-categories=accessibility',
  '--output=json',
  '--chrome-flags=--headless=new',
  '--quiet',
])
let stdout = ''
let stderr = ''
started.stdout.on('data', (chunk) => {
  stdout += String(chunk)
})
started.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})
const code = await new Promise<number | null>((resolve) => started.on('close', resolve))
if (code !== 0) {
  console.error(stderr.slice(-2000))
  throw new Error(`lighthouse exited ${code}`)
}
const report = JSON.parse(stdout) as { categories: { accessibility: { score: number | null } }; audits: Record<string, { score: number | null }> }
const score = (report.categories.accessibility.score ?? 0) * 100
const failed = Object.entries(report.audits)
  .filter(([, a]) => a.score !== null && a.score < 1)
  .map(([id]) => id)
for (const id of failed) console.log(`lighthouse: failed audit ${id}`)
console.log(`lighthouse: a11y score ${score}`)
process.exit(score >= 95 ? 0 : 1)
