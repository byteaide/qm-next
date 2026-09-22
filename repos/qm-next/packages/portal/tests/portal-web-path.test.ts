/**
 * Portal → web-ui real-path tests (P5 18.2): the surface-relay half of the
 * portal on the qm-next runtime. The SSO lane (local dev bypass + admin-login
 * links) reaches the SPA and the api parity lanes through the portal front —
 * webuiuser cookie + short-TTL x-portal-identity minted with the shared
 * secret — verified against web-ui's portalIdentitySecret, with the admin
 * gate probing the core whoami lane. Live HTTP over listening sockets, no
 * test doubles on the trust path.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { Context } from '@qm/cordis'
import { createMemoryReplayDedupe } from '@qm/auth'
import { createKeychain, deriveConnectorKey } from '@qm/credentials'
import { createMemoryDirectoryStore } from '@qm/directory'
import { createMemoryScopeMemory } from '@qm/memory'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemoryMap, createMemorySessionStore } from '@qm/store'
import { createInMemoryEventLog, createMemorySequenceAllocator } from '@qm/concurrency'
import { createMemoryCronStore } from '@qm/triggers'
import { createMemorySkillStore } from '@qm/skills'
import { createTurnRunner, createApiServer, createMemoryAdminService } from '@qm/api'
import {
  createMemoryBlobTransfer,
  createMemoryConnectorSurface,
  createMemoryDeploymentStore,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryRuntimeConfigStore,
  createMemoryUserModelCredentialsStore,
  createMemoryWebhookStore,
} from '@qm/api'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createApiRelay, createWebUiServer } from '@qm/web-ui'
import { createCoreAdminProbe, createImpersonateAudit, createPortalServer, seal, deriveKey } from '../src/index.ts'

const SCOPE: ScopeId = 'org:default'
const SECRET = 'dev-m1-secret-0000000000000000000000000000'
const PORTAL_SECRET = 'dev-portal-session-secret-0123456789abcdef'
const PUBLIC_URL = 'http://127.0.0.1:8095'
const BOSS = 'boss@example.com'

interface Rig {
  api: Awaited<ReturnType<typeof createApiServer>>
  web: Awaited<ReturnType<typeof createWebUiServer>>
  webPort: number
  runner: ReturnType<typeof createTurnRunner>
  runs: ReturnType<typeof createMemoryRunStore>
  adminStatusOf: (principalId: string) => Promise<boolean>
}

async function buildRig(): Promise<Rig> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const log = createInMemoryEventLog({ allocator: createMemorySequenceAllocator() })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'test soul prompt', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: registry,
    identity: {
      isInternal: (p) => p.type === 'internal',
      audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
    },
    resolution,
    rateLimiter: { check: async () => ({ allowed: true }) },
    runEventLog: log.bus,
  })
  const runner = createTurnRunner({ orchestrator, runs, runEventLog: log.bus }, { tickMs: 5 })
  runner.start()

  const grantLedger = createMemoryGrantLedger()
  const blobTransfer = createMemoryBlobTransfer()
  const api = createApiServer(
    {
      orchestrator,
      sessions,
      runs,
      resolution,
      surface: { sessions, orchestrator, scopeFor: () => SCOPE },
      files: { files: createMemoryFileStore({ blobTransfer, grants: grantLedger }), blobTransfer },
      grants: { grants: grantLedger, orgScope: SCOPE },
      blobs: { blobTransfer },
      webhooks: { webhooks: createMemoryWebhookStore() },
      connectors: createMemoryConnectorSurface(),
      userModelAuth: { credentials: createMemoryUserModelCredentialsStore() },
      keychain: {
        keychain: () =>
          createKeychain({
            creds: createMemoryMap(),
            grants: createMemoryMap(),
            asks: createMemoryMap(),
            key: deriveConnectorKey(SECRET),
            orgId: () => 'default',
          }),
        scopeFor: (actorId) => `personal:${actorId}`,
      },
      memory: { memory: createMemoryScopeMemory(), scopeFor: () => SCOPE },
      deployments: { deployments: createMemoryDeploymentStore({ grants: grantLedger }) },
      config: { config: createMemoryRuntimeConfigStore() },
      admin: { admin: createMemoryAdminService({ orgId: 'default', seedAdmins: [BOSS] }), orgScope: SCOPE },
    },
    { secrets: [SECRET] },
  )

  const web = createWebUiServer(
    {
      orchestrator,
      sessions,
      runs,
      resolution,
      runObservation: log.observation,
      skills: createMemorySkillStore(),
      crons: createMemoryCronStore(),
      directory: createMemoryDirectoryStore(),
      relay: createApiRelay(api, SECRET),
      auth: { portalIdentitySecret: PORTAL_SECRET },
    },
    { host: '127.0.0.1', port: 0, user: 'dev' },
  )

  await api.listen({ port: 0, host: '127.0.0.1' })
  await web.listen({ port: 0, host: '127.0.0.1' })
  const webAddr = web.server.address()
  const webPort = typeof webAddr === 'object' && webAddr ? webAddr.port : 0
  // The core slice PortalService sees on the cordis context (app + config).
  const coreApi = { app: api, config: { secrets: [SECRET] } }
  return { api, web, webPort, runner, runs, adminStatusOf: createCoreAdminProbe(coreApi) }
}

async function startPortal(
  rig: Rig,
  extra?: { impersonateAudit?: (action: 'start' | 'stop', adminId: string, target: string) => Promise<{ ok: boolean; status?: number; displayName?: string; message?: string }> },
): Promise<{ base: string; close: () => Promise<void> }> {
  const portal = createPortalServer(
    {
      orgId: 'dev',
      publicUrl: PUBLIC_URL,
      sessionSecret: PORTAL_SECRET,
      localAuthBypass: true,
      devPrincipal: 'dev@example.com',
      adminStatusOf: rig.adminStatusOf,
      replayDedupe: createMemoryReplayDedupe(),
      ...(extra?.impersonateAudit ? { impersonateAudit: extra.impersonateAudit } : {}),
    },
    { host: '127.0.0.1', port: 0, webUiOrigin: `http://127.0.0.1:${rig.webPort}` },
  )
  await portal.listen({ port: 0, host: '127.0.0.1' })
  const addr = portal.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, close: () => portal.close() }
}

function sessionCookieOf(response: Response): string {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('portal_session='))
  assert.ok(cookie, 'portal session cookie set')
  return cookie.split(';')[0] ?? ''
}

test('portal SSO local bypass → portal-mode identity → proxied turn + SSE + relay lanes', async () => {
  const rig = await buildRig()
  let portal: Awaited<ReturnType<typeof startPortal>> | undefined
  try {
    portal = await startPortal(rig)
    // The admin gate bounces anonymous /admin/ui to the sign-in flow. The
    // portal_local_logout cookie opts out of the loopback bypass lane so
    // the request is genuinely anonymous.
    const gated = await fetch(`${portal.base}/admin/ui/`, {
      headers: { accept: 'text/html', cookie: 'portal_local_logout=1' },
      redirect: 'manual',
    })
    assert.equal(gated.status, 302)
    assert.match(gated.headers.get('location') ?? '', /^\/auth\/login/)

    // Local dev bypass: /auth/login on loopback mints the portal session.
    const login = await fetch(`${portal.base}/auth/login?returnTo=/`, { redirect: 'manual' })
    assert.equal(login.status, 302)
    const cookie = sessionCookieOf(login)

    // The identity seam: web-ui resolves the x-portal-identity header
    // (portal mode), not the dev cookie lane.
    const me = await fetch(`${portal.base}/me`, { headers: { cookie } })
    assert.equal(me.status, 200)
    const who = (await me.json()) as { user?: string; mode?: string }
    assert.equal(who.user, 'dev@example.com')
    assert.equal(who.mode, 'portal')

    // A turn submitted through the portal front streams its observation
    // frames back through the proxy; the terminal frame closes the stream.
    const submitted = await fetch(`${portal.base}/api/turn`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello portal', threadRef: 'web:dev@example.com:default' }),
    })
    assert.equal(submitted.status, 202)
    const { runId } = (await submitted.json()) as { runId: string }
    assert.ok(runId)
    await rig.runs.waitFor(runId, 5_000)

    const events = await fetch(`${portal.base}/api/runs/${runId}/observation/subscribe?after=-1`, { headers: { cookie } })
    assert.equal(events.status, 200)
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/)
    const body = await events.text()
    assert.match(body, /event: run_observation/)
    assert.match(body, /"kind":"run\.finished"/)
    assert.match(body, /"outcome":"succeeded"/)

    // Relay lanes carry the acting principal through the signed bearer.
    const crons = await fetch(`${portal.base}/api/crons`, { headers: { cookie } })
    assert.equal(crons.status, 200)
  } finally {
    await portal?.close()
    await rig.web.close()
    await rig.api.close()
    await rig.runner.stop()
  }
})

test('admin-login link: single-use token → boss session admitted through the core admin probe', async () => {
  const rig = await buildRig()
  let portal: Awaited<ReturnType<typeof startPortal>> | undefined
  try {
    portal = await startPortal(rig)
    // Mint an operator link exactly as the qm CLI would: five-minute
    // single-use claims sealed under the portal.admin-login.v1 key.
    const now = Math.floor(Date.now() / 1000)
    const jti = randomBytes(18).toString('base64url')
    const token = seal(
      { k: 'admin-login', sub: BOSS, aud: PUBLIC_URL, iat: now, exp: now + 240, jti },
      deriveKey(PORTAL_SECRET, 'portal.admin-login.v1'),
    )

    // GET renders the confirmation page; POST consumes the token.
    const page = await fetch(`${portal.base}/auth/admin-login`, { headers: { accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Sign in as an administrator/)

    const confirm = await fetch(`${portal.base}/auth/admin-login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: PUBLIC_URL,
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    })
    assert.equal(confirm.status, 303)
    assert.equal(confirm.headers.get('location'), '/admin/ui/')
    const cookie = sessionCookieOf(confirm)

    // The boss session rides the proxy; the admin gate probes the core
    // whoami lane and admits /admin/ui (web-ui answers 404 without a built
    // dist — the point is the portal gate passed instead of bouncing).
    const me = await fetch(`${portal.base}/me`, { headers: { cookie } })
    assert.equal(me.status, 200)
    assert.equal(((await me.json()) as { user?: string }).user, BOSS)

    const adminUi = await fetch(`${portal.base}/admin/ui/`, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' })
    assert.equal(adminUi.status, 404)

    // Single use: the replay dedupe rejects the same jti.
    const replay = await fetch(`${portal.base}/auth/admin-login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: PUBLIC_URL,
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    })
    assert.equal(replay.status, 400)
  } finally {
    await portal?.close()
    await rig.web.close()
    await rig.api.close()
    await rig.runner.stop()
  }
})

const TARGET = 'intern@example.com'

async function bossSession(portal: { base: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jti = randomBytes(18).toString('base64url')
  const token = seal(
    { k: 'admin-login', sub: BOSS, aud: PUBLIC_URL, iat: now, exp: now + 240, jti },
    deriveKey(PORTAL_SECRET, 'portal.admin-login.v1'),
  )
  const confirm = await fetch(`${portal.base}/auth/admin-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: PUBLIC_URL,
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  })
  assert.equal(confirm.status, 303)
  return sessionCookieOf(confirm)
}

test('portal impersonation: gates, sealed cookie, proxied principal swap, stop (X2)', async () => {
  const rig = await buildRig()
  let portal: Awaited<ReturnType<typeof startPortal>> | undefined
  try {
    portal = await startPortal(rig, {
      impersonateAudit: createImpersonateAudit({ app: rig.api, config: {} }),
    })
    const sameOrigin = { origin: PUBLIC_URL, 'sec-fetch-site': 'same-origin' }

    // Anonymous: no session, no seal (the local-logout cookie opts out of
    // the loopback bypass lane so the request is genuinely anonymous).
    const anonymous = await fetch(`${portal.base}/auth/impersonate?target=${encodeURIComponent(TARGET)}`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie: 'portal_local_logout=1' },
      redirect: 'manual',
    })
    assert.equal(anonymous.status, 401)

    // Sign in as the boss through the admin-login lane.
    const cookie = await bossSession(portal)

    // Missing target and self-target are refused; no cookie is sealed.
    const missing = await fetch(`${portal.base}/auth/impersonate`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie },
      redirect: 'manual',
    })
    assert.equal(missing.status, 400)
    const self = await fetch(`${portal.base}/auth/impersonate?target=${encodeURIComponent(BOSS)}`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie },
      redirect: 'manual',
    })
    assert.equal(self.status, 400)

    // Cross-origin posts are refused before anything else.
    const crossOrigin = await fetch(`${portal.base}/auth/impersonate?target=${encodeURIComponent(TARGET)}`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      redirect: 'manual',
    })
    assert.equal(crossOrigin.status, 403)

    // A non-admin session is refused.
    const devLogin = await fetch(`${portal.base}/auth/login?returnTo=/`, { redirect: 'manual' })
    assert.equal(devLogin.status, 302)
    const devCookie = sessionCookieOf(devLogin)
    const nonAdmin = await fetch(`${portal.base}/auth/impersonate?target=${encodeURIComponent(TARGET)}`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie: devCookie },
      redirect: 'manual',
    })
    assert.equal(nonAdmin.status, 403)

    // The admin seal: the start assumption is audited through the core
    // admin lane and the cookie comes back sealed.
    const start = await fetch(`${portal.base}/auth/impersonate?target=${encodeURIComponent(TARGET)}`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie },
      redirect: 'manual',
    })
    assert.equal(start.status, 200)
    const startBody = (await start.json()) as { ok?: boolean; target?: string }
    assert.equal(startBody.ok, true)
    assert.equal(startBody.target, TARGET)
    const impCookie = start.headers
      .getSetCookie()
      .find((c) => c.startsWith('portal_impersonate='))
    assert.ok(impCookie, 'the impersonation cookie is sealed')

    // The proxy acts as the target while the boss identity rides `imp`.
    const swapped = await fetch(`${portal.base}/me`, { headers: { cookie: `${cookie}; ${impCookie!.split(';')[0] ?? ''}` } })
    assert.equal(swapped.status, 200)
    const who = (await swapped.json()) as { user?: string; impersonatedBy?: string | null }
    assert.equal(who.user, TARGET)
    assert.equal(who.impersonatedBy, BOSS)

    // The session cookie alone never impersonates.
    const unswapped = await fetch(`${portal.base}/me`, { headers: { cookie } })
    assert.equal(((await unswapped.json()) as { user?: string; impersonatedBy?: string | null }).user, BOSS)

    // Stop clears the cookie and audits the stop against the same lane.
    const stop = await fetch(`${portal.base}/auth/impersonate/stop`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie: `${cookie}; ${impCookie!.split(';')[0] ?? ''}` },
      redirect: 'manual',
    })
    assert.equal(stop.status, 200)
    assert.ok(stop.headers.getSetCookie().some((c) => c.startsWith('portal_impersonate=')), 'the cookie is cleared')

    const afterStop = await fetch(`${portal.base}/me`, { headers: { cookie } })
    const after = (await afterStop.json()) as { user?: string; impersonatedBy?: string | null }
    assert.equal(after.user, BOSS)
    assert.equal(after.impersonatedBy, null)
  } finally {
    await portal?.close()
    await rig.web.close()
    await rig.api.close()
    await rig.runner.stop()
  }
})
