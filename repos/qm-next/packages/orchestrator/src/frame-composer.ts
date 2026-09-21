/**
 * Frame composer (ADR-0018): the system prompt is a fixed-order composition
 * assembled each turn — a mode frame selected by turn origin, the scope's
 * effective soul, the shared behavioral core, the rendered security policy,
 * and the gateway block — with a byte boundary recorded after the stable
 * segments for the harness prompt cache. Rendering is fail-loud
 * (applyPromptVars throws on unresolved tokens). Port of qm
 * src/core/orchestrator.ts:852-941 with platform vocabulary injected as
 * variables (parity deviation #55).
 */
import { applyPromptVars, loadProtocolFile, type PromptVars } from './protocols/prompt-vars.ts'
import type { Conversation, GatewayContext, Principal, TurnOrigin, TurnResolution } from '@qm/types'

export type FrameMode = 'autonomous' | 'conversation' | 'fallback'

export interface TurnFrameContext {
  origin: TurnOrigin
  surface: string
  conversation: Pick<Conversation, 'kind'>
  actor: Principal
  /** Caller/resolution-asserted surface tool availability (mode-autonomous precondition). */
  surfaceTools?: boolean
  proactiveOpener?: boolean
}

/**
 * Mode selection, qm orchestrator.ts:857-862: surface tools → autonomous;
 * non-automated DM/web → conversation; otherwise fallback. Ambient turns and
 * automation with a destination derive surface tools (ADR-0018).
 */
export function selectFrameMode(ctx: {
  origin: TurnOrigin
  surface: string
  conversation: Pick<Conversation, 'kind'>
  surfaceTools?: boolean
}): FrameMode {
  const surfaceTools = ctx.surfaceTools ?? deriveSurfaceTools(ctx.origin)
  if (surfaceTools) return 'autonomous'
  const automated = ctx.origin.kind === 'automation'
  if (!automated && (ctx.conversation.kind === 'dm' || ctx.surface === 'web')) return 'conversation'
  return 'fallback'
}

/**
 * Ambient turns and automation with a destination run with the surface tool
 * set attached; plain automation fires headless and other turns are
 * interactive (no surface tools unless the caller asserts them).
 */
export function deriveSurfaceTools(origin: TurnOrigin): boolean {
  if (origin.kind === 'ambient') return true
  if (origin.kind === 'automation') return origin.destination !== undefined
  return false
}

const LABEL_STRIP = /[\u0000-\u001F\u007F-\u009F\u2028\u2029<>{}]/g

/** qm branding.ts cleanBrandingLabel: strip control/markup chars, cap length. */
export function cleanLabel(value: string | undefined, cap: number): string | undefined {
  const cleaned = (typeof value === 'string' ? value : '').replace(LABEL_STRIP, '').trim()
  return [...cleaned].slice(0, cap).join('') || undefined
}

export interface ComposeFrameOptions extends TurnFrameContext {
  /** Segment ② — the scope's effective soul (possibly empty). */
  soul: string
  resolution?: Pick<TurnResolution, 'securityPrompt' | 'branding' | 'skillsBlock'>
  /** Provider display name injected into platform-wording slots (deviation #55). */
  imLabel?: string
  /** Surface-tool name rendered into the mode frames (pi default: 'surface'). */
  surfaceToolName?: string
  gatewayContext?: GatewayContext
}

export interface ComposedFrame {
  systemPrompt: string
  /** Byte boundary after the stable segments → HarnessTurnInput.systemCacheBoundary. */
  stableSystemBytes: number
  mode: FrameMode
}

/**
 * qm gateway-context.ts renderGatewayContext, neutralized: the scheduled-
 * notification warning names the platform through `imLabel` instead of a
 * literal, so core source stays free of platform symbols (check:im).
 */
export function renderGatewayBlock(
  surface: string | undefined,
  ctx: GatewayContext | undefined,
  imLabel = 'the IM platform',
): string {
  const gateway = (surface ?? '').trim()
  const location = ctx?.location?.trim()
  const details = Object.entries(ctx?.details ?? {})
    .map(([k, v]) => [k.trim(), String(v).trim()] as const)
    .filter(([k, v]) => k && v)
  const instructions = ctx?.instructions?.trim()
  if (!gateway && !location && details.length === 0 && !instructions) return ''

  const lines = ['## Where you are']
  if (gateway && location) lines.push(`You are talking with the user over ${gateway}, in ${location}.`)
  else if (gateway) lines.push(`You are talking with the user over ${gateway}.`)
  else if (location) lines.push(`You are talking with the user in ${location}.`)
  if (details.length) {
    lines.push('Identifiers for this conversation (use these if you need to act on it directly):')
    for (const [k, v] of details) lines.push(`- ${k}: ${v}`)
  }
  if (gateway.toLowerCase() === 'web') {
    lines.push(
      `This web UI cannot receive future external notifications. For scheduled notifications, reminders, digests, or reports, create the cron with a real platform destination: use \`recipient\` for a ${imLabel} DM to the requesting user when you can resolve them as a teammate, \`channel\` for a named ${imLabel} channel, or ask the user where it should post. Do not put "deliver to ${imLabel}" only inside \`action\`.`,
    )
  }
  if (instructions) lines.push(instructions)
  return lines.join('\n')
}

function frameVars(
  mode: FrameMode,
  opts: ComposeFrameOptions,
  branding: { botName: string; orgName: string; botHandle?: string },
): PromptVars {
  const isWeb = opts.surface === 'web'
  const imLabel = opts.imLabel ?? 'the IM platform'
  if (mode === 'autonomous') {
    return { botName: branding.botName, surfaceTool: opts.surfaceToolName ?? 'surface', imChannel: !isWeb, imLabel }
  }
  if (mode === 'conversation') {
    return {
      botName: branding.botName,
      userName: cleanLabel(opts.actor.displayName, 80) ?? 'there',
      userEmail: opts.actor.id.includes('@') ? opts.actor.id : undefined,
      surfaceLabel: isWeb ? `the ${branding.botName} web app` : imLabel,
      imChannel: !isWeb,
      imLabel,
      web: isWeb,
    }
  }
  return {}
}

/**
 * Compose the stable prefix (segments ①-⑤ + ⑧ + ⑨ where present) and record
 * the cache boundary. Segment order is qm-exact: mode frame, soul, shared
 * core, security policy, skills block, gateway block, proactive opener line.
 */
export function composeFrame(opts: ComposeFrameOptions): ComposedFrame {
  const botHandle = cleanLabel(opts.gatewayContext?.botHandle?.replace(/^@/, ''), 40)
  const branding = {
    botName: opts.resolution?.branding?.botName ?? 'QM',
    orgName: opts.resolution?.branding?.orgName ?? 'this organization',
    ...(botHandle ? { botHandle } : {}),
  }
  const mode = selectFrameMode(opts)
  let modeFrame = applyPromptVars(loadProtocolFile(`mode-${mode}`), frameVars(mode, opts, branding))
  if (mode === 'conversation' && opts.proactiveOpener) {
    modeFrame += '\nNo one has written yet; open the conversation yourself per the onboarding note below.'
  }
  const sharedCore = applyPromptVars(loadProtocolFile('shared-core'), {
    botName: branding.botName,
    orgName: branding.orgName,
    ...(branding.botHandle ? { botHandle: branding.botHandle } : {}),
    imLabel: opts.imLabel ?? 'the IM platform',
  })
  const gatewayBlock = opts.gatewayContext ? renderGatewayBlock(opts.surface, opts.gatewayContext, opts.imLabel) : ''
  const segments: string[] = [
    modeFrame,
    opts.soul,
    sharedCore,
    ...(opts.resolution?.securityPrompt ? [opts.resolution.securityPrompt] : []),
    ...(opts.resolution?.skillsBlock ? [opts.resolution.skillsBlock] : []),
    ...(gatewayBlock ? [gatewayBlock] : []),
  ]
  const systemPrompt = segments.join('\n\n')
  return { systemPrompt, stableSystemBytes: systemPrompt.length, mode }
}
