# Product Requirements Document: qm-post-soul — qm-soul 收口后优化批

<!--TOON:prd{id,feature,author,status,est,est_ai,est_test,est_read,logged,started}:
prd-qm-post-soul,qm-post-soul（renderer 投影 + token 压缩 + ownership 抽象）,wxd + AI DevOps,planning,~5d,~4d,~1d,~2h,2026-09-26T00:00Z,
-->

## Overview

**Feature:** qm-post-soul — qm-soul tag `soul` 落地（commit `3d956f1` 等，2026-09-21）后，在 qm-next 上完成三项优化：renderer 投影接通、capability token 压缩、background ownership 类型层抽象。源：2026-09-26 qm 上游同步（qm @ `8adee4b`），对照产出 4 份记录文档。

**Author:** wxd + AI DevOps

**Date:** 2026-09-26

**Status:** Planning（决策记录于 `todo/notes/qm-next-decision-2026-09-26.md`；详细对照分析在 `todo/notes/qm-next-optimization-2026-09-26.md`；M-Tape 详细任务在 `todo/notes/qm-soul-followup-tape-2026-09-26.md`）

**Estimate:** ~5d ai 总工作量；3 车道并行墙钟 ~3.5d

**前置:**
- `qm-soul` (tag `soul`, 2026-09-21) — frame composer + protocols + 真 ResolutionService + SoulStore PG twin + guidance 激活 + mode selection + `pnpm check:soul` 门禁
- `X3b Command Gate` (commits `e59eb64`/`3fbfacc`/`0ee532a`/`8a7022b`) — admin 面 policy CRUD + scannableCommand + per-scope policy storage
- `T1-T4 ToolContext` (commit `dde65fb`) — crons/webhooks/MCP/share 控制平面接线
- `qm @ 8adee4b` (2026-09-26) — 415 commits，含 `src/harness/tape-projection.ts`（539L）+ `runtime-recovery.ts`（33L）+ `docs/session-tape-spec.md`（320L）

**归宿:** [PLANS.md p003 Active 段](../../PLANS.md)

### Problem Statement

qm-next 当前 4 个真实问题：

1. **renderer 视图与 harness 视图不一致**：qm-soul 后 fold（harness-pi `tape-fold.ts` 260L）写进 model 上下文，但 admin / web-ui / inbox 渲染仍读 legacy `getEntries()` 重建 → 模型看到的是 fold 全新字节，UI 看到的是 entries 重建。qm 上游 P5 19.0 假设"fold(tape, audience) 单源"，qm-next 入口未接通。
2. **capability token 无压缩**：`packages/auth/src/capability-token.ts`（104L）随 `grantedHandles` / `sharedFiles` 增长，单 token 体积会突破 transport 阈值；qm 上游有 `Compress large capability tokens behind a staged rollout switch` 同主题 commit。
3. **P5 21.0 worker 拆分无前置**：当前 `@qm/runs` 的 `task-protection.ts` 单进程有效；多实例拆分时跨实例 ownership transfer 没有抽象边界。
4. **缺 spec 文档**：qm 上游有 320L `docs/session-tape-spec.md`；qm-next 没有可引用的 spec，迁移 runbook 缺引用源。

### Goal

把 qm-soul 后的 qm-next 推到 v1.0.0-ready：
- renderer 视图也走 tape fold，**模型视图与渲染视图字节一致**（`pnpm check:tape-renderer` 闸门）
- capability token 在 ≥ 1024 字节时自动压缩（gzipped base64）；默认关，opt-in 启用
- `Ownership` / `TransferToken` / `OwnershipLease` 类型落地，`task-protection.ts` 增加 stub 函数为 P5 21.0 留 seam
- 落 qm-next 自己的 `docs/session-tape-spec.md` 作为迁移 runbook 引用源

**成功判据：**
- `pnpm check:tape-renderer` 绿（cold-rebuild 后 fold(tape) === forRender(tape).entries）
- capability token 压缩：双向 PG 兼容测试通过；opt-in 部署配置可启用
- `Ownership` 类型已导出；`task-protection.ts` 增加 stub 函数（throw "not yet implemented"）；现有 caller 编译通过
- 文档：`docs/session-tape-spec.md` 已落 + `parity-deviations.md` 已加 #56-#60 条目

### Non-goals（显式不做）

- Slack / 钉钉 / 企微 适配器 — qm-next 战略 suspend
- Fly / AWS 部署端口 — qm-next 战略 not ported
- Porter / E2B / Modal / Superserve / agent37 沙箱后端 — qm-next 单进程 local-sandbox 够用
- 桌面 app（`desktop/`） — qm-next web + IM 即可
- 外部 Slack isolation — qm-next 不做外部 Slack
- Tape retirement（冻结 + 退役 + 替换三态） — qm-next v1 不做；接口预留实现延后
- Model gateway catalog / overlay / verification — qm-soul `renderGatewayBlock` 已 neutralize 工作，非当下瓶颈
- Sentry / PostHog telemetry — 全新方向 + 新包 + ADR；v1.0.0 之后用户验证后再投入
- Persistent subagent sessions + durable coordination — 全新方向，未在 qm-next 路线图
- Admin spend dashboard + time-series — 用户未提需求，按需启动

## User Stories

- 作为 **admin/web-ui 用户**：我看到的内容与模型上下文字节一致；不出现"模型说 X 但 UI 显示 Y" 的诡异偏差。
- 作为 **平台运营者**：我把 capability token 体积控制住；不因 token 膨胀触发 transport 失败或成本上升。
- 作为 **P5 21.0 worker 拆分启动者**：跨实例 ownership transfer 有类型契约可签，不必拆 `@qm/runs` 现有 lease 重写。
- 作为 **qm-next 维护者**：所有 qm-verbatim 平移都有 spec 文档 + parity-deviations entry 可追溯。

## Functional Requirements

### Lane A：M-Tape-0..3（renderer 投影接通，~3.5d）

**M-Tape-0 Spec 落盘（~0.5d）**
1. `repos/qm-next/docs/session-tape-spec.md`（qm-verbatim 翻译 + qm-next 立场标注）：320L；Image references / Migration / Resolved questions 三节必保。
2. `repos/qm-next/docs/parity-deviations.md` 加 ## Tape Renderer Projection（2026-09-26）节，登记 #56 #57 #58 三条延期。
3. `repos/qm-next/docs/migration.md` 第 19.0 "session_tape" 节末尾链接新 spec。

**M-Tape-1 Projection + TranscriptSource（~1.5d）**
4. `repos/qm-next/packages/store/src/tape-projection.ts`（新文件，qm-verbatim port 539L）：
   - A 段：类型与切片（DraftEntry / DraftEvent / TapeMessage / BoundAnnotation + renderableTapeSlice / tapeHasRenderBlockers / entryMirror / boundAnnotation / userDraft / toolResultDraft）
   - B 段：投影主循环（projectTapeEntries，opts.anchored 锚点 + coarse run + settle 算法）
   - C 段：读源抽象（createTranscriptSource + forRender / forViewer + 锚点 / 限额 / 参与者窗口）
   - D 段：searchRowsFromEntries（admin / 全文搜索依赖）
5. 不变量：同一 `tape + audience` 产出同一 `entries[]`
6. 类型守卫：qm 风格 `unknown` cast 在 qm-next typecheck 必须收敛到具体 union 类型；不允许 `as any`
7. 测试套件：`repos/qm-next/packages/store/tests/tape-projection.test.ts` — 取 qm `test/tape-projection.test.ts` 至少 50 行种子用例（coverage gap / coarse run / mirror involvement / interrupt heal）

**M-Tape-2 Runtime Recovery（~0.5d）**
8. `repos/qm-next/packages/runs/src/runtime-recovery.ts`（qm-verbatim port 33L）：
   - `recoveredRuntime(entries, runId, actorId): RuntimeChoice | undefined`
   - 反向扫描 session entries，匹配 `tool='runtime' && runId && actorId && runtimeHandoff.choice` 的最新一条
   - 类型守卫：`isHarnessId(choice.harnessId)` + `typeof choice.modelId === 'string'`
9. 接 `repos/qm-next/packages/orchestrator/src/orchestrator.ts:107` 周边：harness `resolveChoice` 前先 `recoveredRuntime(history, runId, actorId)` → 找到则用作 fallback
10. 测试：3 条连续 tool_result 中取最新；不存在时返 undefined

**M-Tape-3 渲染路径接通 + 字节对拍闸门（~1d）**
11. `repos/qm-next/packages/api/src/service.ts` 暴露 `createTranscriptSource(deps.sessions)`
12. `@qm/admin` 的 transcript / spend / error 视图：替换 `getEntries → forRender`
13. `@qm/web-ui` 的 chat / inbox / contexts 视图：替换 `getEntries → forRender`
14. `@qm/web-ui` 的 personal-scope tool result 过滤：用 `entryWithinTenure` + `forViewer`
15. **新门禁 `pnpm check:tape-renderer`**（`repos/qm-next/scripts/check-tape-renderer.sh`）：cold-rebuild 后 `fold(tape) === forRender(tape).entries`；失败即 fail；接 `pnpm check:im` 同级
16. parity-deviations #56/#57/#58 → closed；CHANGELOG + tag `tape-renderer`

### Lane B：Capability Token 压缩（~0.5d）

17. `repos/qm-next/packages/auth/src/capability-token.ts`（现有 104L + 增量）：
    - 加 `compressFlag` 字段（默认关）
    - 加 `compressPayload(obj)` / `decompressPayload(s)` 工具函数（与 qm 同名）
18. 触发压缩阈值：payload 字节数 ≥ 1024 → gzipped base64；< 1024 直传
19. parity-deviations #59 登记：qm-verbatim 命名 + 行为
20. `pnpm test` + `pnpm test:pg` 双向验证（PG 存储兼容性）
21. 启用需部署配置 opt-in（`packages/auth/config/compress-tokens: true`），避免静默改线上协议

### Lane C：Background Ownership 类型层（~1d）

22. `repos/qm-next/packages/runs/src/ownership.ts`（新文件）：定义 `Ownership` / `TransferToken` / `OwnershipLease` 三个类型
23. 接 `repos/qm-next/packages/runs/src/task-protection.ts`（已有）：增加 stub 函数
    - `tryHandoverOwnership(lease: OwnershipLease, token: TransferToken): Ownership | undefined` → throw "not yet implemented"
    - `acceptHandover(token: TransferToken): Ownership | undefined` → throw "not yet implemented"
24. **不写实现**：PG twin / memory twin / reaper 集成全部延后到 P5 21.0 启动
25. 测试：stub 函数行为正确（throw）；类型契约编译通过
26. 文档：ADR-0020 草稿（`docs/adr/0020-background-ownership-types.md`），说明 P5 21.0 启动时如何填充

### 汇合验收（~0.5d）

27. `pnpm typecheck` 全绿
28. `pnpm test` 全绿
29. `pnpm test:pg` 全绿
30. `pnpm check:im` 全绿（新增 `tape-projection.ts` 在 CORE_SOURCES 范围内）
31. `pnpm check:soul` 全绿（qm-soul 遗留门禁）
32. `pnpm check:tape-renderer` 全绿（M-Tape-3 新门禁）
33. parity-deviations 收口（#56-#60 closed）+ CHANGELOG + 打 tag `optim-2026-09`

## Architecture Decisions

### 决策记录

| 序号 | 决策 | 理由 |
|------|------|------|
| AD-1 | M-Tape-1 落 `packages/store/src/tape-projection.ts` 而非 `harness-pi` | renderer 投影是 store 层职责（读源抽象）；harness-pi 已在 `tape-fold.ts`（model 输入 fold） |
| AD-2 | capability token 压缩默认 opt-in | 静默改线上协议风险高；部署配置 opt-in 启用 |
| AD-3 | ownership 仅类型层 + stub 函数 | P5 21.0 远期；先定抽象避免 21.0 启动时拆 task-protection 重写 |
| AD-4 | tape retirement 不在本批 | qm-next v1 决策明确不做冻结 + 退役；接口预留但实现延后 |
| AD-5 | telemetry 延后至 v1.0.0 | 全新方向 + 新包 + ADR；非紧迫 |

### 与既有 ADR 的关系

- **ADR-0017** (`oauth-token-encryption-at-rest`)：capability token 加密已定；本批压缩层在加密之上、之前
- **ADR-0018** (`soul-layer-is-composed-protocol-frames`)：frame composer 兜底已定；M-Tape 是 renderer 视图的对应
- **ADR-0001** (`run-owns-terminal-events-and-observation`)：observation 路径未变；transcript 视图变更不影响
- **ADR-0007** (`turn-admission-is-an-orchestrator-seam`)：orchestrator seam 扩展最小化（runtime recovery 是 fallback 路径）

## Risk & Mitigation

| 风险 | 缓解 |
|------|------|
| qm-verbatim port 1.1-1.4 大段抄（539L + 33L），qm 风格 `unknown` cast 与 qm-next strict typecheck 冲突 | 先写 type signature（union 类型）再 copy body；不允许 `as any` |
| coarse run 在 qm-next 多引擎（pi/claude/codex/opencode）触发频率高 | 测试套件覆盖多引擎组合；coarse run 用例 |
| memory+PG 双实现对称 | projection 是纯函数无 I/O；测试时分别走两侧 SessionStore 验证一致 |
| renderer 视图漏接 IM 平台词 | `check:im` 门禁扩展到 `tape-projection.ts` |
| capability token 压缩在 PG 路径不兼容 | 准备回退到 deflate；双向 PG 测试提前跑 |
| ownership stub 与现有 lease 类型冲突 | 先做 type-only import；不改 `task-protection.ts` 现有 caller |

## Out of Scope（已 explicit 不做）

| 项 | 原因 |
|----|------|
| Slack / 钉钉 / 企微 | qm-next 战略 suspend |
| Fly / AWS / Porter / E2B / Modal / Superserve / agent37 | qm-next 单进程 + 本地 sandbox |
| 桌面 app / 外部 Slack / Helm chart | qm-next 战略外 |
| Tape retirement 冻结 | qm-next v1 不做 |
| Model gateway catalog / overlay / verification | qm-soul 已 neutralize |
| Sentry / PostHog telemetry | v1.0.0 之后 |
| Persistent subagent sessions | 新方向，未在路线图 |
| Admin spend dashboard | 用户未提需求 |

## Related Documents

- `todo/notes/qm-sync-2026-09-26.md` — qm 上游 415 commits 同步基线
- `todo/notes/qm-next-optimization-2026-09-26.md` — P0/P1/P2/P3 全表 + closed/延后/不做 收口
- `todo/notes/qm-soul-followup-tape-2026-09-26.md` — M-Tape-0..3 详细任务（lane A 展开）
- `todo/notes/qm-next-decision-2026-09-26.md` — 决策记录（3 执行 / 6 延后 / 6 不做 / 2 closed）
- `repos/qm-next/docs/architecture.md` — 架构总览
- `repos/qm-next/docs/parity-deviations.md` — 对齐偏差（将增 #56-#60 五条）
- `repos/qm-next/docs/migration.md` — 数据迁移 runbook（19.0 节将引用新 spec）
- `repos/qm-next/CHANGELOG.md` — 变更日志（将增 [Unreleased] 段）