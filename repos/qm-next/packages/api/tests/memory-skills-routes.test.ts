/**
 * Memory + skills route tests (11.0 tranche 4): the personal memory face
 * (head/replace/conflict/history/restore), the agent memory face (self,
 * search, facts, org-scope 403, recipient-in-body 400), the skill registry
 * (register/collision/list with shadowing/detail visibility/update/delete/
 * restore), and the unwired-store 404 gates.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createApiServer, mintSignedPayload, type ApiDeps, type ApiServerOptions } from '../src/index.ts'
import { createMemoryScopeMemory } from '@qm/memory'
import { createMemorySkillStore } from '@qm/skills'

const SECRET = 'memory-skills-secret'
const SCOPE: ScopeId = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

async function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function resolution(): ResolutionService {
  return {
    resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
}

function baseDeps(): ApiDeps {
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const res = resolution()
  return {
    orchestrator: new OrchestratorService(new Context(), {
      sessions: createMemorySessionStore(),
      runs: createMemoryRunStore(),
      harness: registry,
      identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
      resolution: res,
      rateLimiter: { check: async () => ({ allowed: true }) },
    }),
    sessions: createMemorySessionStore(),
    runs: createMemoryRunStore(),
    resolution: res,
  }
}

test('memory self face: put/get head, revision conflict 409, history and restore round-trip', async () => {
  const deps = { ...baseDeps(), memory: { memory: createMemoryScopeMemory(), scopeFor: () => SCOPE } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const put = await app.inject({ method: 'PUT', url: '/v1/memory', headers: ada, payload: { principalId: 'person:ada', content: 'first draft' } })
  assert.equal(put.statusCode, 200)
  const rev = put.json().revision
  assert.ok(rev)
  assert.equal(put.json().content.trimEnd(), 'first draft')

  const get = await app.inject({ method: 'GET', url: '/v1/memory?principalId=person:ada', headers: ada })
  assert.equal(get.statusCode, 200)
  assert.equal(get.json().content.trimEnd(), 'first draft')

  const conflict = await app.inject({
    method: 'PUT',
    url: '/v1/memory',
    headers: ada,
    payload: { principalId: 'person:ada', content: 'raced write', revision: '999' },
  })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().error, 'conflict')

  const ok = await app.inject({
    method: 'PUT',
    url: '/v1/memory',
    headers: ada,
    payload: { principalId: 'person:ada', content: 'second draft', revision: rev },
  })
  assert.equal(ok.statusCode, 200)

  const history = await app.inject({ method: 'GET', url: '/v1/memory/history', headers: ada })
  assert.equal(history.statusCode, 200)
  assert.ok(history.json().revisions.length >= 2)
  const firstDraft = history.json().revisions.find((r: { content: string }) => r.content.trimEnd() === 'first draft')
  assert.ok(firstDraft, 'history keeps the first revision')

  const restore = await app.inject({
    method: 'POST',
    url: '/v1/memory/restore',
    headers: ada,
    payload: { revision: firstDraft.revision, expectedRevision: ok.json().revision },
  })
  assert.equal(restore.statusCode, 200)
  assert.equal(restore.json().content.trimEnd(), 'first draft')

  const mismatch = await app.inject({ method: 'GET', url: '/v1/memory/history?principalId=person:grace', headers: ada })
  assert.equal(mismatch.statusCode, 404)
  const badScope = await app.inject({ method: 'GET', url: '/v1/memory/history?scope=team', headers: ada })
  assert.equal(badScope.statusCode, 400)
  await app.close()
})

test('memory agent face: self get/put, facts count, search results, org 403, recipient 400', async () => {
  const deps = { ...baseDeps(), memory: { memory: createMemoryScopeMemory(), scopeFor: () => SCOPE } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const facts = await app.inject({ method: 'POST', url: '/v1/memory/facts', headers: ada, payload: { facts: ['deploys the staging server', 'prefers bun'] } })
  assert.equal(facts.statusCode, 200)
  assert.equal(facts.json().added, 2)
  assert.equal(facts.json().scopeId, 'personal:person:ada')

  const tooMany = await app.inject({ method: 'POST', url: '/v1/memory/facts', headers: ada, payload: { facts: Array.from({ length: 21 }, (_, i) => 'f' + i) } })
  assert.equal(tooMany.statusCode, 400)
  const empty = await app.inject({ method: 'POST', url: '/v1/memory/facts', headers: ada, payload: { facts: [] } })
  assert.equal(empty.statusCode, 400)

  const search = await app.inject({ method: 'POST', url: '/v1/memory/search', headers: ada, payload: { query: 'staging' } })
  assert.equal(search.statusCode, 200)
  assert.equal(search.json().results.length, 1)
  assert.match(search.json().results[0].fact, /deploys the staging server/)

  const self = await app.inject({ method: 'GET', url: '/v1/memory/self', headers: ada })
  assert.equal(self.statusCode, 200)
  assert.equal(self.json().scopeId, 'personal:person:ada')
  assert.match(self.json().content, /deploys the staging server/)

  const putSelf = await app.inject({ method: 'PUT', url: '/v1/memory/self', headers: ada, payload: { content: 'curated' } })
  assert.equal(putSelf.statusCode, 200)
  assert.equal(putSelf.json().scopeId, 'personal:person:ada')

  const org = await app.inject({ method: 'POST', url: '/v1/memory/facts', headers: ada, payload: { facts: ['x'], scope: 'org' } })
  assert.equal(org.statusCode, 403)
  const orgGet = await app.inject({ method: 'GET', url: '/v1/memory/self?scope=org', headers: ada })
  assert.equal(orgGet.statusCode, 403)

  const relay = await app.inject({ method: 'POST', url: '/v1/memory/facts', headers: ada, payload: { facts: ['x'], recipient: 'person:grace' } })
  assert.equal(relay.statusCode, 400)
  assert.equal(relay.json().message, 'memory can only be changed from its own conversation')
  await app.close()
})

test('skills: register, collision 409, shadowing in list, detail 404 for strangers, update/delete/restore', async () => {
  const deps = { ...baseDeps(), skills: { skills: createMemorySkillStore(), scopeFor: () => SCOPE } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))
  const grace = auth(await token('person:grace'))

  const create = await app.inject({
    method: 'POST',
    url: '/v1/skills',
    headers: ada,
    payload: { name: 'deploy-notes', description: 'how to deploy', body: 'steps...' },
  })
  assert.equal(create.statusCode, 201)
  const id = create.json().skill.id
  assert.equal(create.json().skill.source, 'native')
  assert.equal(create.json().skill.scope, 'personal')
  assert.equal(create.json().skill.editable, true)

  const dupe = await app.inject({
    method: 'POST',
    url: '/v1/skills',
    headers: ada,
    payload: { name: 'deploy-notes', description: 'again', body: 'x' },
  })
  assert.equal(dupe.statusCode, 409)
  assert.equal(dupe.json().error, 'exists')

  const badName = await app.inject({ method: 'POST', url: '/v1/skills', headers: ada, payload: { name: '../escape', description: 'x', body: 'y' } })
  assert.equal(badName.statusCode, 400)

  const list = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:ada', headers: ada })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().skills.length, 1)
  assert.equal(list.json().skills[0].shadowed, false)

  const detail = await app.inject({ method: 'GET', url: '/v1/skills/' + id, headers: ada })
  assert.equal(detail.statusCode, 200)
  assert.equal(detail.json().skill.body, 'steps...')
  const strangerDetail = await app.inject({ method: 'GET', url: '/v1/skills/' + id, headers: grace })
  assert.equal(strangerDetail.statusCode, 404)

  const update = await app.inject({ method: 'PUT', url: '/v1/skills/' + id, headers: ada, payload: { description: 'v2', body: 'steps v2' } })
  assert.equal(update.statusCode, 200)
  assert.equal(update.json().skill.description, 'v2')
  assert.equal(update.json().skill.version, 2)
  const strangerUpdate = await app.inject({ method: 'PUT', url: '/v1/skills/' + id, headers: grace, payload: { body: 'hack' } })
  assert.equal(strangerUpdate.statusCode, 403)

  const del = await app.inject({ method: 'DELETE', url: '/v1/skills/' + id, headers: ada })
  assert.equal(del.statusCode, 200)
  // Soft delete: the archived skill stays listed for its manager.
  const gone = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:ada', headers: ada })
  assert.equal(gone.json().skills.length, 1)
  assert.equal(gone.json().skills[0].status, 'archived')
  const strangerList = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:grace', headers: grace })
  assert.equal(strangerList.json().skills.length, 0)

  const restore = await app.inject({ method: 'POST', url: '/v1/skills/' + id + '/restore', headers: ada })
  assert.equal(restore.statusCode, 200)
  const back = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:ada', headers: ada })
  assert.equal(back.json().skills.length, 1)
  assert.equal(back.json().skills[0].status, 'published')

  const missing = await app.inject({ method: 'DELETE', url: '/v1/skills/skill-unknown', headers: ada })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error, 'missing')
  await app.close()
})

test('skills shadowing: same-name org skill lists shadowed behind the personal winner', async () => {
  const skills = createMemorySkillStore()
  const deps = { ...baseDeps(), skills: { skills, scopeFor: () => SCOPE } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  await skills.register({ scopeId: SCOPE, name: 'deploy', description: 'org deploy', body: 'org body', createdBy: 'person:ada' })
  const create = await app.inject({ method: 'POST', url: '/v1/skills', headers: ada, payload: { name: 'deploy', description: 'personal deploy', body: 'personal body' } })
  assert.equal(create.statusCode, 201)

  const list = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:ada', headers: ada })
  const rows = list.json().skills
  // qm shows one row per name: the winner, flagged shadowed when shadowed.
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scopeId, 'personal:person:ada')
  assert.equal(rows[0].shadowed, true)

  const withShadowed = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:ada&includeShadowed=1', headers: ada })
  const expanded = withShadowed.json().skills
  assert.equal(expanded.length, 2)
  assert.equal(expanded[0].scopeId, 'personal:person:ada')
  assert.equal(expanded[1].scopeId, SCOPE)
  await app.close()
})

test('unwired memory/skills stores: routes answer 404 like qm without the service', async () => {
  const app = createApiServer(baseDeps(), OPTS)
  const ada = auth(await token('person:ada'))
  const mem = await app.inject({ method: 'GET', url: '/v1/memory?principalId=person:ada', headers: ada })
  assert.equal(mem.statusCode, 404)
  const agent = await app.inject({ method: 'POST', url: '/v1/memory/search', headers: ada, payload: { query: 'x' } })
  assert.equal(agent.statusCode, 404)
  const skills = await app.inject({ method: 'GET', url: '/v1/skills?principalId=person:ada', headers: ada })
  assert.equal(skills.statusCode, 404)
  await app.close()
})
