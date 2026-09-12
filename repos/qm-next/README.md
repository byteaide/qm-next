# qm-next

基于 Cordis 插件架构的企业级 Agent 编排平台（qm 的全插件重写）。

- 架构：[docs/architecture.md](docs/architecture.md)
- PRD / 任务：`aa` 仓 `todo/tasks/prd-qm-next.md` / `tasks-qm-next.md`

## 快速开始

```sh
pnpm install          # pnpm workspaces（vendor/* + packages/*）
pnpm build            # 构建 vendor 内核（tsc → lib）
pnpm typecheck        # 严格类型门禁（packages/* strict，vendor 消费构建产物 d.ts）
pnpm test             # 冒烟 + 单测
pnpm rescope-check    # 门禁：vendor 无 @deepseek-ai 残留
```

## 状态

M0 基座施工中（vendor cordis + profile 启动冒烟）。里程碑见任务分解 M0-M4。
