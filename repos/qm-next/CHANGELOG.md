# Changelog

qm-next 的全部显著变更记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-13

首个里程碑版本：M0-M4 全部交付。Cordis 全插件重写 qm，IM 一等插件化，
飞书首发、Slack 同级适配，同一核心双渠道并存。

### M0 基座

- vendor Cordis v4 内核 + loader/include/timer（rescope 为 `@qm/*`，
  `pnpm rescope-check` 门禁）。
- `cordis.yml` profile 启动：entries 挂载、`!!js` 插值、配置校验、
  typed events、`ctx.effect()` 可逆注册。

### M1 核心回路

- `@qm/types` 契约冻结（`TurnInput`/`TurnResult`/`Session`/`Run`/
  `Destination`，surface 全链路显式、无默认渠道）。
- `@qm/store`：sessions/runs 内存 + Postgres 双实现（`FOR UPDATE SKIP
  LOCKED` 认领、one-running-per-session、`pnpm test:pg` 一次性容器对拍）。
- `@qm/orchestrator`：qm handleTurn 平移（准入/会话解析/lease/harness
  路由/结果映射），mock harness 可脚本化。
- `@qm/api`：Fastify `POST /v1/turns`（同步 + `?async=1`）、signed-token
  鉴权（kid 轮换 + 遗留格式兼容）、TurnRunner 认领循环。

### M2 IM 契约 + 飞书

- `@qm/im-core`：`InboundEvent` 判别联合、出站操作（react/uploadFile 为
  保留位）、`ImProvider` 端口、渠道注册表（eventId 去重、卸载排空）、
  delivery 认领循环（TTL lease/退避/maxAttempts 停机）。
- `@qm/im-feishu`：`@larksuiteoapi/node-sdk` WS 长连接；线程回复/编辑/
  撤回/附件；审批卡片；`chat.list` 目录同步。
- `@qm/im-bridge`：入站 → run 队列（surface = provider）、终态 → 投递
  队列；飞书真机冒烟（@机器人 → 线程回复、审批卡片可点）。

### M3 企业能力回归

- `@qm/approvals`：审批持久化（memory/pg）、决策状态机（单次迁移/仅请求
  者/双击去重/pg 重启恢复）、审批值 codec、ambient 最小切片（策略存储 +
  judge 端口，bridge 分诊：@/私信人转、未寻址有策略走 judge、无策略丢弃）。
- `@qm/triggers`：cron/一次性触发（croner 5 段 + IANA 时区、原子槽位租
  约、leader lease、fire log、directory 可见性投递门、one-shot 自动
  disable）。
- `@qm/memory` / `@qm/skills`：作用域记忆（CAS/折叠/裁剪）与技能注册表
  （scope 链解析/遮蔽），memory/skills resolution 注入缝。
- `@qm/reach` / `@qm/directory`：destination 解析（recipient/channel/
  group 三选一、可见性/成员校验）与目录镜像（单写路径/陈旧守卫/撤销语义）。
- `@qm/web-ui`：Lit SPA 整包平移 + 薄 cordis 插件 server（静态 + 深链
  回退、dev principal、turn/runs 代理、SSE run-events 翻译、skills/
  crons/contexts live 视图）。
- 真机飞书 e2e 三腿通过（卡片审批、ambient 真频道、cron fire 真投递）。

### M4 多平台 + 收尾

- `@qm/im-slack`：`@slack/socket-mode` WS 入站（免公网回调）+
  `@slack/web-api` 出站；app_mention/DM/群消息诚实寻址（分诊归 core）、
  block_actions 交互（JSON 审批值往返）、reactions、bot 加入生命周期、
  own-bot 回环守卫；mrkdwn 格式管道（自 qm 平移）；Block Kit 审批卡；
  users/conversations 分页目录同步。
- 审批卡渲染下沉 provider：`ImProvider.approvalCardRenderer?`（M4 契约
  增补）；im-bridge 解析 注入覆盖 → provider 自带 → 中性文本兜底，
  内置 lark 卡移除。
- 双渠道并存（20.1）：一个 registry + 一个 bridge 同时挂 feishu/slack
  真实 provider 的集成测试（回复按渠道回流、审批卡各用各的形状、双渠道
  点击均可恢复 turn）；`profiles/multi-im.yml` 真机档。
- IM 符号隔离门禁（21.1）：`pnpm check:im` —— core 服务 src/ 零
  `slack|feishu|lark|wecom|dingtalk` 符号（顺手移除 web-ui
  `MeWire.slackWorkspaceUrl` 残留耦合）。

### 验证基线

- `pnpm typecheck` 绿；`pnpm rescope-check` / `pnpm check:im` OK。
- 无 PG 套件 220 tests / 210 pass / 10 PG skip / 0 fail；
  `pnpm test:pg` 一次性容器全量对拍（M3 验收时 239/239）。
- 真机：飞书全链路三腿通过；双渠道真机验收待 Slack 应用凭据
  （`profiles/multi-im.yml` 就绪）。
