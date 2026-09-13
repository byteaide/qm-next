# qm-next Architecture

中文为主（英文版后补）。状态：**Draft v1**（M0 实施基线）。
配套：PRD 与任务分解见 `aa` 仓 `todo/tasks/`（prd-qm-next.md / tasks-qm-next.md）。

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
│   ├── im-slack/                # @qm/im-slack     Slack Provider (socket-mode) [M4·A]
│   ├── im-dingtalk/  im-wecom/  #                                      [M4 可选，未启动]
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

## 6. 核心类型（@qm/types，M1 串行门冻结）

```ts
interface TurnInput {
  surface: string            // ChannelInstance.id；无默认值，必填
  scopeId: string
  userId: string
  text: string
  sessionId?: string
  files?: InFile[]
}
interface TurnResult { status: 'done' | 'failed'; sessionId: string; reply?: OutMessage }
interface Run { id: string; status: 'pending' | 'running' | 'done' | 'failed'; lease?: string; attempts: number }
interface SessionStore { /* CRUD + entries + participants */ }
interface RunStore {
  enqueue(run: Run): Promise<void>
  claim(workerId: string): Promise<Run | undefined>
  heartbeat(id: string, lease: string): Promise<boolean>
  complete(id: string, result: TurnResult): Promise<void>
  fail(id: string, error: Error): Promise<void>
  onTerminal(listener: (run: Run) => void): () => void
}
```

## 7. Turn 生命线（端到端时序）

```
飞书 WS 事件 → im-feishu(normalize) → registry(去重) → im-bridge
  → runs.enqueue（surface='feishu'，threadRef 会话解析）
      → TurnRunner claim → orchestrator.handleTurn（限流/预算/身份）
      → harnesses.route() → provider.runTurn
  → runs.onTerminal → bridge → delivery 入队（幂等键 run:<id>）
  → 认领循环 → im-feishu.outbound(send) → 飞书 API（线程内回复）
```

Slack 同构（Socket Mode 入站、`@slack/web-api` 出站、Block Kit 审批卡、mrkdwn 格式管道）；一个 registry 同时挂多 provider，投递按 `Destination.type` 认领到对应 adapter——双渠道并存见 `profiles/multi-im.yml` 与 `packages/im-bridge/tests/dual-channel.test.ts`。

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

# IM provider 按 profile 挂载（真机档见 profiles/im-smoke.yml / im-e2e.yml /
# multi-im.yml 双渠道档；凭据一律 !!js 读 env，不写字面量）
- id: feishu
  name: '@qm/im-feishu'
  config:
    appId: !!js "process.env.FEISHU_APP_ID"
    appSecret: !!js "process.env.FEISHU_APP_SECRET"
- id: slack
  name: '@qm/im-slack'
  config:
    appToken: !!js "process.env.SLACK_APP_TOKEN"
    botToken: !!js "process.env.SLACK_BOT_TOKEN"
```

环境差异用 profile 变体表达（内存 store/无 IM 的 cordis.yml 为默认；im-smoke/im-e2e/multi-im 挂真渠道）。

## 9. 事件契约（声明合并，@mode 标注）

| 事件 | 派发模式 | 语义 |
|------|---------|------|
| `im/inbound` | parallel | 入站事件扇出（桥接、镜像、审计） |
| `im/interaction` | bail | 卡片交互，认领者拥有决策（审批） |
| `orchestrator/turn-started` / `turn-completed` | emit | 观测（日志/指标/镜像） |
| `orchestrator/authorize` | waterfall | 策略链（限流/预算/权限），监听器必须 `next()` 除非拥有决策 |

## 10. 进程拓扑

M0-M2 单进程（in-process 插件，一 profile 一进程）。M3 视资源隔离需求决定 web-ui/admin 是否拆独立进程（qm 的 chassis HTTP 签名方案保留为拆分预案，不在 v1 实施）。

## 11. 安全

- 飞书/平台凭据：env 注入（`!!js` 读 process.env），不写入 yml 字面量；`ctx.credentials` 统一引用。
- 入站信任分级：消息文本为不可信输入；卡片回调校验操作者身份 + 实例归属（防重放/越权）。
- 文件：上传大小/类型白名单；下载走平台 API，禁直接外链抓取（沿用 qm SSRF 防护思路）。

## 12. 门禁

| 门禁 | 内容 |
|------|------|
| `pnpm check:im` | grep core 服务 src/（api/approvals/boot/directory/im-bridge/im-core/memory/orchestrator/reach/skills/store/triggers/types/web-ui）无 `slack\|feishu\|lark\|wecom\|dingtalk` 符号（M4 21.1） |
| `pnpm rescope-check` | vendor 无 `@deepseek-ai` 残留 |
| `pnpm typecheck` | strict TS 全仓 |
| `pnpm test` / `pnpm test:pg` | 单测 + e2e（无 PG / 一次性 PG 容器全量对拍） |
