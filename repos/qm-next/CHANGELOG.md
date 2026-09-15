# Changelog

qm-next 的全部显著变更记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-13

首个里程碑版本：M0-M4 交付。Cordis 全插件重写 qm，IM 一等插件化，
**v1 渠道只做飞书**（2026-09-13 用户拍板：slack/钉钉/企微延期）。

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

### M4 收尾

- 审批卡渲染下沉 provider：`ImProvider.approvalCardRenderer?`（契约
  additive 增补）；im-bridge 解析链 = 注入覆盖 → provider 自带 → 中性
  文本兜底，内置 lark 卡移除（M3 遗留清零）。
- IM 符号隔离门禁：`pnpm check:im` —— core 服务 src/ 零
  `slack|feishu|lark|wecom|dingtalk` 符号（顺手移除 web-ui
  `MeWire.slackWorkspaceUrl` 残留耦合）。
- README/架构文档对齐实况；CHANGELOG 建立。
- 范围决策（2026-09-13）：v1 只做飞书。im-slack 实现移出包集（完整实现
  存 git 历史 `d7d2db3`，可按 `ImProvider` 契约复活）；双渠道真机验收
  （原 20.0）随范围延期；钉钉/企微延期。

### 验证基线

- `pnpm typecheck` 绿；`pnpm rescope-check` / `pnpm check:im` OK。
- 无 PG 套件全绿（0 fail，PG 用例按需 skip）；
  `pnpm test:pg` 一次性容器全量对拍全过。
- 真机：飞书全链路三腿通过（M2 冒烟 + M3 e2e）。

## [Unreleased] - P1-P4 长尾对齐（qm-parity p002，2026-09-13 → 2026-09-15）

qm-parity p002 在 v0.1.0 基础上对齐 qm 全功能面，tag `p1`/`p2`/`p3`/`p4`
顺次封口。本节是 P1-P4 全部新增的累计速览（详见
`todo/tasks/tasks-qm-parity.md` 与 `docs/parity-deviations.md` 偏差表）。

### P1 真引擎回路（tag `p1`）

- `@qm/credentials`：keychain / secret-cipher / DurableMap→`@qm/store`
  / secret-source / harness-auth-env / connector-token / device-flow /
  resident-auth；memory + PG 双实现，PG 强制生产路径。
- `@qm/model`：catalog / pi-models / provider-endpoints /
  custom-providers / gateway / subscription-oauth / model-credential-store
  / user-model-credential-store；cli token 端点参数注入平移。
- `@qm/sandbox`：local-sandbox 全量（docker-exec / exec-process-session
  / ro-layers / exec-file-ops / exec-kill / sandbox-env / process-poll /
  await-exit），per-scope handle 缓存 + dispose teardown。
- `@qm/harness-pi`：pi-harness（2190L）+ pi-tools（3097L）+
  共享件（tape-fold / replay / context-compaction / goal / grind）。
- `@qm/api` v1：`POST /v1/turns`（同步 + `?async=1`）+ signed-token 鉴权 +
  TurnRunner 认领循环。
- 飞书真任务对拍通过（@机器人 → 编码任务 → in-thread 回复）。

### P2 多引擎 + runs 深化（tag `p2`）

- `@qm/harness-claude`（claude-agent-sdk 0.3.211）、`@qm/harness-codex`
  （@openai/codex 0.144.5 + app-server + subscription auth）、
  `@qm/harness-opencode`（opencode-ai 1.17.18 sidecar + HTTP 工具桥 +
  plugin）。
- `@qm/runs`：worker / reaper / drain / task-protection /
  session-state-bus / run-activity-store / run-signal-store /
  instance-registry / turn-stream；memory + PG 双实现，信号契约上移
  `@qm/types`。
- orchestrator harness-router：per-surface / per-model 引擎路由 +
  qm 阶梯（approved / default / per-scope）+ 注册表级 `resolveChoice`。

### P3 API 面与控制台（tag `p3`）

- `@qm/api` routes 平移 ~196/242 条（admin 58 / surface 47 /
  deployments 13+3 / turns 12 / keychain 11 / memory 8 / skills 6 /
  blobs+webhook deliveries raw 路由 + 各种 surface 后端）。
- `@qm/admin`：grant store + service qm 阶梯 + personKey + scoped-event-sink
  + metrics / error-log / credential-usage / egress-audit / audit-log
  memory+PG + retention / attribution / users / invite-email。
- `@qm/auth`：signed-token / capability-token / replay-dedupe memory+PG
  / source-auth / aws-role-broker STS / portal-identity。
- `@qm/portal`：session/tmp HMAC 封印 cookie（域分离密钥）+ OIDC code+PKCE
  + 5 分钟单次 admin-login link + loopback dev bypass。
- web-ui stub 后端化：12 域中继（search / files / blobs / playground /
  webhooks / connectors / user-model-auth / keychain / memory /
  deployments / scope-resources / approvals）+ per-user 60s bearer +
  principal 走 portal-identity 头或 dev cookie。
- admin 控制台 SPA 576KB 字节级平移到 `packages/api/admin-ui/`，
  `/admin/ui` 挂 CSP-hash / etag / gzip shell + 进程内 inject 代理到
  `/v1/admin/*`。

### P4 长尾子系统 + M3 砍除项回填（tag `p4`）

- IM 域回填：ambient 真模型 judge + cursors + judgments（memory+PG）、
  reaction-as-ack（feishu `react` 位落地）、agent-request directives
  （`[[ask-agent: id | task]]` + DM 审批卡 + 桥交付）、consent
  （recipient consent 三纯函数 + CronStore JSONB ALTER）、
  keychain-ask（ask sweep 把已决议 ask 跑成 DM personal turn）、
  edit-notice（sha256 指纹去重 + notifyOwnerOfCronEdit）、
  provenance（DeliveryOrigin extension + fire 引擎盖章 +
  `/v1/admin/deliveries/shadow`）。
- 完整化（`@qm/{memory,skills,reach,directory}` 增量）：
  - `@qm/memory` strategy modes（per-turn / consolidation /
    agent-only / scratch-promote） + memorable relay + provider routing。
  - `@qm/skills` 完整生命周期：HMAC manifest / safeSkillFilePath /
    materialize（Sandbox 端口 + MaterializationLock）/ pack-fetcher
    （q-full git fetcher + isPrivateNetworkIp SSRF 卫 + 密钥 scrub）
    / skill-sync-engine（leader-leased sweeper + tracked/pinned 双模）。
  - `@qm/directory` personKey / samePerson + reach `openGroup` /
    `registerGroup` + `ReachOpts.mayOpenGroup` + group 流程
    "needs someone besides you" 400 + `502 group_open_failed` 阶梯。
- 长尾子系统（11 tranches）：
  - `@qm/mcp`（client / server-store / tool-service +
    `/v1/admin/mcp-servers` + memory mcp provider）
  - `@qm/processes`（process-registry + reaper + reconcile +
    leader-lease，pg_advisory_xact_lock + assertOneStatement 守门）
  - `@qm/insights`（reach-denied-notifier 含 ReachDeniedLeaderLease）
  - `@qm/tasks`（task-store + memory-task-store + postgres-task-store；
    9 条 DDL 含 sessions FK DO 块）
  - `@qm/acl`（resource-ref 5 种 kind 编解码 + acl-store +
    postgres-grant-store，`acl_grants_version` 增量表 + trigger +
    advisory lock）
  - `@qm/monitors`（monitor-store + broker + compileMonitorPattern +
    readBackgroundOutputTail；poller 延到 triggers 表面落地）
  - `@qm/security`（security-posture + security-screener chunked +
    retry + shadow cap）
  - `@qm/egress-authz`（egress-policy parse + suffix 匹配 +
    egress-authz-server cap token + DNS rebinding 卫 + audit +
    isPrivateNetworkIp loopback / RFC1918 / CGNAT / link-local / ULA /
    multicast）
  - `@qm/connectors` core（background-exec-broker + oauth-flow-store
    43 字符 nonce + consent-link 24h ttl + browser-session-store
    AES-256-GCM + secret-envelope HKDF v2；oauth.ts 全 provider 集 +
    emoji-upload-service 延到 P5 IM 复活）
- 21 行 v0.1.0 OUT 项对账表入 `docs/parity-deviations.md` §P4 17.0；
  明确 P5 遗留（pg-boss / monitor-poller / oauth.ts / IM 多渠道）。

### P4 验证基线

- `pnpm typecheck` 绿；`pnpm test` 692/665 pass + 27 PG-skip + 0 fail；
  `pnpm test:pg` 751/747 pass + 4 real-model skip + 0 fail；
  `check:im` / `rescope-check` 全绿。
- 标签：`tag p1` → `tag p2` → `tag p3` → `tag p4` 顺次封口。

## [Unreleased] - P5 范围重整（2026-09-15）

slack / 钉钉 / 企微 **suspended**（v0.1.0 拍板延期项 18.0 / 19.0 / 20.0
正式关闭）。qm 替身目标下 v1 渠道只做飞书 + web 端双 surface：

- **slack 实现**：git 历史 `d7d2db3` 完整 im-slack 实现保留；按
  `ImProvider` 契约可在未来按需复活（mrkdwn / Block Kit / 目录分页）。
- **钉钉（Stream）+ 企微（回调）**：未动工；按 `ImProvider` 契约
  复用飞书通道测试矩阵重启。
- **双渠道真机验收**：随 slack/钉钉延期一并 suspended。

P5 重新洗牌为四条车道（详见 `todo/tasks/tasks-qm-parity.md` §P5）：

- 18.0 web 端深化（web-ui 真活 + portal SSO/admin-login link 真路径 +
  体验硬化）
- 19.0 数据迁移（关键路径；qm → qm-next PG 全表迁移器 + 演练 +
  回滚路径 + `docs/migration.md` runbook）
- 20.0 监控/合规/生产化（error-log/metrics/audit-log + 健康检查 +
  运维 runbook + PG snapshot 备份还原演练）
- 21.0 切换演练 + tag `v1.0.0`（灰度双跑 + blue-green + worker
  进程拆分）

时间预算 ~4d ai 总工作量不变；只是把"多渠道"时间挪到 web 深化 +
数据迁移 + 切换收束。

### P5 20.0 监控/合规/生产化（2026-09-15）

- **组合根 durable-by-default sweep**：`databaseUrl` 下 sessions/runs/
  directory/approvals/crons（含 PG leader lease）/投递队列全量选 PG twin；
  keychain、model、device-flow、mcp、connectors、webhooks 等 DurableMap
  族接 `createPostgresMap`（沿用 qm 表名，迁移即直拷），boot 时暖建表——
  空库启动一次即完成全量 schema 落地（迁移 runbook 第 3 步依赖）。
- **新 twin**：`@qm/im-core` `createPostgresDeliveryQueue`（SKIP LOCKED
  认领/租约/退避/park 与内存版同语义）；`@qm/api`
  `createPostgresChannelPolicyStore`（qm 同列 `channel_policy`+`_history`，
  set 即写历史）；`createPostgresFileStore`（`file_artifacts` qm 同列 DDL）
  + `@qm/store` `DurableByteStore`（内容寻址 `files/<sha256>`，local FS/
  memory 双后端，S3 延后）。
- **观测面**：admin sink 族（metrics/error/credential-usage/egress/audit）
  在 `databaseUrl` 下常开（不再依赖 admin flag）；`GET /readyz` 就绪探针
  （PG ping，down 返 503）；`GET /v1/admin/monitoring/summary` 监控面板
  占位（uptime/库态/队列耐久性/crons/错误与审计计数，admin 鉴权）。
- **C.3 收口**：tasks/acl/run-activity/run-signals/replay-dedupe 构造器
  随 `databaseUrl` 实例化，迁移 `--verify-only` 不再报告这些表。
- **运维**：`docs/operations.md`（启动/关闭/回滚/扩缩容/备份/迁移摘要 +
  20.0 拍板记录）；`pnpm rehearsal:backup`（快照→破坏→还原→行数断言
  演练，PASS）+ `scripts/pg-snapshot.sh` 生产快照工具。
- **迁移器**：`deliveries` 改 drain-check（切换前强制清空，行不携带）；
  `channel_policy(+history)`/`file_artifacts` 进 ENTITY_COPIES 直拷。
- **验证**：`pnpm test:pg` 全绿（新增 durable-wiring 端到端表清单断言、
  delivery-queue-pg 契约对拍）；备份还原演练 PASS。
