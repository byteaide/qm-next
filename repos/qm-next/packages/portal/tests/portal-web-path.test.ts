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
import { createMemoryRunEventBus, createMemoryRunStore, createMemoryMap, createMemorySessionStore } from '@qm/store'
import { createMemoryCronStore } from '@qm/triggers'
import { createMemorySkillStore } from '@qm/skills'
import { createTurnRunner, createApiServer, createMemoryAdminService } from '@qm/api'
import {
  createMemoryBlobTransfer,
  createMemoryConnectorTokenStore,
  createMemoryDeploymentStore,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryRuntimeConfigStore,
  createMemoryUserModelCredentialsStore,
  createMemoryWebhookStore,
} from '@qm/api'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createApiRelay, createWebUiServer } from '@qm/web-ui'
import { createCoreAdminProbe, createPortalServer, seal, deriveKey } from '../src/index.ts'

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
  const runEvents = createMemoryRunEventBus()
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'You are qm-next.', orgScopeId: SCOPE }),
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
    runEvents,
  })
  const runner = createTurnRunner({ orchestrator, runs }, { tickMs: 5 })
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
      connectors: { tokens: createMemoryConnectorTokenStore() },
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
      runEvents,
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

async function startPortal(rig: Rig): Promise<{ base: string; close: () => Promise<void> }> {
  const portal = createPortalServer(
    {
      orgId: 'dev',
      publicUrl: PUBLIC_URL,
      sessionSecret: PORTAL_SECRET,
      localAuthBypass: true,
      devPrincipal: 'dev@example.com',
      adminStatusOf: rig.adminStatusOf,
      replayDedupe: createMemoryReplayDedupe(),
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

    // A turn submitted through the portal front runs and its SSE replay
    // streams back through the proxy.
    const submitted = await fetch(`${portal.base}/api/turn`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello portal', threadRef: 'web:dev@example.com:default' }),
    })
    assert.equal(submitted.status, 202)
    const { runId } = (await submitted.json()) as { runId: string }
    assert.ok(runId)
    await rig.runs.waitFor(runId, 5_000)

    const events = await fetch(`${portal.base}/api/runs/${runId}/events`, { headers: { cookie } })
    assert.equal(events.status, 200)
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/)
    const body = await events.text()
    assert.match(body, /event: done/)
    assert.match(body, /echo: hello portal/)

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
