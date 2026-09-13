# Tasks: qm-next — Cordis 重写 + 飞书 IM 适配层

Based on [ai-dev-tasks](https://github.com/snarktank/ai-dev-tasks) task format, with time tracking.

**PRD:** [prd-qm-next.md](prd-qm-next.md)
**Created:** 2026-09-12
**Status:** In Progress（M0/M1 done，M2 进行中）
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
  - [x] 1.1 创建 `repos/qm-next`：pnpm workspace（`vendor/*` + `packages/*/*`）、`tsconfig.base.json`（strict、NodeNext、ESM）、`.gitignore`、README ~1h
    - 位置决策（用户拍板）：**选项 1，随 aa 走**——qm-next 为 aa tracked 子树，worktree 开发 + 用户 FF 合并；`.gitignore` 已改 `repos/*` + `!repos/qm-next`
    - 架构文档已落 `repos/qm-next/docs/architecture.md`
  - [x] 1.2 vendor 拷贝 6 包：`cosmokit`、`schemastery`、`cordis`、`loader`、`include`、`timer`（自 dsh `vendor/`）；group/hmr/logger-console 暂缓 ~0.5h
  - [x] 1.3 rescope：`@deepseek-ai` → `@qm`（25 文件，残留 0，`scripts/rescope-check.sh` 门禁）；映射与本地改动记录于 `vendor/README.md` ~1h
  - [x] 1.4 构建：`scripts/build-vendor.sh`（`tsc -b` → `lib/types` + JS 同步 `lib/`）；schemastery 入口改 ESM-only；构建通过，`Context`/`Service` node 加载验证通过 ~1h
  - [x] 1.5 冒烟测试：插件挂载/卸载、`inject` 等待、Config 校验、五种事件派发（emit/waterfall/parallel/serial/bail）、`ctx.effect()` 可逆 ~2h
    - 落地：`packages/demo`（Demo Service + schemastery Config）、`packages/boot`（`bootProfile`）、`packages/boot/tests/kernel.test.ts`（11 用例）全绿
    - 已核实 API：Service 构造器自动 `ctx.reflect.provide` 注册；Config 经 `runtime.Config['~standard'].validate` 校验（schemastery 兼容标准 schema）；`FiberState` 是 const enum（运行时无导出，测试用字面量）
  - [x] 1.6 `cordis.yml` profile 启动：bootstrap + loader/include 加载，含 `!!js` 配置插值用例 ~2h
    - 落地：`packages/boot/src/index.ts`（模板 `vendor/cordis/bin.js`，include 入口固定 id `include`）、`profiles/cordis.yml`、`packages/boot/tests/profile.test.ts`（4 用例：挂载/插值/坏导入/仓库 profile）全绿
    - 关键语义：profile entries 挂在 include 嵌套 tree（id `include:<entry-id>`）；卸载 `include` 入口级联清理；根 devDeps 需 `@qm/demo`/`@qm/cordis-plugin-include`（baseUrl 从根解析）
  - [x] 1.7 【串行门验收】`pnpm test` 全绿 + profile 启停通过；打 tag `m0` ~0.5h
    - 测试全绿（15/15）；tag `m0` 已打（main `3e28813`）

### M1 核心回路（1 串行门 + 2 并行 + 汇合，~3d/墙钟 ~2d）

- [x] 2.0 【串行门】契约冻结 ~0.5d (ai:0.4d test:0.1d)
  - [x] 2.1 定义 `packages/types`：`TurnInput`/`TurnResult`/`Session`/`Run`/`Destination{type:string}`（surface 显式，无默认值）；store 接口（enqueue/claim/heartbeat/complete/fail）；orchestrator 输入输出；提交冻结 ~2h
    - 落地（`feature/qm-next-m1` `579da02`）：`packages/types` 10 模块；surface 必填、`Destination.threadId` 替代 threadTs、Slack 符号零残留；`SessionStore` 冻结为 qm 的 M1 子集（tape/LLM 记录/搜索归 M3 增量）
    - 顺带补齐根 `tsconfig.json` 严格 typecheck 门禁（M0 从未真正跑过 tsc）并修复暴露的 boot/test/rescope-check 违规
  - [x] 2.2 主会话执行 `pnpm install`，开并行 ~0.5h
    - worker 池额度耗尽（rpm/entitlement exhausted），降级为主会话串行双车道；每车道独立 worktree（`feature/qm-next-m1-lane-{a,b}`）避免并发 tsc/test 干扰
- [x] 3.0 【A】存储层 `packages/store` ~1d (ai:0.7d test:0.3d)
  - [x] 3.1 内存实现（Map 版 store）~2h
  - [x] 3.2 Postgres 实现（平移 qm schema）~3h
  - [x] 3.3 对拍测试 + 并发语义测试 ~2h
    - 落地（`4789e36`）：13 用例 ×2 实现对拍；PG claim 用 `FOR UPDATE SKIP LOCKED` + one-running-per-session 部分唯一索引；`QM_NEXT_PG_URL` 可达才跑 PG 用例否则 skip
- [x] 4.0 【B】编排层 `packages/orchestrator` ~1d (ai:0.7d test:0.3d)
  - [x] 4.1 orchestrator Service 化（平移 + 去 Slack 化）~3h
  - [x] 4.2 harness router + mock harness ~2h
  - [x] 4.3 回路单测（含限流/预算/会话解析）~2h
    - 落地（lane-b `c9f8eee`）：`OrchestratorService`（准入→会话解析→lease→entries→harness→映射）、`createHarnessRouter`、可脚本化 `createMockHarness`；23 用例全绿
- [x] 汇合预检（`ce64893`+`9be63c8`）：lockfile 冲突按预期出现并重装解决；合并树 typecheck + 53/53 全绿（含一次性 PG 容器真实对拍）
- [x] 5.0 【汇合】API 插件与端到端 ~1d (ai:0.6d test:0.4d)
  - [x] 5.1 `packages/api`：Fastify + `POST /v1/turns`（同步/`?async=1`）+ signed-token 鉴权（平移 `qm/src/auth/`）~3h
    - 落地：`packages/api`（signed-token 平移含遗留 hmac 格式与 kid 轮换、bearer→Principal、`POST /v1/turns`、`GET /v1/runs/:id`、`GET /healthz`、TurnRunner claim 循环、ApiService 组合根：memory store + mock harness + dev 准入默认）；`c0cffe6`
  - [x] 5.2 cordis.yml 组装全链路 profile ~1h
    - 落地：profile 增 `@qm/api` 入口（port 0 + dev secret）；根 devDeps 增 `@qm/api`（loader 从根解析）；`171b55d`
  - [x] 5.3 端到端：HTTP → run 队列 → orchestrator → mock harness → 回复；起服冒烟 ~2h
    - 证据：api 包 7 用例（token 轮换/篡改/遗留格式/过期、401/400/403、sync 200+entries、async 202→runner→done）；profile 测试真实起服走通 sync+async 全链（202→GET run→done+回复）；typecheck 绿；60/60 全绿（含真 PG 对拍，容器一次性）
  - [x] 5.4 【串行门验收】e2e 全绿；打 tag `m1` ~0.5h
    - 测试已全绿；待用户终端 `git merge --ff-only feature/qm-next-m1` 后打 tag `m1`

### M2 IM 契约 + 飞书（1 提前 spike + 2 并行 + 汇合，~3d/墙钟 ~2d）

- [x] 6.0 【B'·可提前至 M1 期间】飞书 SDK spike `packages/spike-feishu` ~0.5d (ai:0.3d test:0.2d)
  - > brief：独立 scratch 包，不依赖 qm-next 其他代码；验证 `@larksuiteoapi/node-sdk` WS 长连接（收事件/发消息/卡片回调三件事）；产出：可行性结论 + 最小示例；**此结论是 6.2 的输入**
  - [x] 6.1 SDK 验证三件套 ~3h
    - 落地（spike/feishu-sdk `1d5bcf5`）：worker 池仍 entitlement exhausted，主会话执行；SDK **v1.73.3** 高层 `createLarkChannel`（WS 传输）三件套类型面+实现面全验证：收事件（自动重连/ping 看门狗/getConnectionStatus 五态）、发消息（send/stream/edit/recall + replyTo/replyInThread + file=image uploadFile 位）、卡片回调（`card.action.trigger` 经 WS 可达 + 内置去重 + updateCard 回写）；离线 surface 冒烟 15/15 PASS + strict typecheck 绿；真连三脚本就绪待凭据
  - [x] 6.2 结论回写 PRD Open Question（SDK 选型定案）~0.5h
    - 结论：**用 SDK，不直连 OpenAPI**；流式回复/准入策略/SSRF 防护可白嫖；坑：卡片回调须应用侧改"长连接接收"、editMessage 仅 text/post、流式滚卡要跟新 messageId；详见 `packages/spike-feishu/README.md`
- [x] 7.0 【串行门】`@qm/im-core` 契约冻结 ~0.5d (ai:0.4d test:0.1d)
  - [x] 7.1 `InboundEvent` 判别联合 / `Destination{provider,chatId,threadId?}` / 出站操作（send/edit/delete/uploadFile/react 位保留）/ `Interaction` / `DirectorySync` / 格式管道接口；`ctx.im` 注册表；delivery 认领接口 ~3h
    - 落地（feature/qm-next-m2 `85b2325`+`2465fde`）：`packages/im-core` 7 契约模块。决策：`Destination` 复用 `@qm/types`（`type`=provider、`target`=chatId，不造双形状）；出站与队列同形状（队列直接携带 `OutboundOperation`）；卡片载荷 opaque；`register` 改 async（intake live 后 resolve）；`fail` 增 `park` 终态。typecheck 绿 + 全测绿后提交
  - [x] 7.2 主会话开并行 ~0.5h
    - worker 池仍 entitlement exhausted → 降级主会话串行（spike → 7.1 → 8.0 → 9.0），spike 分支已并入 m2
- [x] 8.0 【A】投递与注册表 core 侧 `packages/im-core` ~1d (ai:0.7d test:0.3d)
  - > brief：只写 `packages/im-core/`；平移 `qm/src/delivery/` 认领语义（claim/ack/重试）为通用 surface 版；参考 `dsh/packages/webhook/webhook` 的 register/dispatch 形状；验证：认领循环 + 重试 + 卸载排空单测
  - [x] 8.1 渠道注册表 + 生命周期 ~2h
    - 落地（`9ce0fb4`）：`createImRegistry`（validate/start/abort 排空/eventId 去重/幂等 disposer）+ `ImRegistryService`（ctx.im，fiber dispose 排空）
  - [x] 8.2 delivery 认领循环（平移）~3h
    - 落地：`createMemoryDeliveryQueue`（幂等 enqueue/TTL lease/ack/fail+retryInMs/park）+ `createDeliveryLoop`（enqueue 唤醒 + tick、指数退避、maxAttempts 停机、stop 排空）
  - [x] 8.3 单测 ~2h
    - 落地：16 用例（registry 6 + queue 5 + loop 5），覆盖认领循环/退避重试/终态停机/卸载排空；全仓 61 pass + 2 PG skip
- [x] 9.0 【B】`im-feishu` Provider `packages/im-feishu` ~1.5d (ai:1d test:0.5d)
  - > brief：只写 `packages/im-feishu/`；对 7.1 契约编程；接入复用 6.0 spike 结论；参考 `qm/src/slack/{events,turn-handler,deliveries,approvals,attachments,directory}.ts` 的能力映射（不是照抄，是对契约重实现）；验证：录制事件 fixture 回放 + 真机冒烟清单
  - [x] 9.1 WS 长连接接入 + 事件映射 ~2h
    - 落地（`fbf6601`）：`createFeishuProvider` 包 `createLarkChannel`（WS 传输，pingTimeout/handshakeTimeout/includeRawEvent）；`createInboundMapper` 纯函数映射 message/cardAction/reaction/botAdded → InboundEvent，event_id 提取内聚于 mapper（raw 优先，`msg:<id>:<ts>` 兜底）
  - [x] 9.2 出站：线程回复/编辑/文件 ~3h
    - 落地：replyToMessageId/threadId → `replyInThread` 线程回复；text/markdown/card → send；edit → editMessage（text）+ updateCard（card）；delete → recallMessage；附件经 ImBlobs.read 字节 → image/file 消息（receipt 指向最后一条）
  - [x] 9.3 审批卡片 + 回调校验 ~2h
    - 落地：审批卡出站走 OutboundBody.card（opaque）；cardAction `action.value` 原样往返（approve/reject + runId）；回调校验由 config verificationToken/encryptKey 注入 channel（spike：card.action.trigger 经 WS + 内置点击去重）
  - [x] 9.4 目录同步 + lark_md 格式 ~2h
    - 落地：`collectDirectory()` 经 rawClient chat.list 分页拉 spaces 快照（dm/group/external）；格式管道 `format()` 透传 markdown，channel builtin converter 转 lark 格式；react/uploadFile 为保留位，抛 `IM_UNSUPPORTED_OP`
  - [x] 9.5 fixture 回放测试 ~2h
    - 落地：10 用例——canned SDK fixture 经捕获的 channel handler 走真实线路到 emit；出站对录 mock channel 断言（含线程 opts、blob 读、sentinel 码）；全仓 73 tests / 71 pass / 2 PG skip
- [x] 10.0 【汇合】真机冒烟 ~0.5d (ai:0.2d test:0.3d)
  - [x] 10.0a 汇合接线 ~2h — 落地（feature/auto-20260912-225137 `ac7a2e0`）：`packages/im-bridge`（`ImTurnBridgeService`：持有 ctx.im 注册表 + 内存 delivery 队列 + claim loop；inbound message/interaction → 会话解析 → run 入队并保留回复路由；run 终态 → ok 回复/失败/拒绝/待审批卡投递；审批按钮 `qm.approval.v1` 值往返，卡片为 12.0 前占位）。`@qm/api` 暴露 runs/sessions/resolution/orchestrator；`im-feishu` 增 `FeishuProviderService`（start 注册进 ctx.im / dispose 注销）；主 profile 挂 im-bridge；`profiles/im-smoke.yml` 为真机 profile（凭据走 `!!js` env）。全仓 83 tests / 81 pass / 2 PG skip，typecheck 绿
  - [x] 10.1 飞书 @机器人 → 线程回复 ~1h
    - 通过（2026-09-12 真机）：@机器人 → 线程内收到 `smoke 10.1 echo: thread reply is live`（用户客户端实测确认）
  - [x] 10.2 审批卡片点击 → turn 恢复/终止 ~1h
    - 通过（2026-09-12 真机）：第二条消息触发 Approval needed 卡片（smoke-approve），Approve/Reject 点击均收到对应 `echo: ...: smoke-approve` 回复（用户客户端实测确认）
  - [x] 10.3 【串行门验收】M2 清单全过；打 tag `m2` ~0.5h
    - M2 清单全过；tag `m2` 已由用户在合并时打上。遗留改进（不阻塞）：boot-im-smoke.ts 的 stdout 经 pnpm 管道缓冲，SIGTERM 后日志丢失——后续重跑前加文件落盘；发现并修复 im-feishu SDK domain 需完整 URL（`4b5fcff`，此前 fixture 测试注入 channelFactory 未覆盖 default factory）

### M3 企业能力回归（5 包全并行，~3d/墙钟 ~2d）

- [x] 11.0 【串行门】能力清单与包边界确认 ~2h
  - [x] 11.1 对照 qm 功能清单划定 5 包范围与验收项 ~2h
    - 草案落地：`repos/qm-next/docs/m3-scope.md`（qm 各子系统源点清单、5 包 IN/OUT 边界、验收项、车道依赖序）
  - [x] 11.2 门禁确认（用户拍板，2026-09-13）：①审批 pg 恢复进 M3（恢复=耐久决策+携带 approval 的后续 turn，harness 侧 pause/resume 随 real harness 包）；②ambient 保留最小切片（策略存储+judge 端口，judge 模型砍除）；③skills 仅注册表+查找；④web-ui 修正为对话 surface（SPA 整包平移+server 重写+SSE，评估 ~1.5-2d）；⑤`pnpm test:pg` 容器对拍在串行门/17.0/M4 强制
  - [x] 11.3 冻结横切契约：`RunEventBus`（`packages/types/src/run-events.ts`）+ 内存实现（`packages/store`）+ `OrchestratorDeps.runEvents` 可选依赖接线（delta/progress/status 全链路，向后兼容）；`DirectoryStore` 契约由 15.0 首提交冻结（13.0/web-ui 消费方开道前就位）；其余包端口由各车道首提交冻结
- [x] 12.0 【A1】approvals/ambient `packages/approvals` ~0.5d — brief：对 im-core `Interaction` 编程；参考 `qm/src/slack/{approvals,approval-cards}.ts` 语义
  - 落地（feature/auto-20260912-225137 `d054dd2`/`81e2c46`/`fde8150`）：首提交冻结契约（`ApprovalStore` 端口 + 决策状态机 pending→approved/rejected + `ApprovalActionValue` 编解码 + `ApprovalCardRenderer` 端口 + ambient 端口族：`ChannelPolicyStore`/`AmbientJudge`/`AmbientService`）；memory/pg 双实现（keep-first record、单次迁移 decide、pg 条件 UPDATE 去重、重启恢复实测）；im-bridge 接线（pending 先入库再发卡、非请求者/过期点击回通知、二次点击去重、ambient 挂非提及消息、卡片渲染可注入）。验证：全仓 102 tests / 98 pass / 4 PG skip + 一次性 PG16 容器对拍 123/123 全过（含重启恢复用例）。遗留：bridge 内置卡片仍含 `lark_md`（M4 各 provider 自带 renderer 时移除，21.1 门禁前必须清）；`run:pg` 测试脚本与 `test:pg` 命令在 17.0 固化
- [x] 13.0 【A2】cron/triggers `packages/triggers` ~0.5d — brief：pg-boss 队列平移 `qm/src/cron/`；触发创建 turn
  - 落地（feature/auto-20260912-225137 `04259ea`）：首提交冻结契约——`CronStore` 端口（CRUD + `due(now)` + `claimSlot`/`unclaimSlot` 原子槽位租约 + `markAttempted` + fire log `recordFire`/`getFires` keep-first merge）+ `LeaderLease` 端口 + 纯 schedule 数学（`normalizeSchedule`/`recoverNextFireAt` 重启恢复/`advanceNextFireAt`，croner 5 段 + IANA 时区；everyMs≥24h 拒绝）+ `TriggerSink` 端口（`fire(key, …)` → turn）。实现：memory/pg 双 store（pg `claimSlot` 单条条件 UPDATE 守住全部可恢复槽位入参，并发只赢一个；fire log `(cron_id, fire_key)` 主键 merge；create 内容哈希去重按 raw schedule，不含时钟推导的 firstFireAt）+ memory/pg 双 lease（pg advisory lock 独占连接）+ fire engine（fire→run 队列：`origin: {kind:'automation'}`、surface `cron`/`trigger`、每 fire 独立线程 threadRef、`dedupKey=fireKey`、`background: true`；终态→fire log 记录 + reply 截断 2000 + 送 IM delivery 队列，`idempotencyKey=cron-fire:{fireKey}`；pending_approval fail-closed 不投递）+ scheduler（`lease.hold('cron:scheduler:tick')` tick 租约、`maxFiresPerTick` 按 `lastAttemptAt` 截流、one-shot fire 后自动 disable、owner 非 internal → disable 不占槽、`runNow` 手动键不消费槽位；job-queue/consent/provenance 按 11.0 边界 OUT）+ DirectoryStore 消费（frozen `@qm/directory` 的 `getSpace`+`isVisible` 投递前可见性门：私有/外部空间 owner 非成员 → reply 不投递并记 note；roster 缺失 fail-open）。验证：单包 30 tests 全过 + 全仓 typecheck 绿 + 一次性 PG16 容器对拍 186/186 全过（含 pg 并发 claimSlot 串行化、fire log 跨重启）。web-ui crons 视图可消费 `CronStore`
- [x] 14.0 【B1】memory + skills `packages/{memory,skills}` ~0.5d — brief：平移 `qm/src/{memory,skills}/`，含 pg 与内存双实现
  - 落地（feature/auto-20260912-225137 `631fea8`）：memory 包冻结 `ScopeMemory` 端口（head/get/replace/`replaceIfRevision` CAS、append 折叠含 untrusted 来源改写 + 300 条上限裁最旧、recall-by-bullets 尾部截断、query、history/restore、updatedAt/metadata），进程内 + postgres 双实现（per-scope advisory lock 事务，revision 令牌统一为单调 seq 字符串，'0' = 空作用域）；skills 包冻结 `SkillStore` 端口（注册表+查找：安全名文法平移、同 scope published 同名碰撞在 pg 侧由 partial unique index 保证、有序 scope 链 resolve/visibleFor 就近遮蔽、publish/archive/recordUse），进程内 + postgres 双实现。两包各带 resolution 注入缝（`wrapResolutionWithMemory` 回忆块 `## What you remember` + `wrapResolutionWithSkills` 技能索引 `## Skills` 追加进 systemPrompt，均 fail-open）——16.0 web-ui 与 17.0 组合根可直接包一层。strategy 模式/memorable relay/pack 摄取/sync 引擎按 11.0 边界 OUT。验证：typecheck 绿 + rescope-check OK + 无 PG 全仓 179 tests/169 pass/10 skip + 一次性 PG16 容器对拍 233/233 全过（含 memory/skills 全套 pg parity 用例与跨实现收敛断言）。注：qm append 的 added 计数在溢出时如实上报（310）而存储裁到 300，query 返回带日期前缀的 bullet 原文——均为 qm 原语义平移
- [x] 15.0 【B2】reach + directory `packages/{reach,directory}` ~0.5d — brief：destination 解析去 Slack 化；平移 `qm/src/{reach,directory}/`
  - 落地（feature/auto-20260912-225137 `e00185e`/`4c54bfe`/`f7e3266`）：首提交冻结双契约——`DirectoryStore` 端口（`apply(DirectorySyncPush)` 单写路径：按 section 陈旧守卫 + upsert + `replace` 撤销语义；provider 域内 people/spaces/spaceMembers 三表合一；`resolvePerson`/`resolveSpace`/`spaceMemberIds`（roster 未知返回 undefined）/`resolveGroupByParticipants`/`listVisibleSpaces`）+ 纯函数 `pickMatch`/`normDirectoryQuery`/`isVisible`（结构切片，reach 直用）；reach 契约 `ReachTarget`（recipient/channel/participants 三选一）→ `ReachResolution`（recipient→principal 目的地、channel/group→provider 目的地 + 成员校验/可见性过滤/identity_unverified 区分；openGroup 写回 OUT→group_not_found）。实现：共享 `applyPush` 驱动 + memory/pg 各自薄表适配（parity by construction），pg `apply` 单事务。验证：单包 17 tests（15 过/2 PG skip）+ 全仓 119/113/6 skip + 一次性 PG16 容器对拍 148/148 全过（含 roster 跨重启）。13.0/web-ui 现可消费已冻结的 `DirectoryStore`
- [x] 16.0 【A3】web-ui 插件化 `packages/web-ui` ~1.5-2d — brief（11.2 修订）：qm `plugins/web-ui` 的 Lit SPA 整包平移（含 pi-web-ui/pi-agent-core 依赖），server 半重写为薄 cordis 插件（挂 dist + principal cookie + turns/runs 代理 + SSE run-events 端点读 `ctx.api.runEvents`）；skills/crons/contexts 视图接 M3 真后端，webhooks/files/connectors/deploys stub 空态；绑 127.0.0.1 无鉴权（admin 简版跟进）
  - 落地（feature/auto-20260912-225137 `6446a8d`）：SPA 66 文件整包平移至 `packages/web-ui/app/`（字节级不变；`chassis/src/errors.ts` 按相对路径 vendored，core-bridge 零改动）；server 半重写为 fastify `WebUiService`（`static inject = ['api']`，消费 `ctx.api` 的 orchestrator/sessions/runs/resolution/runEvents）：静态 dist-web + SPA 深链回退、dev principal cookie（signin/signout/me，permissions 数组含 admin）、`POST /api/turn` 落 run 队列（threadRef `web:${user}:*` 守卫、channel:/group: scope → ch:/g: 会话、clientTurnId → dedupKey）、`/api/runs/:id` RunPoll 映射 + withdraw + active、SSE `/api/runs/:id/events` 翻译冻结 `RunEventBus`（先订阅后 replay 按 seq 去重、delta→partial 累积帧、progress→alive、终态→done 帧 + 心跳注释）；live 视图：skills（SkillStore visibleFor/注册/更新/归档恢复/删除，碰撞→409）、crons（CronStore 列表/patch task→action/enable/disable/run-now 走 createFireEngine + manualFireKey + fire log/runs 分页/删除）、contexts（DirectoryStore visible spaces + personal 上下文）；stub 空态：files/webhooks/deployments/connectors/keychain/user-model-auth/search/memory（GET 空 + POST 501）/blobs/fork 501；ui-state 内存 Map、runtime-config 静态 dev 配置（mock harness + claude-sonnet-4-6 目录）。验证：typecheck 绿 + typecheck:app 绿 + vite build 绿 + rescope-check OK + 全仓无 PG 185 tests/175 pass/10 skip/0 fail（新增 6 个 server 半用例：auth 门、turn→SSE 全流程、会话转录、skills/crons live、stubs）；`scripts/dev-web-ui.ts` 真监听冒烟（signin→turn→SSE done 帧→sessions→skills→静态 index + 深链回退）全过，profiles/cordis.yml 已挂 web-ui（boot 端到端测试覆盖）。冒烟抓出并修复 SSE finish() 重入竞态（replay 终态与 initial-terminal 检查双触发 → write-after-end 崩进程；改为同步置位 teardown + writableEnded 守卫）。注：memory 视图按 11.0 冻结清单保持 stub 空态，17.0 组合根把 `wrapResolutionWithMemory` 接进 resolution 时可顺带改为真 ScopeMemory 后端；crons 视图只读+管理，SPA 无创建路由（qm 由聊天工具侧建），17.0 接调度器后即可全链路
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
