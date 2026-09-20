# qm-next Architecture

中文为主（英文版后补）。状态：**Current — 2026-09-20 Phase 7 cutover 后**。本文描述当前运行时行为（legacy 路径已于 Phase 7 切除）；ADR 记录决策原因。
配套：PRD 与任务分解见 `aa` 仓 `todo/tasks/`（prd-qm-next.md / tasks-qm-next.md）。

## 0. 架构决定与当前行为

本节是 decision summary；详细决策见 `docs/adr/`。

| 领域 | 当前行为 | ADR |
|------|----------|-----|
| Run lifecycle | Run State 为 `queued/running/succeeded/failed/cancelled`（写路径仅 target 语义，`done` 字面量已物理移除；历史行的读取经 Phase 1 投影，直到 `migrate:qm` 物理重写）；Run 拥有 durable event history（`run_event_log`，`(run_id, seq)` 唯一，seq 由 SequenceAllocator 分配） | 0001, 0011, 0013 |
| Observation | durable log 是唯一事件源：snapshot + cursor replay/live；授权经 RunVisibilityToken；web SSE 与 `/v1` 路由同源；legacy 内存 bus 与 polling 补偿已删除 | 0001, 0014 |
| Admission | Orchestrator 内部固定 Admission Waterfall（identity/authz → rate limit → budget → screen → resolution）；拒绝产生 Admission Record，绝不创建 Run；Screen 首期 Shadow，后显式 Enforce | 0004, 0006, 0007 |
| Command Gate | side-effecting operation 与 sensitive read 必过 Gate；decision 是结构化的 `allow/deny/require_approval`（typed `CommandDecision`），生产启动必须显式选择 Baseline Policy | 0002 |
| Approval | requester-only；24h 默认 TTL；决策单次迁移、幂等。同 Run suspended/resumed 全链路已落地（ADR-0010 continuation executor，2026-09-20）：`suspendForApproval` 挂起（awaiting_approval + 释放 executor lease + 持久化 Approval Continuation）、turn runner 的 continuation lane 凭 `claimNextContinuation` 恢复保存的命令点（`TurnInput.approval` 带 commandRequestId，非盲目重放）、Web/IM 决策面统一走 `applyApprovalDecision`，不再产生 successor Run | 0010, 0012 |
| IM intake | durable Inbox + independent subscriber cursors + retry/dead-letter；进程内 dedup 已删除，durable accept（provider + eventId）是唯一去重权威 | 0008, 0015 |
| Trigger | `packages/types` 中最小 `TriggerRuntime` contract；composition 注入；`api.cronsRuntime` 兼容字段已删除 | 0003 |
| Connector OAuth | Connector context owns lifecycle；durable `oauth_flows`/`consent_links` store；HTTP 只是 adapter | 0009, 0016 |

## 1. 设计原则

1. **全插件**：一切能力皆为 cordis 插件/Service；组装靠 `cordis.yml` profile，不做手工接线（对照 qm `src/wiring.ts` 的 buildApp 单体组装）。
2. **能力接缝三角色**（沿 dsh 惯例）：Service Definition（契约）/ Service Provider（实现）/ Consumer（消费）。接缝必须完整，不因单一消费者改契约。
3. **surface 显式化**：渠道实例在配置中声明并持有 id（如 `feishu:prod`），全链路无默认渠道值。
4. **平移不重写**：qm 的 orchestrator/stores/harness 适配器是实战资产，平移进 Service，剥离 Slack 分支。
5. **类型边界信任 TS**：同进程类型化边界不加运行时校验；在 parser/config/queue/wire 边界校验。
6. **注册即可逆**：一切贡献经 `ctx.effect()`/`ctx.on()`，可重载、可卸载（HMR 安全）。
7. **fail loud**：配置错误在加载期报错，不静默跳过。

## 2. 技术基座

| 项 | 选择 |
|----|------|
| 运行时 | Node ^22.19 \|\| >=24，ESM only，strict TS（NodeNext） |
| 内核 | vendor Cordis v4（自 dsh 拷贝），rescope `@deepseek-ai` → `@qm` |
| vendor 集合 | `cosmokit`、`schemastery`、`cordis`、`loader`、`include`、`timer`（group/hmr/logger-console 暂缓） |
| 构建 | 单阶段 tsc emit `lib/`（JS + d.ts）——有意偏离 dsh 的 tsdown 双段构建 |
| 包管理 | pnpm workspace，`linkWorkspacePackages: true` |
| 存储 | Postgres（沿用 qm schema）+ 内存双实现；任务队列 pg-boss（M3） |
| HTTP | Fastify（仅 `@qm/api` 内部依赖） |

## 3. 仓库布局

```
qm-next/
├── vendor/                      # cordis 内核（rescope 后 @qm/*）
│   ├── cosmokit/  schemastery/  cordis/
│   └── loader/  include/  timer/
├── packages/                    # 全部 @qm/* 插件
│   ├── types/                   # @qm/types        共享契约（冻结于 M1 串行门）
│   ├── stores/                  # @qm/stores       store 接口 + 内存实现      [M1·A]
│   ├── stores-pg/               # @qm/stores-pg    Postgres 实现              [M1·A]
│   ├── orchestrator/            # @qm/orchestrator handleTurn 编排            [M1·B]
│   ├── harness/                 # @qm/harness      router + mock provider     [M1·B]
│   ├── harness-pi/              # @qm/harness-pi   第一个真 harness           [M1 末/M3]
│   ├── credentials/             # @qm/credentials  scoped keychain            [M1]
│   ├── api/                     # @qm/api          Fastify + /v1/turns + 鉴权  [M1·汇合]
│   ├── im-core/                 # @qm/im-core      IM 契约 + 注册表 + 投递循环  [M2·A]
│   ├── im-feishu/               # @qm/im-feishu    飞书 Provider               [M2·B]
│   ├── im-dingtalk/  im-wecom/  #  （延期：v1 只做飞书；slack 同级延期，历史见 git）
│   ├── approvals/  triggers/  reach/  directory/                #      [M3]
│   ├── memory/  skills/                                          #      [M3]
│   ├── web-ui/  admin/                                           #      [M3]
│   └── boot/                    # @qm/boot         profile 启动胶水
├── profiles/                    # cordis.yml 组装档
│   ├── default.yml  dev.yml  e2e.yml
├── docs/                        # architecture.md、cookbook
├── scripts/                     # rescope / 构建辅助
├── pnpm-workspace.yaml          # packages: vendor/*, packages/*
├── tsconfig.base.json
└── package.json
```

包约定（沿 dsh）：`src/types.ts` 只放类型；测试在包级 `tests/`；每包有 README（config/语义/扩展点）；Service 子类默认导出或 `name`/`inject`/`Config`/`apply` 函数插件，不混用。

## 4. 服务地图（ctx 键声明）

| Service | ctx 键 | 职责 | 消费者 |
|---------|--------|------|--------|
| Sessions | `ctx.sessions` | 会话/条目/参与者 CRUD（scope 隔离） | orchestrator, api |
| Runs | `ctx.runs` | enqueue/claim/heartbeat/complete/fail、`onTerminal` | orchestrator, api, triggers |
| Orchestrator | `ctx.orchestrator` | `handleTurn(input): TurnResult`：身份/限流/预算/会话解析/harness 调用/投递编排 | api, im-core, triggers |
| Harnesses | `ctx.harnesses` | `register(provider)` + `route()` → `runTurn` | orchestrator |
| Credentials | `ctx.credentials` | scoped keychain（凭据引用，不落明文日志） | harnesses, im 适配器 |
| Im | `ctx.im` | 渠道注册表、入站分发、投递认领循环、格式管道 | orchestrator 出站桥, im 适配器 |

依赖方向：`im/api/triggers → orchestrator → { sessions, runs, harnesses }`；`harnesses → credentials`；**core 不依赖任何 im 包**（grep 门禁：core 无 `slack|feishu|lark|wecom|dingtalk` 符号）。

## 5. IM 契约（@qm/im-core，M2 串行门冻结；M4 增补渲染端口）

M2 冻结后的实际形状（速写，完整定义见 `packages/im-core/src`）：

```ts
// 目的地：surface 显式，无默认渠道（type = provider key）
interface Destination { type: string; target: string; threadId?: string }

// 入站事件（判别联合）：message / interaction / reaction / lifecycle
// 事件信封含 provider、instanceId、eventId（core 据此去重）、occurredAt
interface InboundMessageEvent extends InboundEnvelope {
  kind: 'message'
  destination: Destination
  actor: InboundActor
  text: string
  mentionedBot?: boolean          // 寻址分诊由 core（bridge）拥有
  containerKind?: 'dm' | 'channel'
}

// 出站操作（队列存储单元）：send / edit / delete / uploadFile / react
// react、uploadFile 为 v1 保留位，adapter 报 IM_UNSUPPORTED_OP
interface SendOperation { op: 'send'; destination: Destination; body: OutboundBody; threadId?; replyToMessageId? }

// Provider 端口：每个 im-* 包实现一份
interface ImProvider {
  provider: string; instanceId: string
  capabilities(): ImCapabilities
  start(ctx: ImProviderStartContext): Promise<void>   // 接入即 intake live
  stop(): Promise<void>
  outbound(ops: readonly OutboundOperation[]): Promise<OutboundReceipt[]>
  format(markdown: string): OutboundBody               // 规范 md → 平台 body
  collectDirectory?(): Promise<DirectorySyncPush>      // 人/群目录拉取
  approvalCardRenderer?: ImApprovalCardRenderer        // M4 增补：审批卡归 provider
}
```

- 注册：`ctx.im.register(provider)`（校验 → start → intake live），返回幂等 disposer（停止 + 排空 in-flight）；registry 按 `eventId` 去重入站。
- 入站：adapter emit → `ImInboundSink` → `im-bridge` 分诊（@提及/私信 → 人转 turn；未寻址群聊 → 有 ambient 策略走 judge，否则丢弃）。
- 出站投递：turn 终态 → bridge → delivery 队列入队（幂等键 + TTL lease）→ 认领循环（退避重试、maxAttempts 停机、stop 排空）→ `provider.outbound(ops)`。
- 交互（审批）：`interaction` 事件的 `action.value` 经 `@qm/approvals` codec 往返（对象或 JSON 串）；决策状态机 pending→approved/rejected 单次迁移、仅请求者可决、双击去重。
- 审批卡（M4）：渲染归 provider 自带（`approvalCardRenderer`），bridge 解析顺序为注入覆盖 → provider 自带 → 中性文本兜底；core 侧零平台符号（`pnpm check:im` 门禁）。

## 6. 核心生命周期类型（当前契约）

M1/M3 的 legacy 形状（`RunEventBus`、`done` 字面量、`LegacyCommandDecision`）已在 Phase 7 物理删除；以下即当前契约：

```ts
type RunOutcome = 'succeeded' | 'failed' | 'cancelled'
type FailureReason =
  | 'execution_failed' | 'timeout' | 'cancelled'
  | 'command_refused' | 'approval_denied'
  | 'approval_expired' | 'approval_continuation_unavailable'

type RunState =
  | 'queued' | 'running' | 'awaiting_approval'
  | 'succeeded' | 'failed' | 'cancelled'

type AttemptState =
  | 'queued' | 'running' | 'suspended'
  | 'succeeded' | 'failed' | 'cancelled'

interface RunSnapshot {
  id: string
  sessionId: string
  state: RunState
  outcome?: RunOutcome
  failureReason?: FailureReason
  attempts: number
}

interface RunObservation {
  snapshot(): Promise<RunSnapshot>
  replay(from: EventCursor): RunEventBatch
  subscribe(from: EventCursor, listener: (event: RunEvent) => void): () => void
}
```

Rules:

- `done` is gone. `succeeded` means useful success; `failed` carries a Failure Reason.
- Attempt suspension is not Run terminality.
- Run Events are durable, immutable, per-Run monotonic, and committed with state transitions.
- Admission Records are not Run Events; rejected work never creates a Run.

## 7. Turn 生命线（当前）

```
IM delivery
  → durable Intake Inbox（Intake Key 去重，唯一去重权威）
  → independent subscribers：bridge / mirror / audit
  → Admission Waterfall：
      identity + authorization → rate limit → budget
      → Security Screen（shadow first）→ resolution + session lease → dispatch
  → Runs enqueue
  → executor claim + heartbeat/renew
  → harness execution
      → Command Gate（side effects / sensitive reads）
      → allow 执行；deny 结构化失败；approval required → 挂起同一 Run（awaiting_approval，
        见下方 Approval 当前形状）
  → RunStore 状态转移；终态由 runner 在 store 提交后发布 run.finished 事件
  → post-commit Run Observation notification（durable log → observation routes）
```

Approval（当前形状）：

```
runner: harness 返回 pending_approval → approvals.create（持久 Approval Request）
  → Session Continuation Reservation.reserve → RunStore.suspendForApproval
    （targetState=awaiting_approval、释放 executor lease、deliveryState.pendingApproval
     持久化 Approval Continuation + pending_approval result 快照）
  → attempt.suspended + approval.requested 事件（observation 快照投到 awaiting_approval）
决策面（Web / IM 卡片）→ applyApprovalDecision（approvals.decide：requester-only、单次迁移、幂等）
  → approved：beginContinuationAttempt 把同一 Run 置回可认领态 → runner continuation lane
    （claimNextContinuation，持久发现、重启后恰好恢复一次）以 TurnInput.approval
    （含 commandRequestId）恢复保存的命令点，同一 Run 至终态
  → rejected/expired：failFromApproval（awaiting-only 守卫）→ approval.decided/expired
    + run.finished 事件 → 之后才释放 Reservation（plan §2.6 释放顺序）
```

新 provider 同构接入：实现 `ImProvider`（入站 mapper 诚实寻址 + 出站 + `format` + 目录拉取 + 自带审批卡渲染）注册进同一 registry 即可——投递按 `Destination.type` 认领到对应 adapter，core 零改动（`pnpm check:im` 门禁保证）。v1 只随包发布飞书；slack（历史实现见 git）/钉钉/企微延期。

HTTP 入口同构：`POST /v1/turns`（`@qm/api`）→ 同一 `runs.enqueue`，回复经 API/SSE 取回。

## 8. 配置与组装

```yaml
# profiles/cordis.yml（仓库默认组装：M0 冒烟 + M1 全链 + 桥 + 调度 + web-ui）
- id: demo
  name: '@qm/demo'
  config: { greeting: !!js "'hello-' + (1 + 1)", times: 3 }
- id: api
  name: '@qm/api'
  config: { port: 0, secrets: ['dev-m1-secret'] }
- id: im-bridge
  name: '@qm/im-bridge'
- id: triggers
  name: '@qm/triggers'
- id: web-ui
  name: '@qm/web-ui'
  config: { port: 0 }

# IM provider 按 profile 挂载（真机档见 profiles/im-smoke.yml / im-e2e.yml；
# 凭据一律 !!js 读 env，不写字面量）
- id: feishu
  name: '@qm/im-feishu'
  config:
    appId: !!js "process.env.FEISHU_APP_ID"
    appSecret: !!js "process.env.FEISHU_APP_SECRET"
```

环境差异用 profile 变体表达（内存 store/无 IM 的 cordis.yml 为默认；im-smoke/im-e2e 挂真渠道）。

## 9. 事件与订阅契约

| 通道 | 所有权 | 语义 |
|------|--------|------|
| IM Intake | `im-core` durable Inbox | 按 Intake Key 去重（唯一权威）；bridge/mirror/audit 是独立 Intake Subscriber |
| IM Subscriber progress | 每 subscriber | independent cursor、retry/backoff、dead-letter；互不阻塞 |
| Run Event log | Runs（producers：orchestrator 非终态事件、turn runner 终态事件） | `run_event_log`，`(run_id, seq)` 唯一，SequenceAllocator 分配 seq；post-commit notification |
| Run Observation | Runs | snapshot + Event Cursor replay/live；`RunVisibilityToken` 授权；progress 摘要 producer 侧脱敏 + 路由层深度脱敏 |
| Cordis observability events | publisher-specific | metrics/log 用途，不作为 Run truth 或 audit truth |
| Admission | Orchestrator internal seam | fixed waterfall；rejection 写 Admission Record，不创建 Run |

## 10. 进程拓扑

M0-M2 单进程（in-process 插件，一 profile 一进程）。M3 视资源隔离需求决定 web-ui/admin 是否拆独立进程（qm 的 chassis HTTP 签名方案保留为拆分预案，不在 v1 实施）。

## 11. 安全

- **Admission**：固定 waterfall；Identity/authz → rate limit → budget → Security Screen → resolution/session lease → dispatch。
- **Security Screen**：首期 Shadow Mode，保存 structured Shadow Record；Enforce 是显式 cutover，screen unavailable 时 fail closed。
- **Command Gate**：所有 Side-Effecting Operation 和 Sensitive Read 必过；decision 是 `allow/deny/require_approval`，不得压平成 exit code。
- **Approval**：requester-only；默认 24h TTL；duplicate decision 幂等。
- **Secrets**：OAuth/platform credentials 加密存储；只在 Connector 或 adapter 短周期使用；observation/log/admission/admin diagnostics 不得包含 token。
- **Observation**：producer 侧 progress 摘要脱敏 + observation 路由层 `redactSecrets` 深度扫描；UI 渲染不是 redaction boundary。

## 12. 门禁

| 门禁 | 内容 |
|------|------|
| `pnpm check:im` | grep core 服务 src/（api/approvals/boot/directory/im-bridge/im-core/memory/orchestrator/reach/skills/store/triggers/types/web-ui）无 `slack\|feishu\|lark\|wecom\|dingtalk` 符号（M4 21.1） |
| `pnpm rescope-check` | vendor 无 `@deepseek-ai` 残留 |
| `pnpm typecheck` | strict TS 全仓 |
| `pnpm test` / `pnpm test:pg` | 单测 + e2e（无 PG / 一次性 PG 容器全量对拍） |
| Lifecycle gates | retry 不关闭 event log；terminal post-commit；long run 不被 reap；`term: 'done'` grep 恒零；projection/parity 对拍（`pnpm test:architecture` + contract suites） |
