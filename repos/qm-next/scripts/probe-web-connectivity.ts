/**
 * Web + portal connectivity probe (P5 18.2): boots profiles/cordis.yml
 * (api + im-bridge + triggers + web-ui + portal), waits for the portal
 * front, then drives the full chain over real HTTP — SPA through the
 * portal, SSO local bypass, portal-mode /me, and the SSE run lane —
 * printing one PASS/FAIL line per probe. Exits 0 only when all pass.
 */
import { bootProfile } from '../packages/boot/src/index.ts'
import { fileURLToPath } from 'node:url'

const ctx = await bootProfile(fileURLToPath(new URL('../profiles/cordis.yml', import.meta.url)))
const { host, port } = ctx['web-ui'].address
// The portal package augments no context types (no compile-time dep on it
// from the boot side beyond the loader); read the service structurally.
const portal = (ctx as unknown as { portal?: { address: { host: string; port: number } } }).portal
if (!portal) throw new Error('portal service missing from the profile')
const portalBase = `http://${portal.address.host}:${portal.address.port}`
console.log(`probe: web-ui http://${host}:${port}, portal ${portalBase}`)

let failures = 0
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// 1. SPA index through the portal front (anonymous proxied GET).
const index = await fetch(`${portalBase}/`, { headers: { accept: 'text/html' } })
const html = await index.text()
check('spa-through-portal', index.status === 200 && html.includes('<!doctype html'), `status ${index.status}, ${html.length} bytes`)

// 2. Static asset through the portal (hashed bundle).
const assetPath = html.match(/src="\/assets\/[^"]+\.js"/)?.[0]?.slice('src="'.length, -1) ?? ''
if (assetPath) {
  const asset = await fetch(`${portalBase}${assetPath}`)
  check('asset-through-portal', asset.status === 200, `${assetPath} status ${asset.status}`)
} else {
  check('asset-through-portal', false, 'no bundle path in index.html')
}

// 3. SSO local bypass: /auth/login mints the portal session.
const login = await fetch(`${portalBase}/auth/login?returnTo=/`, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('portal_session='))?.split(';')[0] ?? ''
check('sso-local-bypass', login.status === 302 && cookie.length > 0, `status ${login.status}`)

// 4. Portal-mode identity: /me resolves the x-portal-identity header.
const me = await fetch(`${portalBase}/me`, { headers: { cookie } })
const who = (await me.json().catch(() => ({}))) as { user?: string; mode?: string }
check('portal-mode-me', me.status === 200 && who.mode === 'portal', `status ${me.status}, user ${who.user}, mode ${who.mode}`)

// 5. SSE lane through the portal: a turn reaches done and its events stream.
const turn = await fetch(`${portalBase}/api/turn`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'probe hello', threadRef: `web:${who.user}:default` }),
})
const { runId } = (await turn.json().catch(() => ({}))) as { runId?: string }
check('turn-through-portal', turn.status === 202 && Boolean(runId), `status ${turn.status}`)
if (runId) {
  await ctx.api.runs.waitFor(runId, 10_000)
  const events = await fetch(`${portalBase}/api/runs/${runId}/events`, { headers: { cookie } })
  const body = await events.text()
  check('sse-through-portal', events.status === 200 && body.includes('event: done'), `status ${events.status}, ${body.length} bytes`)
}

// 6. Admin gate bounces logged-out /admin/ui.
const gated = await fetch(`${portalBase}/admin/ui/`, {
  headers: { accept: 'text/html', cookie: 'portal_local_logout=1' },
  redirect: 'manual',
})
check('admin-gate', gated.status === 302 && (gated.headers.get('location') ?? '').startsWith('/auth/login'), `status ${gated.status}`)

console.log(failures === 0 ? 'probe: all green' : `probe: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
