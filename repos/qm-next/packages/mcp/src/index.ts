/**
 * `@qm/mcp` — Model Context Protocol connector layer.
 *
 * Tranche 1 (parity 16.0): transport (`mcp-client`) and server registry
 * (`mcp-server-store`). The agent-tool bridge (`mcp-tool-service`) and
 * API/admin routes land in tranche 2; the memory `mcp` provider (closes
 * the 15.0 deferred surface) lands in tranche 3.
 */
export * from './mcp-client.ts'
export * from './mcp-server-store.ts'