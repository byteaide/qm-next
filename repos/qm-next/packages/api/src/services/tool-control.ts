/**
 * ToolContext control-plane surfaces (T-cluster wiring): binds the cron
 * control service, the webhook store, the MCP tool service and the grant
 * ledger into the narrow ports the orchestrator's ToolContext consumes.
 * Every surface answers honestly when its backing store is missing or the
 * turn has no actor identity — CONTROL_UNAVAILABLE for cron ops, error
 * results for webhooks/shares, and the plain-tool throw for MCP calls —
 * so harness tools never render a false success.
 */
import type { CronControlSurface, McpControlSurface, PlaygroundControlSurface, ShareControlSurface, WebhookControlSurface } from '@qm/orchestrator'
import { normalizePlaygroundTitle, PLAYGROUND_MIMETYPE, validatePlaygroundHtml } from '@qm/orchestrator'
import { CONTROL_UNAVAILABLE, type ShareArtifactRequest, type ShareArtifactResult, type Webhook } from '@qm/types'
import { createCronControl, type CronControlDeps } from './cron-control.ts'
import { WEBHOOK_SCHEMES, redactWebhook, type CreateWebhookInput, type Webhook as WebhookRecord, type WebhookStore } from './webhook-store.ts'
import type { GrantLedger } from './grant-ledger.ts'
import type { FileStoreService } from './file-store.ts'

export interface McpToolServiceLike {
  toolDefs(): ReturnType<NonNullable<McpControlSurface['mcpToolDefs']>>
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>
}

export interface ToolControlDeps {
  /** Turn actor principal id; ownership fields derive from it. */
  actorId?: string
  /** Lazy cron control deps — undefined while the triggers runtime is not loaded. */
  cron?: () => CronControlDeps | undefined
  /** Lazy webhook store — undefined when the webhook surface is off. */
  webhooks?: () => WebhookStore | undefined
  /** Public base for webhook inbound URLs (path-only when absent). */
  webhookPublicUrl?: string
  /** Lazy MCP tool service — undefined when the MCP registry is off. */
  mcp?: () => McpToolServiceLike | undefined
  orgScope: string
  grants?: () => GrantLedger | undefined
  files?: () => FileStoreService | undefined
}

function inboundUrl(publicBase: string | undefined, id: string): string {
  const path = `/v1/webhooks/incoming/${id}`
  return publicBase ? `${publicBase.replace(/\/$/, '')}${path}` : path
}

/** The @qm/types webhook view; the store record's free-form destination maps through unchanged. */
function webhookView(w: WebhookRecord): Webhook {
  return redactWebhook(w) as unknown as Webhook
}

function webhookControl(deps: ToolControlDeps): WebhookControlSurface {
  const withStore = async <T>(fn: (store: WebhookStore) => Promise<T>, fallback: T): Promise<T> => {
    const store = deps.webhooks?.()
    if (!store || !deps.actorId) return fallback
    return fn(store)
  }
  return {
    async webhookCreate(req) {
      return withStore(
        async (store) => {
          if (!(WEBHOOK_SCHEMES as readonly string[]).includes(req.verification.scheme)) {
            return {
              ok: false as const,
              code: 'bad_request' as const,
              message: `verification.scheme must be one of: ${(WEBHOOK_SCHEMES as readonly string[]).join(', ')}`,
            }
          }
          try {
            const input: CreateWebhookInput = {
              ownerScopeId: `personal:${deps.actorId}`,
              owner: deps.actorId!,
              createdBy: deps.actorId!,
              action: req.action,
              verification: req.verification as WebhookRecord['verification'],
            }
            if (req.filters) input.filters = req.filters as NonNullable<WebhookRecord['filters']>
            const webhook = await store.create(input)
            return {
              ok: true as const,
              webhook: webhook as unknown as Webhook,
              url: inboundUrl(deps.webhookPublicUrl, webhook.id),
              ...(webhook.verification.secret ? { secret: webhook.verification.secret } : {}),
            }
          } catch (err) {
            return { ok: false as const, code: 'webhook_create_failed' as const, message: err instanceof Error ? err.message : String(err) }
          }
        },
        { ok: false as const, code: 'webhook_create_failed' as const, message: 'the webhook surface is not available on this deployment' },
      )
    },
    async webhookList() {
      const store = deps.webhooks?.()
      if (!store || !deps.actorId) return []
      const all = await store.list()
      return all.filter((w) => w.owner === deps.actorId).map(webhookView)
    },
    async webhookDisable(id) {
      return withStore(
        async (store) => {
          const webhook = await store.get(id)
          if (!webhook) return { ok: false as const, code: 'not_found' as const, message: `no webhook ${id}` }
          if (webhook.owner !== deps.actorId) return { ok: false as const, code: 'forbidden' as const, message: 'not your webhook' }
          await store.setEnabled(id, false)
          return { ok: true as const, value: {} }
        },
        { ok: false as const, code: 'not_found' as const, message: 'the webhook surface is not available on this deployment' },
      )
    },
  }
}

function cronControl(deps: ToolControlDeps): CronControlSurface {
  const withCron = async <T>(fn: (control: ReturnType<typeof createCronControl>) => Promise<T>): Promise<T> => {
    const cronDeps = deps.cron?.()
    if (!cronDeps || !deps.actorId) return CONTROL_UNAVAILABLE as T
    return fn(createCronControl(cronDeps))
  }
  const actor = (): string => deps.actorId!
  return {
    cronCreate: (req) => withCron((c) => c.cronCreate(req, actor())),
    cronList: () => withCron((c) => c.cronList(actor())),
    cronGet: (id) => withCron((c) => c.cronGet(id, actor())),
    cronRuns: (id, req) => withCron((c) => c.cronRuns(id, req, actor())),
    cronPatch: (id, req) => withCron((c) => c.cronPatch(id, req, actor())),
    cronDelete: (id) => withCron((c) => c.cronDelete(id, actor())),
    cronSetEnabled: (id, enabled) => withCron((c) => c.cronSetEnabled(id, enabled, actor())),
    cronRun: (id) => withCron((c) => c.cronRun(id)),
    cronRetarget: (id, destinationKey) => withCron((c) => c.cronRetarget(id, destinationKey, actor())),
  }
}

function mcpControl(deps: ToolControlDeps): McpControlSurface {
  return {
    mcpToolDefs: () => deps.mcp?.()?.toolDefs() ?? [],
    async callMcpTool(name, args) {
      const service = deps.mcp?.()
      if (!service) throw new Error('MCP tools is not available on this deployment')
      return service.call(name, args, deps.actorId)
    },
  }
}

function shareControl(deps: ToolControlDeps): ShareControlSurface {
  return {
    async shareArtifact(req: ShareArtifactRequest): Promise<ShareArtifactResult> {
      const grants = deps.grants?.()
      if (!grants || !deps.actorId) {
        return { ok: false, code: 'forbidden', message: 'artifact sharing is not available on this deployment' }
      }
      if (req.recipient !== undefined) {
        return { ok: false, code: 'recipient_not_found', message: `no one matches "${req.recipient}"` }
      }
      const scope = req.scope === 'org' || req.scope === undefined ? deps.orgScope : req.scope
      const permission = req.permission === 'write' ? 'write' : 'read'
      if (req.type !== 'file') {
        return { ok: false, code: 'not_found', message: `${req.type} sharing needs the ${req.type} store wiring (converges at 13.0)` }
      }
      const files = deps.files?.()
      if (!files) return { ok: false, code: 'not_found', message: 'no file store wired' }
      const file = await files.openForViewer(req.id, deps.actorId)
      if (!file) return { ok: false, code: 'not_found', message: 'file not found in a scope you can see' }
      const ownerScopeId = file.ownerScopeId
      if (ownerScopeId !== `personal:${deps.actorId}` && file.principalId !== deps.actorId) {
        return { ok: false, code: 'forbidden', message: 'only the file owner can share it' }
      }
      try {
        await grants.grant({ ownerScopeId, ref: req.id, granteeScopeId: scope, permission, grantedBy: deps.actorId })
      } catch (err) {
        return { ok: false, code: 'share_failed', message: err instanceof Error ? err.message : String(err) }
      }
      return {
        ok: true,
        verb: req.move === true ? 'move' : 'share',
        type: req.type,
        id: req.id,
        target: { scope, label: req.scope === 'org' || req.scope === undefined ? 'everyone in the org' : scope },
        permission,
      }
    },
  }
}

/** Build every wired surface; the composition spreads the ones it wants onto the tool context. */
export function createToolControlSurfaces(deps: ToolControlDeps): {
  crons?: CronControlSurface
  webhooks?: WebhookControlSurface
  mcp?: McpControlSurface
  share?: ShareControlSurface
  playgrounds?: PlaygroundControlSurface
} {
  return {
    ...(deps.cron ? { crons: cronControl(deps) } : {}),
    ...(deps.webhooks ? { webhooks: webhookControl(deps) } : {}),
    ...(deps.mcp ? { mcp: mcpControl(deps) } : {}),
    ...(deps.grants ? { share: shareControl(deps) } : {}),
    ...(deps.files ? { playgrounds: playgroundControl(deps) } : {}),
  }
}

/**
 * T5 storage-side playground creation (qm `playgrounds/playground.ts`
 * parity): validate + normalize, then write through the viewer file
 * store. The artifact lands in the actor's Files (list/content/share
 * faces); turn-attachment delivery converges with the im-bridge
 * attachment slice.
 */
function playgroundControl(deps: ToolControlDeps): PlaygroundControlSurface {
  return {
    async createPlayground(input: { title: string; html: string }) {
      const files = deps.files?.()
      if (!files || !deps.actorId) {
        throw new Error('the playground is not available on this deployment')
      }
      validatePlaygroundHtml(input.html)
      const title = normalizePlaygroundTitle(input.title)
      const stored = await files.uploadForViewer(deps.actorId, {
        scopeId: `personal:${deps.actorId}`,
        name: `${title}.html`,
        mimetype: PLAYGROUND_MIMETYPE,
        bytes: Buffer.from(input.html, 'utf8'),
      })
      if (!stored) throw new Error('playground storage is not available on this deployment')
      return {
        kind: 'playground' as const,
        artifactId: stored.id,
        title,
        attachment: {
          name: stored.name,
          mimetype: stored.mimetype ?? PLAYGROUND_MIMETYPE,
          sizeBytes: stored.sizeBytes,
          blobId: stored.blobId,
          artifactId: stored.id,
          artifactViewerId: deps.actorId,
        },
      }
    },
  }
}
