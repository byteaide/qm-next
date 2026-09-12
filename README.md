# aa

Agent workspace hosting three projects under `repos/`.

## Projects

| Project | Path | Description |
|---------|------|-------------|
| koishi | `repos/koishi` | Cross-platform chatbot framework (TypeScript monorepo) |
| deepseek-harness | `repos/deepseek-harness` | DeepSeek agent harness (packages/session/apps) |
| qm | `repos/qm` | Application with CLI, plugins, and deploy stacks |

## Codebase Memory (cbm) Index

All 3 projects under `repos/` are indexed with the `codebase-memory-mcp`
server (cbm) for semantic code search, call-graph traversal, and architecture
analysis.

Indexed: 2026-09-12 · mode: `full`

| Project | cbm project name | Nodes | Edges | Status |
|---------|------------------|-------|-------|--------|
| koishi | `Users-wxd-dev-agents-aa-repos-koishi` | 1,134 | 2,898 | ready |
| deepseek-harness | `Users-wxd-dev-agents-aa-repos-deepseek-harness` | 96,908 | 321,102 | ready |
| qm | `Users-wxd-dev-agents-aa-repos-qm` | 20,094 | 94,020 | ready |

Notes:

- koishi: 2 tsconfig JSON files report `parse_partial` on comment-only lines
  (`tsconfig.base.json:17-19`, `tsconfig.node.json:11-12`); prefer grep there.
- Re-index after large upstream updates with `index_repository`; check health
  via `index_status`.
