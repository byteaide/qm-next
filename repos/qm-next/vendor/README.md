# Vendored Packages

Cordis 框架与基础库的 vendor 拷贝（源自 deepseek-harness 的 vendor 快照，后者源自 cordiverse/cordis 上游）。目的：框架层完全自持（可审计、可补丁、版本钉死）。

## Manifest

| 目录 | npm 名 | 上游名 | 上游版本 |
|---|---|---|---|
| `cosmokit/` | `@qm/cosmokit` | `cosmokit` | 1.8.3 |
| `schemastery/` | `@qm/schemastery` | `schemastery` | 3.18.2 |
| `cordis/` | `@qm/cordis` | `cordis` | 4.0.2 |
| `loader/` | `@qm/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.3 |
| `include/` | `@qm/cordis-plugin-include` | `@cordisjs/plugin-include` | 1.0.7 |
| `timer/` | `@qm/cordis-plugin-timer` | `@cordisjs/plugin-timer` | 1.1.4 |

第三方依赖留在 npm：`@standard-schema/spec`、`js-yaml`。
暂缓引入（需要时再加）：`group`、`hmr`、`logger-console`。

## Local modifications（相对 dsh vendor 快照）

1. **rescope**：`@deepseek-ai/` → `@qm/`（所有 package.json 的 name/deps、src 内 import/declare module）。目录名、版本号、上游运行时标识（如 `Symbol.for('schemastery')`）不变。`scripts/rescope-check.sh` 是门禁。
2. **schemastery 入口改 ESM-only**：删除 dual `.mjs`/`.cjs` exports（dsh 为双格式 tsdown 产物），改单 ESM 入口 `lib/index.js`。qm-next 全仓 ESM，无 require 消费者。
3. **构建简化**：dsh 用 tsdown 双段（tsc 中间产物 `lib/types` → tsdown 打包 `lib/`）；qm-next 单阶段——`tsc -b` 产出 `lib/types`（JS+d.ts），脚本把 JS 同步到 `lib/`。见 `scripts/build-vendor.sh`。
4. tsconfig extends 指向 qm-next 根 `tsconfig.base.json`（同名同相对深度，直接兼容）；根 paths 映射 `@qm/*` → `vendor/*/src`。

## Sync procedure（升级上游时）

1. 从 deepseek-harness `vendor/` 拷贝新快照（其 README 有上游 SHA）。
2. 重新执行 rescope（`sed 's|@deepseek-ai/|@qm/|g'` 于 .ts/.js/package.json）。
3. 核对本文件 Local modifications 是否仍然适用。
4. `pnpm install && pnpm build && pnpm test`。
