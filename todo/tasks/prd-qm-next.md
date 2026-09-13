# Product Requirements Document: qm-next — 基于 Cordis 插件架构的企业级 Agent 编排平台

<!--TOON:prd{id,feature,author,status,est,est_ai,est_test,est_read,logged}:
prd-qm-next,qm-next（Cordis 重写 + 飞书 IM 适配层）,wxd + AI DevOps,draft,~11d,~7d,~3d,~1h,2026-09-12T14:30Z
-->

## Overview

**Feature:** qm-next — 用 Cordis 插件架构重写 qm，IM 层插件化（飞书首发）
**Author:** wxd + AI DevOps
**Date:** 2026-09-12
**Status:** Draft
**Estimate:** ~11d (ai:~7d test:~3d read:~1h)

### Problem Statement

qm 是企业级 agent 编排平台（turn 编排、多 harness、run 队列、审批、目录镜像、Postgres 持久化），但存在两个结构性问题：

1. **单体 + 部署期插件约定**：`plugins/` 仅是独立进程的部署约定，无统一插件运行时（生命周期、依赖注入、事件、配置热加载都靠手工接线，见 `qm/src/wiring.ts` buildApp 135 处 fan-in）。
2. **Slack 深耦合**：`surface` 是自由字符串且 7 处默认 `"slack"`（`qm/src/api/app-ambient.ts:333`、`qm/src/core/orchestrator.ts:851` 等）；`Destination` 类型含 `threadTs`/`editRef` 等 Slack 概念（`qm/src/types.ts:170`）；`SlackCoreClient` 接口按 Slack 命名（`qm/src/api/slack-core-client.ts:61`）；core 内 ~10 处 `=== "slack"` 硬分支。无法接入国内 IM。

企业用户的 IM 主场是飞书/企业微信/钉钉，qm 无法触达。

### Goal

以 Cordis 插件架构（dsh 同源内核）重写 qm 为**全插件**平台：

- 编排核心、harness、存储、IM、Web UI 都是 cordis 插件/Service，由 `cordis.yml` profile 组装；
- **IM 是一等插件类别**：一份 IM 契约（Service Definition），多平台 Provider 插件；
- **飞书是首发与主场**（替代 Slack 的位置），Slack/企业微信/钉钉为同类后续适配器；
- qm 的实战域逻辑（orchestrator、stores、harness 适配器）平移复用，不重写逻辑。

成功判据：飞书里 @机器人 → 线程回复 → 审批卡片可点，全链路运行在 Cordis 插件之上；同一核心可同时挂载飞书 + Slack 两个适配器。

## User Stories

### Primary User Story

作为一名企业员工，我想在飞书群里 @agent 或私聊它来派发任务并得到线程内回复，这样我不需要切换工具就能使用平台的编排能力。

### Additional User Stories

- 作为一名审批人，我想在飞书消息卡片上直接点击批准/拒绝，这样审批动作留在 IM 内完成。
- 作为平台管理员，我想在配置中声明多个 IM 渠道实例（如"飞书-生产"、"Slack-海外"），这样同一核心服务多渠道。
- 作为插件开发者，我想只实现 IM 契约（`InboundEvent`/出站操作/`Interaction`）就能接入新平台，这样不必理解编排核心。
- 作为运维者，我想用 cordis.yml overlay 为不同环境启停插件，这样部署形态可配置。

## Functional Requirements

### Core Requirements

1. **Cordis 基座**：vendor Cordis v4 内核（自 dsh `vendor/` 拷贝，rescope 为 `@qm/cordis`）及 loader/include/timer 插件族；`cordis.yml` profile 启动、配置注入、typed events、`ctx.effect()` 可逆注册全部可用。
2. **核心回路 Service 化**：`ctx.sessions`、`ctx.runs`（Postgres + 内存双实现，沿用 qm schema）、`ctx.orchestrator`（平移 `handleTurn`）、`ctx.harnesses`（router + mock 起步，至少接一个真 harness）、`ctx.credentials`。
3. **HTTP API 插件**：`POST /v1/turns`（同步与 `?async=1`）端到端可用，鉴权沿用 qm signed-token/capability-token 方案。
4. **IM 契约包 `@qm/im-core`**（Service Definition）：
   - `ctx.im` 渠道注册表：渠道实例显式声明（provider + 实例 id + 凭据引用），**无默认 surface**；
   - 入站：`InboundEvent` 判别联合（message / mention / join / leave / reaction / interaction）；
   - 出站：`send` / `edit` / `delete` / `uploadFile` / `react`；
   - `Destination { provider, chatId, threadId? }`（替代 threadTs 语义）；
   - `Interaction`：卡片/按钮回调（审批等），替代 Slack `app.action`；
   - `DirectorySync`：用户/群目录同步（替代 `pushDirectory`）；
   - 格式管道：`format(md) → 平台方言`；
   - delivery 认领循环：按 surface 类型认领出站投递（平移 qm DeliveryStore 语义）。
5. **飞书适配器 `im-feishu`**（首个 Provider）：WebSocket 长连接接入（免公网回调）；@提及/私聊消息入站；线程内回复、编辑、文件上传出站；审批卡片交互；通讯录与群目录同步；Markdown → lark_md/post 格式转换。

### Secondary Requirements

6. **企业能力回归**：approvals/ambient、cron/triggers、reach、目录镜像、memory、skills 平移为 Service/插件。
7. **Web UI 插件化**：`web-ui`（Lit SPA + SSE）改为 cordis 插件，in-process 优先。
8. **多平台适配器**：`im-slack`（由 qm `src/slack/` 模块按契约改造，参考实现）、`im-dingtalk`（Stream 模式）、`im-wecom`（回调模式）。
9. **观测**：结构化日志（cordis logger）、run/delivery 状态可查询。

## Non-Goals (Out of Scope)

- **不迁移 qm 现网数据/部署**：qm 保留运行作为参考实现与回退；数据迁移另立任务（schema 兼容是其前提）。
- **表情回应（reaction）不进 v1**：飞书 reaction API 语义与 Slack 差异大，推迟到 M4 后（契约保留 `react` 操作位）。
- **不做 IM 之外的推送渠道**（邮件/SMS/webhook 通知）。
- **不做移动端原生应用**；web-ui 沿用现有 Lit SPA 形态。
- **不做插件市场/动态分发**：插件由 cordis.yml 静态组装 + HMR 开发期热载。

## Design Considerations

### User Interface

- 飞书侧：@提及消息、线程内流式回复（编辑同一条消息）、审批卡片（按钮 + 状态回写）、文件附件。
- web-ui 侧：沿用 qm `plugins/web-ui` 的聊天壳与 SSE 流式呈现。

### User Experience

- 群内 @agent 触发 turn，回复钉在该消息线程；私聊则一会话一线程。
- 审批：turn 暂停 → 卡片送达审批人 → 点击回调 → turn 恢复/终止，过程在消息卡片上留痕。

## Technical Considerations

### Architecture

```
┌─ plugins (cordis) ───────────────────────────────┐
│  im-feishu │ im-slack │ im-wecom │ im-dingtalk   │ ← Provider 插件
│  └──────── @qm/im-core（契约/注册表/投递循环）──┘ │ ← Service Definition
│  api │ web-ui │ admin │ portal │ auth            │ ← 界面与门面插件
├─ core services (cordis Service) ─────────────────┤
│  orchestrator │ sessions │ runs │ harnesses      │ ← qm 实战逻辑平移
│  credentials │ memory │ skills │ directory       │
├─ foundation ─────────────────────────────────────┤
│  @qm/cordis（vendor v4）+ Postgres + pg-boss     │
└──────────────────────────────────────────────────┘
```

- 仓库：`repos/qm-next`，仿 dsh 布局：`vendor/` + `packages/<group>/<pkg>/` + `cordis.yml` profile；ESM、strict TS、Node ^22.19 || >=24。
- 插件规范沿用 dsh 约定：Service 子类默认导出，或 `name`/`inject`/`Config`/`apply` 函数插件（不混用）；注册即可逆；waterfall 监听器必须 `next()`。

### Dependencies

- **Cordis v4 vendor**（dsh `vendor/cordis` v4.0.2 及 loader/include/timer）：内核与插件运行时。
- **飞书开放平台**：自建应用；长连接模式。SDK 候选 `@larksuiteoapi/node-sdk`（含 WS client）——M2 前验证版本与长连接 API 形态，不满足则直连 OpenAPI + 自实现 WS 网关。
- **Postgres/pg-boss/pg**：沿用 qm 存储层依赖。
- **qm 参考实现**：`repos/qm`（域逻辑平移来源，只读）。

### Constraints

- M1（核心回路）验收前**不写任何 IM 代码**——契约长在真实回路上，不凭空设计。
- 飞书 v1 范围锁定：消息/@提及/线程回复/编辑/文件/审批卡片；reaction 推迟。
- `surface` 全链路显式化：不允许出现默认渠道值。
- cordis.yml 允许 `!!js`（限 plugin `config` 与 entry `disabled`），其余保持字面量（dsh loader 约定）。

### Security Considerations

- 飞书凭据（App ID/Secret、verification token/encrypt key）经 `aidevops secret set` 注入环境，不入库不入对话。
- 事件回调验签（长连接模式为登录态校验，webhook 模式含 challenge/签名验证）；目录同步数据按 scope 隔离，沿用 qm 权限模型。
- 文件上传/下载沿用 qm SSRF 防护与大小限制思路，适配飞书消息附件 API。
- 审批卡片回调必须校验操作者身份与卡片实例归属（防重放/越权点击）。

## Time Estimate Breakdown

| Phase | AI Time | Test Time | Read Time | Total |
|-------|---------|-----------|-----------|-------|
| M0 基座 | 0.5d | 0.5d | - | 1d |
| M1 核心回路 | 2d | 1d | - | 3d |
| M2 IM 契约 + 飞书 | 2d | 1d | 0.5h | 3d |
| M3 企业能力回归 | 2d | 1d | - | 3d |
| M4 多平台 + 收尾 | 0.5d | 0.5d | - | 1d |
| **Total** | **~7d** | **~3d** | **~0.5h** | **~11d** |

<!--TOON:time_breakdown[5]{phase,ai,test,read,total}:
m0-foundation,0.5d,0.5d,-,1d
m1-core-loop,2d,1d,-,3d
m2-im-contract-feishu,2d,1d,0.5h,3d
m3-enterprise,2d,1d,-,3d
m4-multi-platform,0.5d,0.5d,-,1d
-->

## Milestones & Acceptance

| 里程碑 | 交付 | 验收标准 |
|--------|------|---------|
| M0 基座 | `repos/qm-next` 骨架 + rescope cordis + profile 启动 | 插件挂载/卸载、配置注入、typed events 冒烟通过 |
| M1 核心回路 | sessions/runs/orchestrator/harnesses/credentials Service + api 插件 | HTTP `POST /v1/turns` → run 队列 → mock harness → 回复；单测 + 起服冒烟 |
| M2 飞书 | `@qm/im-core` 契约 + `im-feishu` | 真机：飞书 @机器人 → 线程回复；审批卡片可点且回调校验生效 |
| M3 企业回归 | approvals/ambient/cron/triggers/reach/memory/skills/web-ui | 对照 qm 功能清单逐项回归通过 |
| M4 多平台 | `im-slack`（+ 可选 dingtalk/wecom 起步） | 同一核心双渠道（飞书 + Slack）并存运行 |

## Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| 飞书端到端时延（@→回复首字） | 不劣于 qm Slack 基准 | 真机冒烟计时 |
| core 对 IM 平台符号的引用数 | 0（grep `slack|feishu|lark` 于 core services 为空） | CI grep 门禁 |
| 新增一个 IM 适配器的接触面 | 仅 `@qm/im-core` 契约实现，无 core 改动 | 代码评审 |
| qm 域逻辑复用率 | orchestrator/stores 平移为主，非重写 | diff 对照评审 |

## Open Questions

- [x] 飞书 SDK 选型：**已定，用 `@larksuiteoapi/node-sdk` v1.73.3**（spike 6.0/6.1，分支 `spike/feishu-sdk` 随 M2 合入）。高层 `createLarkChannel`（WS 传输）覆盖三件套：收事件（自动重连+ping 看门狗+状态五态查询）、发消息（send/stream/edit/recall、`replyTo+replyInThread` 线程回复、file/image 即 uploadFile 位）、卡片回调（`card.action.trigger` 经 WS 可达 + 内置点击去重 + `updateCard` 状态回写）。另有流式回复（超长自动滚卡）、准入策略（PolicyConfig/RejectEvent）、SSRF 防护内置——9.x 无需直连 OpenAPI。证据与坑清单：`repos/qm-next/packages/spike-feishu/README.md`。真连验证并入 10.0 冒烟。
- [ ] web-ui in-process 后的进程资源隔离是否满足部署要求（不满足则拆回独立进程插件）
- [ ] `im-wecom` 回调模式需要公网 HTTPS 入口，部署形态待定（M4 前）
- [ ] qm 数据迁移（schema 兼容层）是否纳入 qm-next 范围（当前 Non-Goal，待现网切换时再议）

## Appendix

### Evidence（qm 耦合清单，调研 2026-09-12）

| # | 位置 | 耦合点 |
|---|------|--------|
| 1 | `qm/src/slack/turn-handler.ts`（817L） | 入站派发/回复/审批钩子，最深 Slack 语义 |
| 2 | `qm/src/slack/{lib,mrkdwn,emoji-map}.ts` | mrkdwn/Block Kit/emoji 归一化 |
| 3 | `qm/src/api/slack-core-client.ts:61` | 插件↔core 边界接口按 Slack 命名 |
| 4 | `qm/src/slack/{events,http-events,deferred-ack}.ts` | Events API/Socket Mode 接入 |
| 5 | `qm/src/types.ts:170` + `delivery/run-result-delivery.ts:29` | `Destination`/投递 Slack 形状 |
| 6 | `qm/src/slack/{approvals,approval-cards,agent-requests}.ts` | Block Kit 交互 |
| 7 | `qm/src/slack/{directory,mirror,conversation-view}.ts` | 目录/历史镜像 |
| 8 | `qm/src/slack/{attachments,surface-context}.ts` | 文件与上下文拉取 |
| 9 | `qm/src/core/orchestrator.ts:449,2017,2834` + `harness/pi-tools.ts:2233` | core 内 surface 硬分支/工具命名 |
| 10 | `qm/src/{reach/reach,triggers/run-trigger,api/routes/context}.ts` | destination.type === "slack" 分支 |

### Cordis 先例（dsh）

- 内核：`dsh/vendor/cordis`（@deepseek-ai/cordis v4.0.2，Shigma Cordis v4 rescope）
- 插件规范：`dsh/packages/AGENTS.md`；入门：`dsh/docs/cordis-primer.md`（有中文版）
- 外部事件接入样板：`dsh/packages/webhook/webhook`（`ctx.webhookRuntime` register/dispatch，provider 认证归 adapter）

### Related Documents

- qm 参考实现：`repos/qm`（含 `AGENTS.md`、`src/wiring.ts`）
- dsh 架构文档：`repos/deepseek-harness/docs/architecture.md`

### Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-09-12 | AI DevOps | Initial draft（基于两仓库图谱调研） |
| 2026-09-13 | wxd | M4 范围拍板：v1 只做飞书；`im-slack`（当次实现存 git `d7d2db3` 后移出包集）、`im-dingtalk`、`im-wecom` 与双渠道真机验收全部延期。M4 收尾保留：provider 自带审批卡渲染（M3 遗留清零）+ `check:im` IM 符号隔离门禁 + 文档收尾 |
