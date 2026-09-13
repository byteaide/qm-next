# qm-next

基于 Cordis 插件架构的企业级 Agent 编排平台（qm 的全插件重写）。

- 架构：[docs/architecture.md](docs/architecture.md)
- PRD / 任务：`aa` 仓 `todo/tasks/prd-qm-next.md` / `tasks-qm-next.md`
- 变更史：[CHANGELOG.md](CHANGELOG.md)

## 快速开始

```sh
pnpm install          # pnpm workspaces（vendor/* + packages/*）
pnpm build            # 构建 vendor 内核（tsc → lib）
pnpm typecheck        # 严格类型门禁（packages/* strict，vendor 消费构建产物 d.ts）
pnpm test             # 冒烟 + 单测（无 PG；PG 对拍用 test:pg）
pnpm test:pg          # 一次性 postgres:16 容器全量对拍
pnpm check:im         # 门禁：core 服务无 IM 平台符号（M4 21.1）
pnpm rescope-check    # 门禁：vendor 无 @deepseek-ai 残留
```

## 组装档

| profile | 用途 |
|---------|------|
| `profiles/cordis.yml` | 默认：M0 冒烟 + HTTP API + 桥 + cron 调度 + web-ui（内存 store、mock harness） |
| `profiles/im-smoke.yml` | 飞书真机冒烟（env 凭据） |
| `profiles/im-e2e.yml` | 飞书真机 e2e（审批卡/ambient/cron 三腿，auto-arm），runbook `docs/e2e-feishu.md` |

## 状态

v0.1.0：IM 渠道只做**飞书**（M0 基座 → M1 核心回路 → M2 IM 契约 + 飞书 → M3 企业能力回归 → M4 收尾门禁）。core 服务零平台符号（`pnpm check:im`）；`ImProvider` 契约 + 注册表支持同构接入新渠道，但 slack/钉钉/企微适配器**延期**（slack 曾有实现，历史见 git `d7d2db3`；重启工作以 `check:im` 门禁下的 `ImProvider` 实现为准）。
