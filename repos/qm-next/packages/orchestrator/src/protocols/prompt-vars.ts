/**
 * Protocol-frame template renderer (ADR-0018): loads the mode frames and the
 * shared core from this directory and substitutes `{{var}}` / `{{#if var}}`
 * tokens. Fail-loud — an unresolved token throws instead of reaching the
 * model. Port of qm `src/resolution/prompt-vars.ts`; templates are
 * neutralized per parity deviation #55 (`imChannel`/`imLabel`, no platform
 * words in source).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PromptVars = Record<string, string | boolean | undefined>

export function loadProtocolFile(name: string): string {
  return readFileSync(join(import.meta.dirname, `${name}.md`), 'utf8').trim()
}

export function applyPromptVars(md: string, vars: PromptVars): string {
  const withConditionals = md.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, cond: string, body: string) => (vars[cond] ? body : ''),
  )
  const rendered = withConditionals.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
  if (rendered.includes('{{')) {
    const at = rendered.indexOf('{{')
    throw new Error(`applyPromptVars: unresolved template token near "${rendered.slice(at, at + 40)}"`)
  }
  return rendered
}
