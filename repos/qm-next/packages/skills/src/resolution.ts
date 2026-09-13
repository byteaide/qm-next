/**
 * Resolution seam for skills (14.0): appends the visible-skill index to
 * the system prompt so a registered skill appears in the harness input
 * context (m3-scope acceptance). Name → body lookup goes through
 * `SkillStore.resolve` at execution time; store failures are fail-open.
 */
import type { Conversation, Principal, ResolutionService, ScopeId } from '@qm/types'
import type { SkillResolution, SkillStore } from './contract.ts'

export function skillsIndex(resolved: SkillResolution[]): string {
  const items = resolved
    .filter((r) => r.skill)
    .sort((a, b) => {
      const [x, y] = [a.skill!.name, b.skill!.name]
      if (x < y) return -1
      if (x > y) return 1
      return 0
    })
  if (!items.length) return ''
  const lines = items.map((r) => {
    const skill = r.skill!
    const shadow = r.shadowed.length ? ' (shadows a broader-scope skill of the same name)' : ''
    return `- **${skill.name}** — ${skill.description}${shadow}`
  })
  return ['## Skills', 'You have these skills available. To use one, follow its body (run its steps with your tools):', ...lines].join('\n')
}

export function wrapResolutionWithSkills(
  inner: ResolutionService,
  store: SkillStore,
  select: (conversation: Conversation, actor: Principal, scope: ScopeId) => ScopeId[] | undefined,
): ResolutionService {
  return {
    scopeFor: (conversation, actor) => inner.scopeFor(conversation, actor),
    resolve: async (conversation, actor) => {
      const base = await inner.resolve(conversation, actor)
      const scopes = select(conversation, actor, base.orgScopeId)
      if (!scopes || !scopes.length) return base
      let resolved: SkillResolution[]
      try {
        resolved = await store.visibleFor(scopes)
      } catch {
        return base
      }
      const index = skillsIndex(resolved)
      if (!index) return base
      return { ...base, systemPrompt: `${base.systemPrompt}\n\n${index}` }
    },
  }
}
