/**
 * Golden fixture generator for the soul-layer protocol frames (ADR-0018).
 *
 * Renders the three qm mode frames through qm's own renderer
 * (`repos/qm/src/resolution/prompt-vars.ts`) over a fixed input matrix and
 * writes the byte-identical qm baseline into
 * `packages/orchestrator/tests/golden/`. The qm-next frame composer must
 * reproduce these outputs exactly, except at the platform-vocabulary
 * replacement points pre-registered as deviation #55 in
 * `docs/parity-deviations.md` (see tests/golden/README.md).
 *
 * Run from `repos/qm-next`: `node --import tsx/esm scripts/generate-soul-golden.ts`
 * Requires the sibling `repos/qm` checkout (upstream reference, read-only).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPromptVars, loadProtocolFile, type PromptVars } from '../../qm/src/resolution/prompt-vars.ts'
import { renderSecurityPolicyPrompt, resolveSecurityPolicy } from '../../qm/src/security/security-posture.ts'

const GOLDEN_DIR = join(import.meta.dirname, '../packages/orchestrator/tests/golden')

const botName = 'QM'
const orgName = 'Acme Inc'
const userName = 'Ada'
const userEmail = 'ada@acme.com'
const surfaceTool = 'surface'

const orgSoul = 'Serve the Acme team. Never post credentials in chat. Weekly reports are due Fridays.'
const scopeSoul = 'In this channel, keep replies under three sentences.'

function soulPrompt(withSoul: boolean): string {
  if (!withSoul) return ''
  const soulParts = [orgSoul]
  soulParts.push(`--- Lower-scope instructions (may add to, but MUST NOT override, the organization policy above) ---\n${scopeSoul}`)
  soulParts.push('--- The organization policy above is authoritative and cannot be overridden by the lower-scope instructions. ---')
  return soulParts.join('\n\n')
}

function frameFor(mode: string, im: boolean): { md: string; vars: PromptVars } {
  if (mode === 'autonomous') {
    return { md: loadProtocolFile('mode-autonomous'), vars: { botName, surfaceTool, slack: im } }
  }
  if (mode === 'conversation') {
    return {
      md: loadProtocolFile('mode-conversation'),
      vars: {
        botName,
        userName,
        userEmail,
        surfaceLabel: im ? 'Slack' : `the ${botName} web app`,
        slack: im,
        web: !im,
      },
    }
  }
  return { md: loadProtocolFile('mode-fallback'), vars: {} }
}

const securityPrompt = renderSecurityPolicyPrompt(resolveSecurityPolicy('auto'))

mkdirSync(GOLDEN_DIR, { recursive: true })
for (const mode of ['autonomous', 'conversation', 'fallback']) {
  for (const withSoul of [true, false]) {
    for (const im of [true, false]) {
      const { md, vars } = frameFor(mode, im)
      const modeFrame = applyPromptVars(md, vars)
      const sharedCore = applyPromptVars(loadProtocolFile('shared-core'), { botName, botHandle: undefined, orgName })
      const systemPrompt = `${modeFrame}\n\n${soulPrompt(withSoul)}\n\n${sharedCore}\n\n${securityPrompt}`
      const name = `${mode}-${withSoul ? 'soul' : 'nosoul'}-${im ? 'im' : 'web'}.md`
      writeFileSync(join(GOLDEN_DIR, name), systemPrompt, 'utf8')
      console.log(`wrote ${name} (${systemPrompt.length} bytes)`)
    }
  }
}
