---
mode: subagent
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->
# qm-next 优化决策 — 2026-09-26

基于 `qm-sync-2026-09-26.md`（上游 415 commits）和
`qm-next-optimization-2026-09-26.md`（P0/P1/P2/P3 全表），
把"实际执行哪个"收敛成可签字版。配套 follow-up
`qm-soul-followup-tape-2026-09-26.md`（M-Tape-0..3 ~3.5d）已落盘。

## 0. 决策矩阵（一页纸）

| 序号 | 项 | 状态 | 决策 | 理由 |
|------|----|------|------|------|
| **D1** | M-Tape-0..3 (P0-2.1+2.2, P1-3.5) | follow-up 已写 | **执行** | 收口 qm-soul + 接通 renderer；阻塞 P5 19.0 落地 |
| **D2** | P1-3.3 capability token 压缩 | 未做 | **执行** | 低风险 0.5d；任何规模前的瓶颈预防 |
| **D3** | P1-3.2 background ownership 抽象 | 未做 | **执行（仅类型层）** | P5 21.0 worker 拆分的前置；类型先行、实施延后 |
| **D4** | P1-3.1 model gateway catalog | 未做 | **延后** | qm-soul `renderGatewayBlock` neutralized 已工作；性能 / 多 provider 不是当下瓶颈 |
| **D5** | P1-3.4 Sentry/PostHog telemetry | 未做 | **延后至 v1.0.0** | 新方向 + 新包 + ADR；v1.0.0 之后用户验证后再投入 |
| **D6** | P2 全部 4 项 | 未做 | **延后** | 按需启动；现无具体需求 |
| **D7** | P3 全部 6 项 | 未做 | **不做** | 与 qm-next 战略显式冲突 |
| **D8** | P0-2.3 / P0-2.4 | 已做 | **不动** | 已 closed |

**总预算**：~5d ai（3.5d M-Tape + 0.5d token 压缩 + 1d ownership 抽象类型层）
**对照**：qm-soul 总预算 ~7d；本批为 qm-soul 的 70% 量级，但风险显著低
（全部是 port/拼装/类型；不是新设计）

---

## 1. 决策细节

### D1：执行 M-Tape-0..3（~3.5d）

**理由**：
- 阻塞 P5 19.0 数据迁移 runbook（"session_tape renderer 投影" 章节承诺兑现）
- 修复当前隐患（model 视图是 fold 全新；renderer 视图是 legacy 重建 → 两边不一致）
- 全部是 qm-verbatim port（539L + 33L），不是新设计 → review 风险低
- 与 qm-soul 主线不冲突；M-Soul-5 已收口，本批接续

**入口/出口**：见 `qm-soul-followup-tape-2026-09-26.md` §3 详细任务表

**优先级**：**最高**。如果只能做一个，做 M-Tape-1（projection + TranscriptSource），
M-Tape-0/2/3 是它的配套。

### D2：执行 capability token 压缩（~0.5d）

**为什么这个时机**：
- v1.0.0 之前不会有规模，但 token 体积随 `grantedHandles` / `sharedFiles`
  增长
- qm 上游有 `Compress large capability tokens behind a staged rollout switch`
  → 同样的预防
- qm-verbatim 移植 → 风险最低
- 不需要新 ADR（capability token 已有 ADR-0017 oauth-token-encryption-at-rest）

**实施要点**：
- 在 `packages/auth/src/capability-token.ts` 加 `compressFlag` 字段（默认关）
- 加 `compressPayload(obj)` / `decompressPayload(s)` 工具函数（与 qm 同名）
- qm-verbatim 命名 + 行为 → 偏差表登记 #59
- 触发压缩阈值：payload 字节数 ≥ 1024 → gzip + base64；< 1024 直传
- `pnpm test` + `pnpm test:pg` 双向验证（PG 存储兼容性）
- 默认关 → 启用需部署配置 opt-in，避免静默改线上协议

**ROI**：未来 6 个月省 1-2 次事后返工。

### D3：执行 background ownership 抽象（仅类型层，~1d）

**为什么是"仅类型层"**：
- P5 21.0 worker 拆分时需要跨实例的 ownership transfer
- 现在写实现是过早（单进程 Cordis 没有 ownership 概念）
- **先定抽象**：把 `Ownership` / `TransferToken` / `OwnershipLease` 三个类型
  落到 `packages/runs/src/ownership.ts`（新文件），仅契约
- 接 `task-protection.ts`（已有）：增加 `tryHandoverOwnership(lease, token)` /
  `acceptHandover(token)` 两个 stub 函数（先 throw "not yet implemented"）
- 等 P5 21.0 启动时填充实现，task-protection 已有 caller 不需要改

**理由**：
- 类型先行保证 21.0 启动时不需要拆 task-protection 重写
- stub 函数让现有 caller 编译通过，未来填充实现无 breaking change
- 不阻塞任何当前工作（P5 21.0 是远期）

**不要做的**：
- 不要写 PG twin（21.0 阶段才做）
- 不要写 memory twin（21.0 阶段才做）
- 不要写 reaper 集成（21.0 阶段才做）

### D4：延后 model gateway catalog（不立即做）

**理由**：
- qm-soul `renderGatewayBlock` 已 neutralized 工作（不依赖 catalog）
- `@qm/model/model-gateway.ts` 已 functional（CLI token 端点参数注入 OK）
- gateway-catalog 主要是 OpenAI org cache key 优化（qm FF2），qm-next v1
  是单进程 + 单 harness，无此优化需求
- 多 provider routing 不是 v1 渠道（飞书）瓶颈

**何时重启**：
- 用户提出"多 provider 切换"或"model 元数据静态优化"需求
- 或 P5 21.0 worker 拆分后多进程需要 model 元数据稳定来源

**维护动作**：
- 在 `docs/parity-deviations.md` 加 ## Model Gateway Catalog（2026-09-26）节
  标 #60 延期，引用 qm `src/model/gateway-catalog.ts` 为未来参考
- 关闭 P1-3.1（不再"待做"）

### D5：延后 telemetry（Sentry + PostHog）至 v1.0.0

**理由**：
- 全新方向：qm-next 没引入过外部 SDK；要新包 `@qm/telemetry` + ADR
- v1.0.0 之前用户量小（飞书 v1 渠道 + dev instance），人工日志足够
- 风险面：第三方 SDK 可能引入 IM 平台词（污染 `check:im` 门禁）
- 时间成本：新包 + ADR + 新增测试套件 ≈ 2-3d；非紧迫

**何时启动**：
- v1.0.0 发布后第一个月，看用户报告的痛点
- 或生产环境出现 P0 级问题，需要 Sentry 才能定位

**维护动作**：
- 关闭 P1-3.4
- 不加 parity-deviations entry（这是新方向，不是 qm parity 项）

### D6：延后 P2 全部 4 项（按需）

| P2 项 | 何时重启 |
|-------|----------|
| Direct file uploads + resumable | S3 接入需求出现时 |
| Sandbox abstraction layer | 私有 sandbox 需求出现时（qm-next v1 不部署企业内私有） |
| Persistent subagent sessions | 用户报告"subagent 跨 turn 状态丢失"时 |
| Admin spend dashboard | 用户报告"成本不可见"时 |

**维护动作**：全部关闭 P2 项目，不入 follow-up；用户提需求时新建 task。

### D7：P3 不做（与战略冲突）

qm-next 已显式 suspend：Slack / 钉钉 / 企微 / Fly / AWS / Porter / E2B /
Modal / Superserve / agent37 / Helm / 外部 Slack isolation / 桌面 app。
qm 上游在这些方向上的 415 commits 不视为"优化候选"。

**维护动作**：
- 把 P3 6 项在 `qm-next-optimization-2026-09-26.md` 标注 ## "不动 / 战略外"
  与 qm-next 战略决策交叉引用
- 不入 parity-deviations（这是战略 suspend，不是技术延期）

### D8：P0-2.3 / P0-2.4 标 closed

- **P0-2.3 X3b admin 面 policy CRUD**：commit `0ee532a` 已实现
  `GET/PUT/DELETE /v1/admin/scopes/:scope/command-policy` +
  `command-policy-simulate` 路由（`admin-routes.ts:1603-1605`）。✅
- **P0-2.4 frame composer 兜底**：commit `e59eb64` 已实现
  `composeFrame` + `selectFrameMode` + `deriveSurfaceTools`（qm
  orchestrator.ts:857-862 语义）+ `boundedRecentContext` 落在 stable prefix
  与 boundary 之间。✅

**维护动作**：在 `qm-next-optimization-2026-09-26.md` 把这两项状态改为
"closed（X3b 4b / M-Soul-3.1）"，附 commit 引用。

---

## 2. 执行时序（一周视角）

| 日 | 工作 | 来源 |
|---|------|------|
| **D+1..3.5** | M-Tape-0..3 | follow-up 文件 |
| **D+4** | capability token 压缩 + 测试 + parity-deviations #59 | 本文件 D2 |
| **D+5** | background ownership 抽象（类型层）+ stub + ADR 草稿 | 本文件 D3 |
| **D+6..7** | 文档收口：parity-deviations #56-#60 + CHANGELOG | 全部 |

**关键节点**：
- D+3.5：M-Tape-3 闸门 `pnpm check:tape-renderer` 绿
- D+4：capability token 压缩双向 PG 兼容绿
- D+5：`pnpm typecheck` + `pnpm test` + `pnpm test:pg` 全绿
- D+7：CHANGELOG + 打 tag `optim-2026-09`

**阻塞**：
- 若 M-Tape-1 的 qm-verbatim 移植遇到 typecheck 不通过（qm 风格 `unknown`
  cast），需要先在 `repos/qm-next/types` 加窄类型，预计 +0.5d
- 若 P1-3.3 capability token 压缩的 gzip 在 PG 路径有兼容问题，回退到
  deflate，预计 +0.5d
- 若 background ownership 抽象与 task-protection.ts 现有 lease 冲突，
  改 task-protection.ts 的 lease 类型，预计 +0.5d

**总缓冲**：~5d 实做 + 1.5d 缓冲 = 6.5d ai；约 1.5 周

---

## 3. 决策检查清单（签字前）

- [ ] qm 上游 415 commits 已看完分类（`qm-sync-2026-09-26.md`）
- [ ] qm-next 当前 5 在飞车道已确认位置（qm-soul tag `soul` + X3b 批 6 收口 + T1-T4 wire + Q3-Q4 段序 + P5 18.0/19.0/20.0/21.0）
- [ ] M-Tape follow-up 已读完 + 接受（M-Tape-0..3 ~3.5d）
- [ ] D2 capability token 压缩范围已认可（仅压缩 payload，不改 token 结构）
- [ ] D3 ownership 抽象"仅类型层"决策已认可（实施延后到 P5 21.0）
- [ ] D4 model gateway catalog 延期决策已认可（关闭 P1-3.1）
- [ ] D5 telemetry 延后至 v1.0.0 决策已认可（关闭 P1-3.4）
- [ ] D6 P2 全部按需决策已认可（关闭 P2 全表）
- [ ] D7 P3 不动决策已认可（与 qm-next 战略一致）
- [ ] D8 P0-2.3 / P0-2.4 closed 确认

---

## 4. 不在决策表内的事项

| 事项 | 处理 |
|------|------|
| qm 下次上游同步（预计 1-2 周内） | 走 `qm-sync-YYYY-MM-DD.md` 流程；本决策不绑日期 |
| qm-soul tag `soul` 已发 | 不动；本批在 tag 之后 |
| P5 19.0 数据迁移 runbook | 已被 M-Tape-0 spec 落盘兑现；runbook 维护者更新引用即可 |
| v1.0.0 发布 checklist | 本批不绑；D5 决策影响 v1.0.0 后的 telemetry 启动 |

---

## 5. 决策一句话总结

> **执行 3 项**：M-Tape-0..3（renderer 投影接通）+ capability token 压缩
> （瓶颈预防）+ background ownership 类型层（P5 21.0 前置）。**延后 6 项**：
> model gateway / telemetry / 4 项 P2。**不做 6 项**：P3 全部（与 qm-next
> 战略显式冲突）。**2 项 P0 已 closed**：X3b admin 面 policy CRUD + frame
> composer 兜底。总预算 ~5d ai，1.5 周完成。

---

## 6. 文件落点

本决策与以下文件配套：

- `todo/notes/qm-sync-2026-09-26.md`（基线记录）
- `todo/notes/qm-next-optimization-2026-09-26.md`（P0/P1/P2/P3 全表 + 本批收口状态）
- `todo/notes/qm-soul-followup-tape-2026-09-26.md`（M-Tape-0..3 详细任务）
- `todo/notes/qm-next-decision-2026-09-26.md`（**本文件**）

执行完每项后更新对应文件的 ## 状态节，并在 CHANGELOG 同步条目。