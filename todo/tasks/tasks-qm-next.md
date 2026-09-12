# Tasks: qm-next — Cordis 重写 + 飞书 IM 适配层

Based on [ai-dev-tasks](https://github.com/snarktank/ai-dev-tasks) task format, with time tracking.

**PRD:** [prd-qm-next.md](prd-qm-next.md)
**Created:** 2026-09-12
**Status:** Not Started
**Estimate:** ~11d 总工作量；双 agent 并行后墙钟 ~7-8d (ai:~7d test:~3d)

<!--TOON:tasks_meta{id,feature,prd,status,est,est_ai,est_test,est_read,logged,started,completed}:
tasks-qm-next,qm-next（Cordis 重写 + 飞书 IM）,prd-qm-next,in_progress,~11d,~7d,~3d,,2026-09-12T15:00Z,,
-->

## 并行执行规程（双 subagent）

- **车道标记**：`【串行门】`= 单点执行，产出冻结契约；`【A】`/`【B】`= 两条并行车道；`【汇合】`= 车道合并验收。
- **隔离方式**（默认方案）：同仓库、按包目录隔离。车道 A 只写自己的包目录，车道 B 同理；`pnpm install` 在并行阶段开始前由主会话执行一次；**只有主会话提交 git**，worker 不跑 git 写命令。
- **契约先行**：每个并行阶段开始前，`【串行门】`任务先冻结共享类型/接口（提交后），车道对冻结契约编程，期间契约变更须回到主会话裁决。
- **worker brief**：每个并行任务自带 brief 块（目录边界/对什么编程/参考实现/验证），可直接派发；worker 遇契约缺口即停，回报主会话，不自行改共享契约。
- 备选方案（如需更强隔离）：每车道独立 worktree + 分支（`lane/<name>`），串行门合并——代价是合并管理，默认不采用。

## Relevant Files

- `repos/qm-next/` - 新仓库（本计划全部产出）
- `repos/qm/src/core/orchestrator.ts` - 平移来源：handleTurn 主循环（3277L）
- `repos/qm/src/runs/run-store.ts` - 平移来源：run 队列接口（enqueue/claim/heartbeat/complete）
- `repos/qm/src/runs/postgres-run-store.ts` - 平移来源：Postgres 实现
- `repos/qm/src/sessions/session-store.ts` - 平移来源：会话存储
- `repos/qm/src/harness/{harness,harness-router,pi-harness}.ts` - 平移来源：harness 接口与路由
- `repos/qm/src/api/slack-core-client.ts` - 参照：插件↔core 边界（重写为通用契约）
- `repos/qm/src/slack/` - M4 参考实现：Slack 能力全集（mrkdwn/approvals/directory…）
- `repos/deepseek-harness/vendor/` - M0 拷贝来源（cordis/cosmokit/schemastery/loader/include/timer）
- `repos/deepseek-harness/docs/rescope.md` - rescope 映射与规则
- `repos/deepseek-harness/packages/webhook/webhook/` - IM 契约先例（register/dispatch）
- `repos/deepseek-harness/docs/cordis-primer.md` - 插件编写规范

## Notes

- 里程碑硬约束：M1 验收前不写 IM 代码；surface 全链路显式化，无默认渠道
- 每个子任务完成即勾选 `- [ ]` → `- [x]`，由主会话更新
- 估算格式：`~Xh (ai:Xh test:Xh)`
- 验证统一走真实路径：起服冒烟、真机飞书，不以单测绿替代端到端

## Tasks

### M0 基座（串行，~1d）

- [ ] 1.0 M0 仓库脚手架与内核 ~1d (ai:0.5d test:0.5d)
  - [ ] 1.1 创建 `repos/qm-next`：git init、pnpm workspace（`vendor/*` + `packages/*/*`）、`tsconfig.base.json`（strict、NodeNext、ESM）、`.gitignore`、README ~1h
  - [ ] 1.2 vendor 拷贝 6 包：`cosmokit`、`schemastery`、`cordis`、`loader`、`include`、`timer`（自 dsh `vendor/`）；group/hmr/logger-console 暂缓 ~0.5h
  - [ ] 1.3 rescope：`@deepseek-ai` → `@qm`（包名、内部依赖键、源码 import；`cordis:` 协议前缀与 `Symbol.for('schemastery')` 不改）；映射表写入 `vendor/README.md` ~1h
  - [ ] 1.4 构建：单阶段 tsc emit `lib/`（JS + d.ts；有意偏离 dsh 的 tsdown 双段构建，记录于 README）~1h
  - [ ] 1.5 冒烟测试：插件挂载/卸载、`inject` 等待、Config 校验、五种事件派发（emit/waterfall/parallel/serial/bail）、`ctx.effect()` 可逆 ~2h
  - [ ] 1.6 `cordis.yml` profile 启动：bootstrap 脚本 + loader/include 加载，含 `!!js` 配置插值用例 ~2h
  - [ ] 1.7 【串行门验收】`pnpm test` 全绿 + profile 启停通过；打 tag `m0` ~0.5h

### M1 核心回路（1 串行门 + 2 并行 + 汇合，~3d/墙钟 ~2d）

- [ ] 2.0 【串行门】契约冻结 ~0.5d (ai:0.4d test:0.1d)
  - [ ] 2.1 定义 `packages/types`：`TurnInput`/`TurnResult`/`Session`/`Run`/`Destination{type:string}`（surface 显式，无默认值）；store 接口（enqueue/claim/heartbeat/complete/fail）；orchestrator 输入输出；提交冻结 ~2h
  - [ ] 2.2 主会话执行 `pnpm install`，开并行 ~0.5h
- [ ] 3.0 【A】存储层 `packages/store` ~1d (ai:0.7d test:0.3d)
  - > brief：只写 `packages/store/`；对 2.1 冻结接口编程；参考 `qm/src/runs/{run-store,postgres-run-store}.ts`、`qm/src/sessions/session-store.ts`、`qm/src/persistence/pg-pool.ts`；验证：内存/Postgres 双实现对拍（同用例跑两实现）+ 租约/心跳/并发 claim 测试
  - [ ] 3.1 内存实现（Map 版 store）~2h
  - [ ] 3.2 Postgres 实现（平移 qm schema）~3h
  - [ ] 3.3 对拍测试 + 并发语义测试 ~2h
- [ ] 4.0 【B】编排层 `packages/orchestrator` ~1d (ai:0.7d test:0.3d)
  - > brief：只写 `packages/orchestrator/`；对 2.1 冻结接口编程（store 用接口 stub/内存假件）；平移 `qm/src/core/orchestrator.ts` 的 handleTurn 骨架（身份/限流/会话解析/harness 调用/投递），**剥离全部 Slack 分支**；harness router + mock harness 参考 `qm/src/harness/{harness,harness-router,mock-harness}.ts`；验证：mock harness 全回路单测
  - [ ] 4.1 orchestrator Service 化（平移 + 去 Slack 化）~3h
  - [ ] 4.2 harness router + mock harness ~2h
  - [ ] 4.3 回路单测（含限流/预算/会话解析）~2h
- [ ] 5.0 【汇合】API 插件与端到端 ~1d (ai:0.6d test:0.4d)
  - [ ] 5.1 `packages/api`：Fastify + `POST /v1/turns`（同步/`?async=1`）+ signed-token 鉴权（平移 `qm/src/auth/`）~3h
  - [ ] 5.2 cordis.yml 组装全链路 profile ~1h
  - [ ] 5.3 端到端：HTTP → run 队列 → orchestrator → mock harness → 回复；起服冒烟 ~2h
  - [ ] 5.4 【串行门验收】e2e 全绿；打 tag `m1` ~0.5h

### M2 IM 契约 + 飞书（1 提前 spike + 2 并行 + 汇合，~3d/墙钟 ~2d）

- [ ] 6.0 【B'·可提前至 M1 期间】飞书 SDK spike `packages/spike-feishu` ~0.5d (ai:0.3d test:0.2d)
  - > brief：独立 scratch 包，不依赖 qm-next 其他代码；验证 `@larksuiteoapi/node-sdk` WS 长连接（收事件/发消息/卡片回调三件事）；产出：可行性结论 + 最小示例；**此结论是 6.2 的输入**
  - [ ] 6.1 SDK 验证三件套 ~3h
  - [ ] 6.2 结论回写 PRD Open Question（SDK 选型定案）~0.5h
- [ ] 7.0 【串行门】`@qm/im-core` 契约冻结 ~0.5d (ai:0.4d test:0.1d)
  - [ ] 7.1 `InboundEvent` 判别联合 / `Destination{provider,chatId,threadId?}` / 出站操作（send/edit/delete/uploadFile/react 位保留）/ `Interaction` / `DirectorySync` / 格式管道接口；`ctx.im` 注册表；delivery 认领接口 ~3h
  - [ ] 7.2 主会话开并行 ~0.5h
- [ ] 8.0 【A】投递与注册表 core 侧 `packages/im-core` ~1d (ai:0.7d test:0.3d)
  - > brief：只写 `packages/im-core/`；平移 `qm/src/delivery/` 认领语义（claim/ack/重试）为通用 surface 版；参考 `dsh/packages/webhook/webhook` 的 register/dispatch 形状；验证：认领循环 + 重试 + 卸载排空单测
  - [ ] 8.1 渠道注册表 + 生命周期 ~2h
  - [ ] 8.2 delivery 认领循环（平移）~3h
  - [ ] 8.3 单测 ~2h
- [ ] 9.0 【B】`im-feishu` Provider `packages/im-feishu` ~1.5d (ai:1d test:0.5d)
  - > brief：只写 `packages/im-feishu/`；对 7.1 契约编程；接入复用 6.0 spike 结论；参考 `qm/src/slack/{events,turn-handler,deliveries,approvals,attachments,directory}.ts` 的能力映射（不是照抄，是对契约重实现）；验证：录制事件 fixture 回放 + 真机冒烟清单
  - [ ] 9.1 WS 长连接接入 + 事件映射 ~2h
  - [ ] 9.2 出站：线程回复/编辑/文件 ~3h
  - [ ] 9.3 审批卡片 + 回调校验 ~2h
  - [ ] 9.4 目录同步 + lark_md 格式 ~2h
  - [ ] 9.5 fixture 回放测试 ~2h
- [ ] 10.0 【汇合】真机冒烟 ~0.5d (ai:0.2d test:0.3d)
  - [ ] 10.1 飞书 @机器人 → 线程回复 ~1h
  - [ ] 10.2 审批卡片点击 → turn 恢复/终止 ~1h
  - [ ] 10.3 【串行门验收】M2 清单全过；打 tag `m2` ~0.5h

### M3 企业能力回归（5 包全并行，~3d/墙钟 ~2d）

- [ ] 11.0 【串行门】能力清单与包边界确认 ~2h
  - [ ] 11.1 对照 qm 功能清单划定 5 包范围与验收项 ~2h
- [ ] 12.0 【A1】approvals/ambient `packages/approvals` ~0.5d — brief：对 im-core `Interaction` 编程；参考 `qm/src/slack/{approvals,approval-cards}.ts` 语义
- [ ] 13.0 【A2】cron/triggers `packages/triggers` ~0.5d — brief：pg-boss 队列平移 `qm/src/cron/`；触发创建 turn
- [ ] 14.0 【B1】memory + skills `packages/{memory,skills}` ~0.5d — brief：平移 `qm/src/{memory,skills}/`，含 pg 与内存双实现
- [ ] 15.0 【B2】reach + directory `packages/{reach,directory}` ~0.5d — brief：destination 解析去 Slack 化；平移 `qm/src/{reach,directory}/`
- [ ] 16.0 【A3】web-ui 插件化 `packages/web-ui` ~1d — brief：`qm/plugins/web-ui` 迁为 cordis 插件（Lit SPA + SSE 保留）；admin 简版跟进
- [ ] 17.0 【汇合】M3 回归验收 ~1d (ai:0.3d test:0.7d)
  - [ ] 17.1 对照功能清单逐项回归 ~4h
  - [ ] 17.2 【串行门验收】打 tag `m3` ~0.5h

### M4 多平台 + 收尾（3 适配器并行，~1d/墙钟 ~1d）

- [ ] 18.0 【A】`im-slack`：qm `src/slack/` 按契约改造（mrkdwn/Socket Mode/Block Kit → Interaction）~0.5d
- [ ] 19.0 【B】`im-dingtalk` Stream 模式起步（可选）~0.5d
- [ ] 20.0 双渠道并存验收 ~2h
  - [ ] 20.1 同一核心飞书 + Slack 并存运行 ~2h
- [ ] 21.0 收尾 ~0.5d (ai:0.3d test:0.2d)
  - [ ] 21.1 CI grep 门禁：core services 无 `slack|feishu|lark|wecom|dingtalk` 符号 ~1h
  - [ ] 21.2 README/架构文档/CHANGELOG ~2h
  - [ ] 21.3 最终验收 + tag `v0.1.0` ~0.5h

## Time Tracking

| 阶段 | 估算 | 墙钟（双 agent） | 实际 |
|------|------|------------------|------|
| M0 基座（串行） | 1d | 1d | - |
| M1 核心回路 | 3d | ~2d | - |
| M2 IM 契约 + 飞书 | 3d | ~2d | - |
| M3 企业回归 | 3d | ~2d | - |
| M4 多平台 + 收尾 | 1d | 1d | - |
| **合计** | **~11d** | **~7-8d** | - |

## Completion Checklist

- [ ] 全部任务勾选
- [ ] M1/M2/M3 串行门验收全过（e2e、真机、功能清单）
- [ ] 双渠道并存运行
- [ ] CI 门禁（IM 符号隔离）生效
- [ ] 文档与 CHANGELOG 更新
- [ ] 时间实际值回填
