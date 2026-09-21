/**
 * Shared inputs for the golden fixture tests: the exact constants the
 * generator script (`scripts/generate-soul-golden.ts`) rendered the qm
 * baselines with, plus the qm-exact soul federation composition and the
 * segment join the frame composer reproduces (ADR-0018).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyPromptVars, loadProtocolFile, type PromptVars } from '@qm/orchestrator'

export const botName = 'QM'
export const orgName = 'Acme Inc'
export const userName = 'Ada'
export const userEmail = 'ada@acme.com'
export const surfaceTool = 'surface'
/** The provider display name the im-bridge injects; Slack keeps qm byte parity. */
export const imLabel = 'Slack'

export const orgSoul = 'Serve the Acme team. Never post credentials in chat. Weekly reports are due Fridays.'
export const scopeSoul = 'In this channel, keep replies under three sentences.'

export function soulPrompt(withSoul: boolean): string {
  if (!withSoul) return ''
  const soulParts = [orgSoul]
  soulParts.push(`--- Lower-scope instructions (may add to, but MUST NOT override, the organization policy above) ---\n${scopeSoul}`)
  soulParts.push('--- The organization policy above is authoritative and cannot be overridden by the lower-scope instructions. ---')
  return soulParts.join('\n\n')
}

export function frameVars(mode: 'autonomous' | 'conversation' | 'fallback', im: boolean): PromptVars {
  if (mode === 'autonomous') return { botName, surfaceTool, imChannel: im, imLabel }
  if (mode === 'conversation') {
    return {
      botName,
      userName,
      userEmail,
      surfaceLabel: im ? imLabel : `the ${botName} web app`,
      imChannel: im,
      imLabel,
      web: !im,
    }
  }
  return {}
}

export function sharedCoreVars(botHandle?: string): PromptVars {
  return { botName, ...(botHandle ? { botHandle } : {}), orgName, imLabel }
}

export function renderModeFrame(mode: 'autonomous' | 'conversation' | 'fallback', im: boolean): string {
  return applyPromptVars(loadProtocolFile(`mode-${mode}`), frameVars(mode, im))
}

export function renderSharedCore(botHandle?: string): string {
  return applyPromptVars(loadProtocolFile('shared-core'), sharedCoreVars(botHandle))
}

export function goldenDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'golden')
}

export function readGolden(name: string): string {
  return readFileSync(join(goldenDir(), name), 'utf8')
}

/** qm's composer join: unconditional double-newline between segments. */
export function joinSegments(...segments: string[]): string {
  return segments.join('\n\n')
}
