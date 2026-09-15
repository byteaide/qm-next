/**
 * `errMessage` — portable error stringification used by `@qm/mcp` helpers.
 * Per-package copy mirrors the qm convention (`repos/qm/src/util/errors.ts`);
 * keeps the mcp package free of cross-package deps.
 */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}