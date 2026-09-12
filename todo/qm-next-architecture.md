# qm-next Architecture

> qm-next 的架构基线文档（Draft v1，M0 实施基线）。
> M0 建仓后本文档迁移为 `qm-next/docs/architecture.md`。
> 配套：[PRD](tasks/prd-qm-next.md) · [任务分解](tasks/tasks-qm-next.md)

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
│   ├── im-slack/                #                                      [M4]
│   ├── im-dingtalk/  im-wecom/  #                                      [M4 可选]
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

## 5. IM 契约（@qm/im-core，M2 串行门冻结）

```ts
// 渠道实例：配置声明，surface id 之源
interface ChannelInstance {
  readonly id: string        // "feishu:prod" —— orchestrator input.surface 的值
  readonly provider: string  // "feishu" | "slack" | "wecom" | "dingtalk"
}

// 目的地：泛化 threadTs 语义
interface Destination {
  channelId: string          // ChannelInstance.id
  chatId: string             // 平台会话 id（飞书 chat_id / Slack channel）
  threadId?: string          // 平台线程 id（飞书 root_id / Slack thread_ts）
}

// 入站事件（判别联合，closed union + assertNever）
type InboundEvent =
  | { kind: 'message';  channel: string; from: Principal; chat: ChatRef; text: string; files?: InFile[] }
  | { kind: 'mention';  channel: string; from: Principal; chat: ChatRef; text: string }
  | { kind: 'join';     channel: string; members: Principal[] }
  | { kind: 'leave';    channel: string; members: Principal[] }
  | { kind: 'reaction'; channel: string; target: MsgRef; emoji: string; from: Principal }
  | { kind: 'interaction'; channel: string; action: string; value: unknown; from: Principal }

// Provider 适配器（每个 im-* 包注册一份）
interface ImAdapter {
  send(dest: Destination, msg: OutMessage): Promise<MsgRef>
  edit(dest: Destination, ref: MsgRef, msg: OutMessage): Promise<void>
  delete(dest: Destination, ref: MsgRef): Promise<void>
  uploadFile(dest: Destination, file: FilePayload): Promise<MsgRef>
  // v1 保留位，不实现：react?(dest, ref, emoji)
}

// 格式管道：Markdown → 平台方言
type Formatter = (md: string) => PlatformDoc
```

- 注册：`ctx.im.registerChannel(instance, adapter)`，返回 disposer（effect 语义）。
- 入站：适配器 normalize 平台事件 → `ctx.im.dispatchInbound(event)`（parallel 事件 `im/inbound`）→ orchestrator 桥接创建 turn（`surface = channel.id`）。
- 出站投递：turn 终态 → `ctx.runs.onTerminal` → delivery 入队（按 channelId）→ im-core 认领循环（claim/ack/重试，平移 qm DeliveryStore 语义）→ `adapter.send`。
- 交互（审批）：`interaction` 事件走 `im/interaction`（**bail** 派发）：approvals 插件认领决策，未认领则默认拒绝。

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
飞书 WS 事件 → im-feishu(normalize) → ctx.im.dispatchInbound
  → orchestrator.handleTurn({surface:'feishu:prod', …})
      → 限流/预算/身份 → sessions 解析 → runs.enqueue
      → worker claim → heartbeat → harnesses.route() → provider.runTurn
  → runs.complete → delivery 入队(channelId)
  → im-core 认领循环 → adapter.send(dest, msg) → 飞书 API（线程内回复）
```

HTTP 入口同构：`POST /v1/turns`（`@qm/api`）→ 同一 `runs.enqueue`，回复经 API/SSE 取回。

## 8. 配置与组装

```yaml
# profiles/default.yml（示意）
plugins:
  - '@qm/boot'
  - name: '@qm/stores-pg'
    config: { databaseUrl: !!js "process.env.DATABASE_URL" }
  - '@qm/sessions'
  - '@qm/runs'
  - '@qm/harness'
  - '@qm/orchestrator'
  - '@qm/credentials'
  - '@qm/im-core'
  - name: '@qm/im-feishu'
    config:
      channelId: 'feishu:prod'
      appId: !!js "process.env.FEISHU_APP_ID"
      appSecret: !!js "process.env.FEISHU_APP_SECRET"
  - '@qm/api'
```

环境差异用 include patch overlay（`profiles/dev.yml` 换内存 store、关飞书）。

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
| `verify:im-isolation` | grep core 包（types/stores/orchestrator/harness/credentials）无 IM 平台符号 |
| `verify:explicit-surface` | 禁止 `surface` 默认值模式（`?? "…"`, `|| "…"`） |
| test | 各包单测 + M1 e2e（HTTP→mock harness）+ M2 真机清单 |
