/**
 * `@qm/mcp` — Model Context Protocol connector layer.
 *
 * Tranche 1 (parity 16.0): transport (`mcp-client`) and server registry
 * (`mcp-server-store`). Tranche 2: agent-tool bridge (`mcp-tool-service`)
 * with audit + auto-refresh. The API/admin routes land in tranche 3; the
 * memory `mcp` provider (closes the 15.0 deferred surface) lands in
 * tranche 4.
 */
export * from './mcp-client.ts'
export * from './mcp-server-store.ts'
export * from './mcp-tool-service.ts'
export { errMessage } from './util.ts'