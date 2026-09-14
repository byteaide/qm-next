/**
 * Project store (11.0 tranche 5, lane A) — the qm `projects/project-store`
 * mutation surface (owner-gated rename/members/slack-channel with qm's exact
 * status vocabulary) over an in-memory map. Channel-member derivation and
 * directory-backed member validation arrive with the IM bridge (13.0).
 */

export interface Project {
  id: string
  orgId: string
  name: string
  ownerId: string
  memberIds: string[]
  slackChannel?: { channelId: string; channelName: string }
  createdAt: number
  updatedAt: number
}

export type ProjectMutation =
  | { status: 'ok'; project: Project; changed: boolean }
  | { status: 'not_found' | 'forbidden' | 'invalid_member' | 'invalid_name' | 'invalid_channel' | 'channel_in_use' }

export interface ProjectStore {
  create(input: { name: string; ownerId: string }): Project
  get(id: string): Project | undefined
  all(): Project[]
  listForMember(principalId: string): Project[]
  rename(id: string, ownerId: string, name: string): ProjectMutation
  addMember(id: string, ownerId: string, memberId: string): ProjectMutation
  removeMember(id: string, ownerId: string, memberId: string): ProjectMutation
  setSlackChannel(id: string, ownerId: string, link: { channelId: string; channelName: string } | null): ProjectMutation
}

export function cleanProjectName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 200)
}

export function createMemoryProjectStore(opts: { now?: () => number; id?: () => string; orgId?: string } = {}): ProjectStore {
  const now = opts.now ?? Date.now
  const nextId = opts.id ?? (() => crypto.randomUUID())
  const orgId = opts.orgId ?? 'default'
  const projects = new Map<string, Project>()
  const sameOrg = (project: Project) => project.orgId === orgId

  function mutate(id: string, ownerId: string, fn: (project: Project) => { project: Project; changed: boolean } | null): ProjectMutation {
    const existing = projects.get(id)
    if (!existing || !sameOrg(existing)) return { status: 'not_found' }
    if (existing.ownerId !== ownerId) return { status: 'forbidden' }
    const result = fn(existing)
    if (!result) return { status: 'ok', project: { ...existing }, changed: false }
    const updated = { ...result.project, updatedAt: now() }
    projects.set(id, updated)
    return { status: 'ok', project: { ...updated }, changed: result.changed }
  }

  return {
    create({ name, ownerId }) {
      const project: Project = {
        id: nextId(),
        orgId,
        name: cleanProjectName(name),
        ownerId,
        memberIds: [],
        createdAt: now(),
        updatedAt: now(),
      }
      projects.set(project.id, project)
      return { ...project }
    },
    get(id) {
      const project = projects.get(id)
      return project && sameOrg(project) ? { ...project } : undefined
    },
    all() {
      return [...projects.values()].filter(sameOrg).map((p) => ({ ...p }))
    },
    listForMember(principalId) {
      return [...projects.values()]
        .filter((p) => sameOrg(p) && (p.ownerId === principalId || p.memberIds.includes(principalId)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((p) => ({ ...p }))
    },
    rename(id, ownerId, name) {
      const clean = cleanProjectName(name)
      if (!clean) return { status: 'invalid_name' }
      return mutate(id, ownerId, (project) => {
        if (project.name === clean) return null
        return { project: { ...project, name: clean }, changed: true }
      })
    },
    addMember(id, ownerId, memberId) {
      if (!memberId) return { status: 'invalid_member' }
      const existing = projects.get(id)
      if (existing && sameOrg(existing) && memberId === existing.ownerId) return { status: 'invalid_member' }
      return mutate(id, ownerId, (project) => {
        if (project.memberIds.includes(memberId)) return null
        return { project: { ...project, memberIds: [...project.memberIds, memberId] }, changed: true }
      })
    },
    removeMember(id, ownerId, memberId) {
      if (!memberId) return { status: 'invalid_member' }
      return mutate(id, ownerId, (project) => {
        if (!project.memberIds.includes(memberId)) return null
        return { project: { ...project, memberIds: project.memberIds.filter((m) => m !== memberId) }, changed: true }
      })
    },
    setSlackChannel(id, ownerId, link) {
      return mutate(id, ownerId, (project) => {
        if (link === null) {
          if (!project.slackChannel) return null
          const { slackChannel: _dropped, ...rest } = project
          return { project: rest, changed: true }
        }
        if (project.slackChannel?.channelId === link.channelId) return null
        return { project: { ...project, slackChannel: { ...link } }, changed: true }
      })
    },
  }
}
