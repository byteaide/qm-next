/**
 * Tool context contract: P1 parity port of qm src/tools/primitives.ts.
 *
 * `ToolContext` is the per-turn tool surface a harness hands to its toolset
 * (pi-tools): sandbox execution, file read/write, publishing, memory, MCP,
 * background jobs, cron/webhook control, and surface actions. P1 implements
 * the sandbox-backed core (execute/read/write/computer); the P4-domain
 * members are frozen here as data shapes so harness translations compile
 * against the full surface. `ToolContextDeps` (the assembly side) is
 * deliberately absent until the profile-assembly contract lands.
 */
import type { Destination } from './destination.ts'
import type { ScopeId } from './identity.ts'
import type { ComputerStatus, ExecResult, ProcessState } from './sandbox.ts'

export type Permission = 'read' | 'write'

export interface GrantedHandle {
  handlePath: string
  ownerScopeId: ScopeId
  ownerPath: string
  permission: Permission
}

export type CommandDecision = 'allow' | 'deny' | 'require_approval'

export interface CommandRule {
  pattern: string
  decision: CommandDecision
  reason?: string
}

export interface CommandPolicy {
  mode: 'denylist' | 'allowlist'
  rules: CommandRule[]
}

export class NeedsApproval extends Error {
  command: string
  approvalReason: string
  kind: 'approval'
  matched: string | undefined
  approvalKey: string | undefined
  constructor(command: string, reason: string, kind: 'approval' = 'approval', matched?: string, approvalKey?: string) {
    super(`command requires approval: ${command}`)
    this.name = 'NeedsApproval'
    this.command = command
    this.approvalReason = reason
    this.kind = kind
    this.matched = matched
    this.approvalKey = approvalKey
  }
}

export class CommandDenied extends Error {
  constructor(command: string, reason: string) {
    super(`command denied (${reason}): ${command}`)
    this.name = 'CommandDenied'
  }
}

export interface PublishInput {
  dir?: string
  entrypoint?: string
  name?: string
  renameFrom?: string
  env?: Record<string, string>
  rollbackTo?: number
  share?: Array<{ scope: ScopeId; permission: Permission }>
}

export type PublishAudienceKind = 'org' | 'members' | 'owner'

export interface PublishAudienceDescriptor {
  kind: PublishAudienceKind
  orgId?: string
  channelRef?: string
  memberCount?: number
  snapshotAt?: number
  note?: string
}

export interface PublishResult {
  id: string
  name?: string
  version: number
  url: string
  audience?: PublishAudienceDescriptor
  dataDir?: string
}

export interface ReadResult {
  content: string | null
  sourceScopeId: ScopeId | null
}

export interface ShareDirective {
  scope: ScopeId | 'org'
  permission?: Permission
}

export interface WriteResult {
  shared: Array<{ scope: ScopeId; permission: Permission }>
}

export interface ReachedProvenance {
  scopeId: ScopeId
  label: string
}

export interface SurfacePostOpts {
  ts?: string
  broadcast?: boolean
}

export interface SurfaceReachTarget {
  channel?: string
  recipient?: string
  participants?: readonly string[]
}

export interface SurfaceReactInput {
  ts: string
  emoji: string
  channel?: string
  participants?: readonly string[]
}

export interface SurfaceEditInput {
  ref: string
  text: string
  channel?: string
  participants?: readonly string[]
}

export interface SurfaceDeleteInput {
  ref: string
  channel?: string
  participants?: readonly string[]
}

export interface PostedFileMeta {
  name: string
  mimetype: string
  sizeBytes: number
  artifactId?: string
}

export interface SurfacePostResult {
  ok: boolean
  deliveryId?: string
  message?: string
  matched?: string
  attachments?: PostedFileMeta[]
}

export interface SurfaceReadResult {
  ok: boolean
  messages?: unknown[]
  message?: string
}

export interface SurfaceWhatsNewResult {
  ok: boolean
  hereNew?: number
  activeSubConversations?: number
  latest?: string
  coverageSince?: string
  message?: string
}

export interface SurfaceSearchHit {
  ref?: string
  author?: string
  when?: string
  snippet: string
}

export interface SurfaceSearchResult {
  ok: boolean
  hits?: SurfaceSearchHit[]
  source?: 'cache' | 'live'
  coverageSince?: string
  message?: string
}

export interface SurfaceMembersResult {
  ok: boolean
  members?: Array<{ displayName: string }>
  message?: string
}

export interface SurfaceFileResult {
  ok: boolean
  content?: string
  name?: string
  sizeBytes?: number
  contentType?: string
  message?: string
}

export type SurfaceStandingOrderResult =
  | { ok: true; orders: string; bots?: Record<string, BotPolicy>; ambientEnabled?: boolean }
  | { ok: false; message: string }

export interface BotPolicy {
  mode: 'ignore' | 'rollup' | 'action' | 'user'
  rollupHours?: number
}

export interface SurfaceToolDeps {
  post(text: string, opts?: SurfacePostOpts, files?: readonly string[]): Promise<SurfacePostResult>
  reach(text: string, target: SurfaceReachTarget, files?: readonly string[]): Promise<SurfacePostResult>
  react(input: SurfaceReactInput): Promise<SurfacePostResult>
  edit(input: SurfaceEditInput): Promise<SurfacePostResult>
  delete(input: SurfaceDeleteInput): Promise<SurfacePostResult>
  readThread(opts?: { limit?: number }): Promise<SurfaceReadResult>
  whatsNew(opts?: { since?: string }): Promise<SurfaceWhatsNewResult>
  search(query: string, opts?: SurfaceSearchOpts): Promise<SurfaceSearchResult>
  readMembers(): Promise<SurfaceMembersResult>
  readFile(ref: string): Promise<SurfaceFileResult>
  getStandingOrder(): Promise<SurfaceStandingOrderResult>
  setStandingOrder(
    orders: string,
    bots?: Record<string, BotPolicy>,
    ambientEnabled?: boolean | null,
  ): Promise<SurfaceStandingOrderResult>
  staySilent(reason: string): Promise<{ ok: true; message: string }>
}

export interface SurfaceSearchOpts {
  limit?: number
  source?: 'mirror' | 'live'
}

export interface ControlUnavailable {
  ok: false
  code: 'control_unavailable'
  message: string
}

export const CONTROL_UNAVAILABLE: ControlUnavailable = {
  ok: false,
  code: 'control_unavailable',
  message: "the control plane (crons, webhooks, standing instructions) isn't available on this turn",
}

export type ProcessStatus = 'running' | 'exited' | 'reaped'

export interface BackgroundStartResult {
  processId: string
  output: string
  cursor: number
  status: ProcessState
  reattached: boolean
}

export interface BackgroundPollResult {
  processId: string
  chunks: string
  cursor: number
  status: ProcessState
}

export interface BackgroundStopResult {
  processId: string
  status: ProcessState
  stopped: boolean
}

export interface BackgroundWriteResult {
  processId: string
  bytes: number
  status: ProcessState
}

export interface BackgroundJobSummary {
  processId: string
  command: string
  status: ProcessState
  registryStatus: ProcessStatus
  startedAt: number
}

export interface BackgroundWatchArmedResult {
  monitorId: string
  processId: string
  reattached: boolean
  expiresAt: number
}

export interface BackgroundWatchCompletedResult {
  processId: string
  completed: true
  registryStatus: ProcessStatus
  exitCode?: number
  outputTail: string
  cursor?: number
}

export type BackgroundWatchResult = BackgroundWatchArmedResult | BackgroundWatchCompletedResult

export interface BackgroundUnwatchResult {
  monitorId: string
  removed: boolean
}

export interface McpToolDescriptor {
  name: string
  serverId: string
  remoteName: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

export interface PlaygroundArtifact {
  kind: 'playground'
  artifactId: string
  title: string
}

export type ArtifactType = 'file' | 'skill' | 'deploy' | 'cron'

export interface ShareArtifactRequest {
  type: ArtifactType
  id: string
  scope?: string
  recipient?: string
  permission?: Permission
  move?: boolean
}

export type ShareArtifactResult =
  | {
      ok: true
      verb: 'share' | 'move' | 'promote'
      type: ArtifactType
      id: string
    }
  | { ok: false; code: string; message: string }

export interface RecipientConsent {
  recipientId: string
  status: 'pending' | 'accepted' | 'declined'
  decidedAt?: number
}

export interface TriggerBase {
  id: string
  ownerScopeId: ScopeId
  owner: string
  createdBy: string
  ownerConsentedAt?: number
  destination?: Destination
  enabled: boolean
  createdAt: number
  lastFiredAt?: number
  recipientConsent?: RecipientConsent
}

export interface CronSchedule {
  cron?: string
  timezone?: string
  everyMs?: number
  firstFireAt?: number
}

export interface CronFireLogEntry {
  fireKey: string
  threadRef: string
  firedAt: number
  scheduledAt?: number
  status?: string
  note?: string
  reply?: string
  sessionId?: string
}

export interface Cron extends TriggerBase {
  schedule: CronSchedule
  nextFireAt?: number
  lastAttemptAt?: number
  title?: string
  archived?: boolean
  action?: string
  message?: string
  createdAt: number
  runAs?: 'owner' | 'scopeFloor' | 'scopeShared'
  members?: Array<{ id: string; type: string; displayName?: string }>
  unattendedGrants?: string[]
  fireLog?: CronFireLogEntry[]
}

export interface WebhookVerification {
  scheme: 'hmac-sha256' | 'github' | 'stripe' | (string & {})
  secret?: string
}

export interface WebhookFilter {
  path: string
  in: string[]
}

export interface Webhook extends TriggerBase {
  action: string
  verification: WebhookVerification
  filters?: WebhookFilter[]
  lastDeliveryId?: string
  lastError?: string
}

export type VisibleCron = Cron & { scopeName?: string }

export type ControlOk<T> = { ok: true } & T
export type ControlErr<C extends string> = { ok: false; code: C; message: string }

export interface CronCreateRequest {
  schedule: CronSchedule
  title?: string
  action?: string
  text?: string
  recipient?: string
  channel?: string
  participants?: string[]
  scope?: 'personal'
  destinationKey?: string
  runAs?: 'owner' | 'scopeFloor' | 'scopeShared'
  unfurlLinks?: boolean
  unattendedGrants?: string[]
}

export type CronCreateResult =
  | {
      ok: true
      cron: Cron
      recipient?: { principalId: string; displayName: string }
      channel?: { channelId: string; name: string }
      group?: { groupId: string }
    }
  | {
      ok: false
      code:
        | 'bad_request'
        | 'recipient_not_found'
        | 'ambiguous_recipient'
        | 'channel_not_found'
        | 'ambiguous_channel'
        | 'group_not_found'
        | 'not_a_member'
        | 'identity_unverified'
        | 'unknown_destination'
        | 'members_unavailable'
        | 'forbidden'
        | 'cron_create_failed'
      message: string
      candidates?: Array<{ id: string; label: string }>
    }

export interface CronPatchRequest {
  title?: string
  action?: string
  text?: string
  schedule?: CronSchedule
  enabled?: boolean
  archived?: boolean
  unfurlLinks?: boolean
  runAs?: 'owner' | 'scopeFloor' | 'scopeShared'
  unattendedGrants?: string[]
}

export interface CronRunsRequest {
  limit?: number
}

export interface CronRunsResult {
  cron: Cron
  runs: CronFireLogEntry[]
  total: number
}

export interface WebhookCreateRequest {
  action: string
  verification: Webhook['verification']
  filters?: Webhook['filters']
  destinationKey?: string
}

export type WebhookCreateResult =
  | { ok: true; webhook: Webhook; url: string; secret?: string }
  | { ok: false; code: 'bad_request' | 'unknown_destination' | 'webhook_create_failed'; message: string }

export interface ToolContext extends SurfaceToolDeps {
  credentialExecServices?: readonly { service: string; binary: string }[]
  credentialExec?(
    service: string,
    args: string[],
    opts?: { timeoutSeconds?: number; signal?: AbortSignal },
  ): Promise<ExecResult>
  execute(
    command: string,
    opts?: {
      timeoutSeconds?: number
      scratch?: boolean
      ownerAuth?: boolean
      reachTarget?: string
      signal?: AbortSignal
    },
  ): Promise<ExecResult & { reached?: ReachedProvenance }>
  computerStatus(): Promise<ComputerStatus>
  restartComputer(): Promise<void>
  read(path: string): Promise<ReadResult>
  write(path: string, data?: string, share?: ShareDirective[]): Promise<WriteResult>
  publish(input: PublishInput): Promise<PublishResult>
  createPlayground(input: { title: string; html: string }): Promise<PlaygroundArtifact>
  memorySearch(q: string, limit?: number): Promise<string[] | null>
  memoryRead(): Promise<string | null>
  memoryRemember(facts: string[]): Promise<number | null>
  memoryRewrite(content: string): Promise<true | null>
  history(q: string, limit?: number): Promise<string[]>
  mcpToolDefs(): McpToolDescriptor[]
  callMcpTool(name: string, args: Record<string, unknown>): Promise<string>
  backgroundStart(command: string, opts?: { ttlSeconds?: number }): Promise<BackgroundStartResult>
  backgroundPoll(
    processId: string,
    opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number },
  ): Promise<BackgroundPollResult>
  backgroundStop(processId: string, signal?: string): Promise<BackgroundStopResult>
  backgroundWrite(processId: string, data: string): Promise<BackgroundWriteResult>
  backgroundList(): Promise<BackgroundJobSummary[]>
  backgroundWatch(
    processId: string,
    opts?: { instructions?: string; pattern?: string; sinceCursor?: number },
  ): Promise<BackgroundWatchResult>
  backgroundUnwatch(monitorId: string): Promise<BackgroundUnwatchResult>
  cronCreate(req: CronCreateRequest): Promise<CronCreateResult | ControlUnavailable>
  cronList(): Promise<{ crons: Cron[]; visible: VisibleCron[] } | ControlUnavailable>
  cronGet(id: string): Promise<ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden'> | ControlUnavailable>
  cronRuns(
    id: string,
    req?: CronRunsRequest,
  ): Promise<ControlOk<CronRunsResult> | ControlErr<'not_found' | 'forbidden' | 'bad_request'> | ControlUnavailable>
  cronPatch(
    id: string,
    req: CronPatchRequest,
  ): Promise<
    | ControlOk<{ cron: Cron }>
    | ControlErr<'not_found' | 'forbidden' | 'bad_request' | 'cron_update_failed'>
    | ControlUnavailable
  >
  cronDelete(
    id: string,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<'not_found' | 'forbidden'> | ControlUnavailable>
  cronSetEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden'> | ControlUnavailable>
  cronRun(
    id: string,
  ): Promise<
    | ControlOk<Record<never, never>>
    | ControlErr<'not_found' | 'forbidden' | 'unavailable' | 'bad_request'>
    | ControlUnavailable
  >
  cronRetarget(
    id: string,
    destinationKey: string,
  ): Promise<
    ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden' | 'unknown_destination'> | ControlUnavailable
  >
  webhookCreate(req: WebhookCreateRequest): Promise<WebhookCreateResult | ControlUnavailable>
  webhookList(): Promise<Webhook[] | ControlUnavailable>
  webhookDisable(
    id: string,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<'not_found' | 'forbidden'> | ControlUnavailable>
  soulRead(): { effectiveSoul: string; soul: string | null; soulVersion: number } | ControlUnavailable
  soulWrite(
    content: string,
  ): Promise<ControlOk<{ version: number }> | ControlErr<'soul_update_denied'> | ControlUnavailable>
  shareArtifact(req: ShareArtifactRequest): Promise<ShareArtifactResult | ControlUnavailable>
}
