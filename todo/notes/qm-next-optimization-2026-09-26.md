---
mode: subagent
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->
# qm-next 优化建议 — 基于 2026-09-26 上游同步（qm @ 8adee4b）

## 0. TL;DR

qm-next 当前 HEAD `acd05fd`（2026-09-22），正处于 **X3b 批 6 收口 + qm-soul 灵魂层（ADR-0018）+ P5 18.0/19.0/20.0/21.0** 五条车道。上游 qm 在同一窗口期推进了 415 commits，最值得 qm-next 立即消化的是**已经和 X3b/qm-soul/T1-T4 撞车的部分**——这部分可加速；其余**和战略明确 suspend 项对齐的部分**应保持原样。

**结论分级**：

| 优先级 | 数量 | 行动 |
|---|---:|---|
| P0 — 已撞车，加速收口 | 4 | 直接读 qm 对应模块的源码/测试做参考 |
| P1 — 高 ROI 增量 | 5 | 在 X3b/qm-soul 后续批 / P5 20.0 内消化 |
| P2 — 中 ROI 备选 | 4 | 看节奏再定，列入 parity-deviations |
| P3 — 不动 / 战略外 | 6 | 显式标注 suspended，无需优化 |

---

## 1. qm-next 当前状态（截至 acd05fd）

### 1.1 在飞车道（5 条）

| 车道 | 内容 | 关键 commit |
|------|------|------------|
| **qm-soul** | 16 段顺序组装管线 + 3 模式协议帧 + soul 联邦（ADR-0018） | `feature/qm-soul-plan` 40ca0da |
| **X3b Command Gate** | 批 6 收口：startup assembly + safe-regex + per-scope policy + scannableCommand 24-test corpus + 双引擎收敛 | `e59eb64`、`3fbfacc`、`0ee532a`、`8a7022b` |
| **X2/T5 PlayGround + Impersonate** | 创建立面 + 文件存储控制面 + /auth/impersonate sealing | `cd20a9d`、`a1d7c4f`、`269812e` |
| **Q3/Q4 段序** | grantedHandles（段 12 + shared-file read ladder）+ onboarding（段 15） | `8f55739`、`3e7c4bc` |
| **T1-T4 ToolContext** | crons / webhooks / MCP / share 控制平面接线 | `dde65fb` |

### 1.2 显式 suspend（不应优化）

- Slack / 钉钉 / 企微（v1 渠道只做飞书）
- Fly / AWS 部署端口（"not ported" 决策，2026-09-22 关闭）
- Cluster M（suspended）
- Connectors / OAuth（"no consumer, trigger-gated"，X1）
- User-model-login（不再 credential-gated）
- monitor-poller（resolved 但留作历史）
- pg-boss（resolved 但留作历史）

### 1.3 parity-deviations 已识别的延期项（节选）

- P1 contract freeze：HarnessTurnInput.tools optional / security-screening callbacks deferred / HarnessModelUtilities judge/pickAckEmoji deferred
- ToolContext 是 type-level parity；runtime 实现仅覆盖 sandbox-backed core（execute/read/write/computerStatus/restartComputer）；publish、background、MCP、memory、cron/webhook、control、surface actions 待 P4 subsystem 激活
- Lane A1：DurableMap 在 @qm/store 而非 core
- Lane A4：tar codec 在 @qm/credentials

---

## 2. P0：已撞车，立即吸收（4 项）

qm-next 正在做的代码，qm 在新 415 commits 里给出了**几乎一一对应的源码**。直接读 qm 实现做对照，可以加速并降低风险。

### 2.1 Tape canonical projection → qm-soul 收口

| 维度 | qm-next（qm-soul） | qm 上游 |
|------|-------------------|---------|
| 模块 | `@qm/store` tape/fold | `src/harness/tape-projection.ts`（1211 行测试） |
| 文档 | 无独立 spec | `docs/session-tape-spec.md` |
| 测试 | `tape-fold.test.ts`（169 行） | `test/tape-projection.test.ts`（1211 行）+ `tape-canonical-transcript.test.ts`（119 行）+ `tape-parity-gate.test.ts`（45 行）+ `tape-retirement.test.ts`（763 行） |

**建议**：qm-soul 段序里的 `frame-composer.stableSystemBytes` 划界逻辑可以直接对照 qm 的 `stableSystemBytes` 切点（qm 段 ⑬⑭）；qm-next 的 `golden fixtures 12 组` 应增加 parity-gate 套件（参照 qm `tape-parity-gate.test.ts` 45 行 gate 模式）。

### 2.2 Runtime control / recovery → ToolContext T1-T4

| 维度 | qm-next（T1-T4） | qm 上游 |
|------|-----------------|---------|
| 模块 | `packages/orchestrator/src/tool-context.ts` | `src/harness/runtime-control.ts` + `runtime-recovery.ts` + `harness-shared.ts` + `tape-projection.ts` |
| 引用 | 已 commit `dde65fb` | 多个 commit，包括 `Recover failed compaction with bounded recent context` |

**建议**：T1-T4 接线（crons / webhooks / MCP / share）现在只接入了 seam，运行时控制逻辑可参照 qm 的 `runtime-recovery.ts`（含 transient-state 回滚 + bounded-recent-context 恢复）。

### 2.3 Scannable command / Command Gate → X3b 批 6+

| 维度 | qm-next（X3b scannableCommand） | qm 上游 |
|------|--------------------------------|---------|
| 模块 | `packages/sandbox/src/scannable-command.ts` + `default-policy.ts` + `policy.ts` | `src/sandbox/scannable-command.ts`（已存在）/ `policy.ts` |
| 测试 | 24-test corpus（自评，commit `3fbfacc`） | `test/scannable-command.test.ts`（同 24-test corpus） |
| 增量 | X3b 4b per-scope policy storage 已做 | qm 在 `src/api/routes/admin/spend.ts` 和 `principal-links.ts` 有 admin 面 CRUD |

**建议**：X3b 4b 的 per-scope policy storage 已 commit，但缺少 admin 面（CRUD 路由 / 管理 UI）；qm 的 `src/api/routes/admin/command-policy.ts`（如有）和 `principal-links.ts` 是参考。下一步应该把 admin 面的 policy CRUD 也补上。

### 2.4 Frame composer / Runtime choice → qm-soul selectFrameMode

qm-next CHANGELOG 已注明：`selectFrameMode`/`deriveSurfaceTools`（qm orchestrator:857-862 语义）。qm 上游 415 commits 里 `src/core/orchestrator/runtime-choice.ts`（推测名）和 `runtime-control.ts` 提供了完整实现。新增的 `Recover failed compaction with bounded recent context` commit 涉及 qm-soul 段 ⑧⑨ 的兜底逻辑。

**建议**：qm-soul 段序组装时直接对照 qm `orchestrator.ts:857-862` 行号附近的真实实现，并在 `frame-composer.ts` 里增加 `boundedRecentContext` 兜底。

---

## 3. P1：高 ROI 增量（5 项）

### 3.1 Model gateway catalog / overlay / verification

| 维度 | qm-next（`@qm/model`） | qm 上游 |
|------|------------------------|---------|
| 模块 | `model-gateway.ts`（已有） + `model-catalog.ts` | `src/model/gateway-catalog.ts` + `gateway-models.ts` + `model-overlay.ts` + `model-verification.ts` + `model-lookup.ts` |
| 缺 | catalog → overlay → verification → lookup 全链路 | 完整 |

**ROI 评估**：qm-soul 的 `renderGatewayBlock`（段 ⑤）需要 catalog 抽象来稳定渲染顺序。qm 的 gateway-catalog 给出 cold-runtime resolution 模式（参照 commit `Hydrate the OpenRouter catalog on cold runtime resolution`）。

**行动建议**：在 `@qm/model` 新增 `gateway-catalog.ts`（cold-runtime hydration）+ `model-verification.ts`（capability-gated 验证）+ `model-overlay.ts`（per-scope 覆盖）。无需做 model-lookup（qm-next 已有）。

### 3.2 Background ownership transfer → `@qm/runs`

| 维度 | qm-next（`@qm/runs`） | qm 上游 |
|------|----------------------|---------|
| 模块 | `task-protection.ts` + `reaper.ts` + `drain.ts` + `instance-registry.ts` | `src/runs/background-ownership.ts` + `background-controller.ts` + `background-task-identity.ts` + `background-work.ts` |
| 缺 | 多实例间的 ownership transfer（handover / drain） | 完整 |

**ROI 评估**：qm 强调"blue-green + multi-instance"下 ownership 必须可转移（参见 qm AGENTS.md "Durable by default" 节）。qm-next 是 Cordis 单进程模型，但 P5 21.0 的 worker 进程拆分（blue-green）会撞上这个问题。

**行动建议**：在 P5 21.0 worker 拆分之前，先把 `background-ownership.ts` 的核心抽象（`Ownership` + `TransferToken` + `Lease`）作为纯类型层落地，避免到时候把 task-protection 拆掉重写。

### 3.3 Capability token compression

| 维度 | qm-next（`@qm/auth`） | qm 上游 |
|------|----------------------|---------|
| 模块 | `capability-token.ts` + `replay-dedupe.ts` | `src/auth/broker-sessions.ts` + `docs/capability-tokens.md` |
| 缺 | 压缩 / 分阶段推出开关 | 完整 |

**ROI 评估**：qm commit `Compress large capability tokens behind a staged rollout switch` 直接点名 token 体积问题。qm-next 的 capability-token 在 v1.0.0 切换时如果 token 膨胀，会成为性能瓶颈。

**行动建议**：在 `capability-token.ts` 加 `compressFlag` + `compress/uncompress` 工具函数，与 qm 同名（qm-verbatim 兼容）。这是低风险增量。

### 3.4 Sanitized error reporting（Sentry + PostHog）

| 维度 | qm-next | qm 上游 |
|------|---------|---------|
| 模块 | `@qm/api` 有 `GET /v1/admin/monitoring/summary` 但无 Sentry/PostHog SDK | `plugins/chassis/src/error-reporting.ts` + `src/util/product-analytics.ts` + `plugins/web-ui/src/product-analytics.ts` |
| 缺 | 错误聚合 + 公司级埋点 | 完整 |

**ROI 评估**：qm `Add sampled Sentry performance tracing` + `Add optional sanitized backend Sentry error reporting` + `Add optional company-scoped PostHog analytics` 三连点。qm-next 的 IM 平台不允许在 core 留平台符号（`check:im` 门禁），但 Sentry/PostHog 不是平台——可以加，但要放进 `plugins/chassis` 或独立 `@qm/telemetry` 包，保持 core 干净。

**行动建议**：在 P5 20.0 监控/合规轨道内，新增 `@qm/telemetry` 包，对接 Sentry + PostHog 双后端，core 服务无外部 SDK 符号（参照 qm `plugins/chassis/src/error-reporting.ts` 的注入模式）。

### 3.5 Tape canonical transcript + retirement check

| 维度 | qm-next | qm 上游 |
|------|---------|---------|
| 模块 | `@qm/store` tape/fold 已有，但无独立 spec | `docs/session-tape-spec.md`（完整 spec）+ `test/tape-canonical-transcript.test.ts` + `tape-retirement.test.ts`（763 行） |
| 缺 | spec 文档 + retirement 闸门 | 完整 |

**ROI 评估**：qm 的 `Fail transcript retirement checks on incomplete histories` commit 是数据完整性闸门。qm-next 的 tape/fold 没有 retirement 闸门，旧 tape 残留可能无限增长。

**行动建议**：在 P5 19.0 数据迁移 runbook 内增加 tape retirement 闸门。先把 `docs/session-tape-spec.md` 移植成 qm-next 自己的 spec 文档，再补 `tape-retirement.test.ts` 对拍。

---

## 4. P2：中 ROI 备选（4 项）

### 4.1 Direct file uploads + resumable

qm: `src/files/direct-file-upload.ts` + `file-upload-store.ts` + `upload-client.py` + `docs/files-publication.md`。
qm-next: `@qm/store` 有 `createPostgresFileStore` + `DurableByteStore`（local FS/memory 双后端，S3 延后）。

**建议**：qm-next 的 S3 延后决策可以保留，但 resumable upload + content-addressed 模式（`files/<sha256>`）可直接复用。等用户提出 S3 需求时再启用。

### 4.2 Sandbox abstraction layer

qm: `src/sandbox/exec-sandbox-base.ts`（统一抽象）+ E2B / Modal / Superserve 后端。
qm-next: `local-sandbox` 单后端，无抽象层。

**建议**：qm-next v1 不需要多后端（已显式决策）。**不动**。但若未来要支持企业内私有 sandbox，`exec-sandbox-base.ts` 模式可以参考。

### 4.3 Persistent subagent sessions + durable coordination

qm: `src/runs/background-controller.ts` + `background-task-identity.ts`。
qm-next: `@qm/harness-pi` / `claude` / `codex` / `opencode` 多引擎，但没有"持久 subagent"。

**建议**：qm 的 `Add persistent subagents with durable coordination and inline badges` 是新方向，与 qm-next 的"subagent"概念不同。qm-next 的 subagent 是 turn-scoped；qm 的 persistent 是 session-scoped + durable。

若 qm-next 不做持久 subagent，则**不动**。若想做，先把 P1 3.2 的 `background-ownership.ts` 落地。

### 4.4 Admin spend dashboard + time-series

qm: `src/api/routes/admin/spend.ts` + `model-registry.ts` + `docs/admin-model-verification.md` + `test/spend-rollup-parity.ts`（206 行）+ `test/spend-summary.test.ts`。
qm-next: `@qm/admin` 有 metrics / error-log / credential-usage / egress-audit / audit-log，但无 spend。

**建议**：P5 20.0 监控面板占位只给了 `uptime/库态/队列/crons/错误与审计计数`，未含 spend。若企业用户关心成本，spend dashboard 是高 ROI；否则**延后**到 v1.1。

---

## 5. P3：不动 / 战略外（6 项）

qm-next 已 suspend 或不在战略范围内，新 qm 即使提供，也不应"优化"引入：

| 项 | qm 上游 | qm-next 立场 |
|----|---------|-------------|
| Slack / 钉钉 / 企微 适配器 | 大量新增 | **suspended**（v1 渠道只做飞书） |
| Fly / AWS 部署 | Helm chart / RDS class / Sprites proxy / Service Connect | **not ported**（2026-09-22 决策） |
| Porter 沙箱后端 | `Porter sandbox backend` | **不部署 Porter** |
| E2B / Modal / Superserve | `Align the E2B/Modal/Sprites/Smolmachines backend with …` | local-sandbox 够用，S3 / 多后端延后 |
| agent37 沙箱 | `agent37 sandbox backend` | 不使用 |
| Desktop app | `desktop/` 目录 + `desktop-v0.1.0` tag | web + IM 即可，不做桌面 |

**外加不可 port 项**：
- 第三方 credentials（Composio / Composio-thread-identity / OAuth cards）→ 触发器门控，X1 suspend
- pg-boss、monitor-poller → 已 resolved 但留历史
- External Slack isolation → 不做外部 Slack

---

## 6. 决策建议（执行顺序）

### 短期（1-2 天）
1. **P0-2.1**：把 qm `tape-projection.test.ts`（1211 行）作为 qm-soul 的 parity-gate 参考实现。
2. **P0-2.4**：在 `frame-composer.ts` 增加 `boundedRecentContext` 兜底（对照 qm `runtime-recovery.ts`）。
3. **P0-2.3**：补 X3b 4b 的 admin 面 CRUD 路由（参照 qm `src/api/routes/admin/principal-links.ts`）。

### 中期（1 周）
4. **P1-3.1**：新增 `@qm/model/gateway-catalog.ts` + `model-verification.ts`，与 `model-gateway.ts` 拼接。
5. **P1-3.3**：`@qm/auth/capability-token.ts` 加压缩开关（qm-verbatim）。
6. **P1-3.5**：移植 `docs/session-tape-spec.md` 为 qm-next 自有 spec，写 `tape-retirement.test.ts`。

### 长期（视战略调整）
7. **P1-3.4**：P5 20.0 内新增 `@qm/telemetry` 包。
8. **P1-3.2**：P5 21.0 worker 拆分前，先把 `background-ownership.ts` 抽象落地。

### 不做（显式）
- P3 全部 6 项保持 suspend
- P2 全部 4 项按需启动，**不主动 port**

---

## 7. 验证方法

```bash
# 1. 检查 qm-next 当前在飞车道
cd <aa-root>
git -C repos/qm-next log --oneline -20

# 2. 检查 X3b 批 6 状态
git -C repos/qm-next log --oneline --grep="X3b" | head -10

# 3. 检查 qm-soul 状态
git -C ~/Git/_worktrees/aa-qm-soul log --oneline -10

# 4. 检查 qm 上游 HEAD（需代理）
cd repos/qm
git fetch origin
git log origin/main --oneline -1
# 期望：SHA == 8adee4b0（2026-09-26 同步点）
```

每次上游同步时同步更新：
- `todo/notes/qm-sync-YYYY-MM-DD.md`（基线记录）
- `todo/notes/qm-next-optimization-YYYY-MM-DD.md`（建议清单 update）

---

## 8. 风险

1. **P0 加速风险**：直接对照 qm 源码可能引入"qm 风格"代码，污染 qm-next 的 Cordis 风格。要克制在"参考契约 + 算法"，不要直接 import qm 源码。
2. **P1 增量风险**：3.1 gateway-catalog 是新模块，引入前先在 `parity-deviations.md` 标注为"qm 模型网关层平移"。
3. **P1 战略漂移**：3.4 telemetry 是新方向（qm-next 没做过后端 SDK 集成），需要在 ADR 评审后再开。
4. **P2 隐性扩展**：4.3 persistent subagent 与 qm-next 现有 subagent 概念不同，引入前需先收敛术语（CONTEXT.md 里 Run / Attempt / Session 的定义）。