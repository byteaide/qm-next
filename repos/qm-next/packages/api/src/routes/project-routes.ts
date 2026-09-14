/**
 * Parity project routes (11.0 tranche 5, contract "projects"): web workspaces
 * with qm's mutation status vocabulary mapped onto the same codes. Lane-A
 * cuts (deviation #44): the identity/internal checks and directory-backed
 * member validation assume every bearer principal is internal, members render
 * `displayName: principalId`, and slack-channel linking accepts any channel
 * id (the channel registry and channel-session collision check arrive with
 * the IM bridge) — the in-use guard compares other projects' links.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, notFound, sendJson } from './framework.ts'
import type { Project, ProjectMutation, ProjectStore } from '../services/project-store.ts'

export interface ProjectRoutesDeps {
  projects?: ProjectStore
}

export function projectView(project: Project): Record<string, unknown> {
  const memberIds = [...project.memberIds]
  const principals = [...new Set([project.ownerId, ...memberIds])]
  return {
    ...project,
    memberIds,
    scopeId: `group:web-project-${project.id}`,
    members: principals.map((principalId) => ({ principalId, displayName: principalId })),
  }
}

function mutationResponse(ctx: ApiRouteContext, result: ProjectMutation): void {
  if (result.status === 'ok') return sendJson(ctx, 200, { project: projectView(result.project) })
  if (result.status === 'not_found') return sendJson(ctx, 404, { error: 'not_found' })
  if (result.status === 'forbidden') return sendJson(ctx, 403, { error: 'forbidden' })
  if (result.status === 'invalid_name') return sendJson(ctx, 400, { error: 'invalid_name', message: 'project name required' })
  if (result.status === 'invalid_channel') {
    return sendJson(ctx, 400, {
      error: 'invalid_channel',
      message: 'channel not found among the channels you can see',
    })
  }
  if (result.status === 'channel_in_use') {
    return sendJson(ctx, 409, {
      error: 'channel_in_use',
      message: "that channel already has its own workspace — it can't also be a project's home channel",
    })
  }
  return sendJson(ctx, 400, {
    error: 'invalid_member',
    message: 'member must be an internal directory member and cannot be the project owner',
  })
}

function requestedPrincipal(body: Record<string, unknown>): string {
  return typeof body.principalId === 'string' ? body.principalId.trim() : ''
}

export function projectRoutes(deps: ProjectRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/projects',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        const principalId = (ctx.query.principalId ?? '').trim()
        if (!principalId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId required' })
        if (!deps.projects) return notFound(ctx)
        return sendJson(ctx, 200, { projects: deps.projects.listForMember(principalId).map(projectView) })
      },
    },
    {
      method: 'POST',
      path: '/v1/projects',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.projects) return notFound(ctx)
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = requestedPrincipal(body)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!principalId || !name) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and name required' })
        const project = deps.projects.create({ name, ownerId: principalId })
        return sendJson(ctx, 201, { project: projectView(project) })
      },
    },
    {
      method: 'PATCH',
      path: '/v1/projects/:id',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.projects) return notFound(ctx)
        const id = ctx.params.id
        if (!id) return sendJson(ctx, 404, { error: 'not_found' })
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = requestedPrincipal(body)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!principalId || !name) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and name required' })
        return mutationResponse(ctx, deps.projects.rename(id, principalId, name))
      },
    },
    {
      method: 'POST',
      path: '/v1/projects/:id/members',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.projects) return notFound(ctx)
        const id = ctx.params.id
        if (!id) return sendJson(ctx, 404, { error: 'not_found' })
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = requestedPrincipal(body)
        const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : ''
        if (!principalId || !memberId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and memberId required' })
        return mutationResponse(ctx, deps.projects.addMember(id, principalId, memberId))
      },
    },
    {
      method: 'DELETE',
      path: '/v1/projects/:id/members/:memberId',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.projects) return notFound(ctx)
        const id = ctx.params.id
        const memberId = ctx.params.memberId?.trim() ?? ''
        if (!id) return sendJson(ctx, 404, { error: 'not_found' })
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = requestedPrincipal(body)
        if (!principalId || !memberId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and memberId required' })
        return mutationResponse(ctx, deps.projects.removeMember(id, principalId, memberId))
      },
    },
    {
      method: 'PUT',
      path: '/v1/projects/:id/slack-channel',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.projects) return notFound(ctx)
        const id = ctx.params.id
        if (!id) return sendJson(ctx, 404, { error: 'not_found' })
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = requestedPrincipal(body)
        const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
        if (!principalId || !channel) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and channel required' })
        const wanted = channel.replace(/^#/, '')
        if (!wanted) return mutationResponse(ctx, { status: 'invalid_channel' })
        const clash = deps.projects.all().find((p) => p.id !== id && p.slackChannel?.channelId === wanted)
        if (clash) return mutationResponse(ctx, { status: 'channel_in_use' })
        return mutationResponse(ctx, deps.projects.setSlackChannel(id, principalId, { channelId: wanted, channelName: wanted }))
      },
    },
    {
      method: 'DELETE',
      path: '/v1/projects/:id/slack-channel',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.projects) return notFound(ctx)
        const id = ctx.params.id
        if (!id) return sendJson(ctx, 404, { error: 'not_found' })
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = requestedPrincipal(body)
        if (!principalId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId required' })
        return mutationResponse(ctx, deps.projects.setSlackChannel(id, principalId, null))
      },
    },
  ]
}
