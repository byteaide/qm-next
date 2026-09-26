---
mode: subagent
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->
# Follow-up: qm-soul 收口后的下一站 — Tape 投影 + Spec 文档 + Runtime Recovery

基于 2026-09-26 上游同步（qm @ 8adee4b），对照 qm-soul 已落地代码与 qm
tape 子系统的差异，输出具体 follow-up。挂在 qm-soul tag 之后，作为
`M-Tape-0..3` 串行批；不抢 M-Soul-5 已收口位。

## 0. TL;DR

qm-soul 把"系统 prompt 是 16 段顺序组装"这件事做完了（ADR-0018 + frame
composer + 真 ResolutionService + SoulStore PG twin + guidance 激活 +
mode selection + tag `soul`）。但 **tape 的另一半——renderer 投影 + spec
文档 + 运行时恢复——没有跟上**：

| 项 | qm | qm-next | 影响 |
|----|---|---------|------|
| **Harness-facing fold**（message 数组） | `src/harness/tape-fold.ts` (~300L) | `packages/harness-pi/src/tape-fold.ts` (260L) | ✅ 已对拍 |
| **Renderer-facing projection**（SessionEntry[]） | `src/harness/tape-projection.ts` (539L) | **❌ 缺失** | 渲染路径仍走 legacy `getEntries` |
| **`createTranscriptSource`**（读源抽象） | `tape-projection.ts` 内 102L | **❌ 缺失** | admin / web-ui 渲染零对拍目标 |
| **`docs/session-tape-spec.md`** | 320L | **❌ 缺失** | 迁移 runbook 缺 spec 引用 |
| **`runtime-recovery.ts`** | 33L | **❌ 缺失** | 上下文崩后无法找回 runtime choice |
| **`tape.fold.test.ts`** | 169L | ✅ 有（`packages/harness-pi/tests/harness-pi.test.ts:327`） | fold 路径已有覆盖 |
| **`tape-projection.test.ts`** | **1211L** | **❌ 缺失** | 投影测试套件是 qm 最大单文件 |
| **`tape-parity-gate.test.ts`** | 45L | **❌ 缺失** | 字节对拍闸门未引入 |
| **`tape-retirement.test.ts`** | 763L | **❌ 缺失** | 旧 tape 退役检查 |

**结论**：qm-next 走的是"先把 fold 做成 harness 输入"路线，这是对的
（model 看到的字节稳定 = cache 稳定 = qm 主张的核心收益）。但 **renderer
侧读源还在 legacy entry 重建**——这意味着 tape 写了但没读，模型是新鲜的
fold，admin / web-ui 看到的是 legacy 重建，**两者不一致**。P5 19.0 数据
迁移 runbook 已经假设"fold(tape, audience) 单源"，但入口还没接通。

**建议**：开 `M-Tape-0..3` 串行批，照 qm tape-projection.ts 路径收口，不
改 M-Soul 既有决定。

---

## 1. 当前 qm-next tape 现状（截至 acd05fd）

### 1.1 schema / 存储

| 位置 | 内容 | 状态 |
|------|------|------|
| `packages/store/src/schema.ts:75` | `CREATE TABLE IF NOT EXISTS session_tape(...)` | ✅ |
| `packages/store/src/schema.ts:81` | `CREATE INDEX IF NOT EXISTS session_tape_session_seq ON session_tape(session_id, seq)` | ✅ |
| `packages/store/src/postgres-session-store.ts:263,281,304,309,527` | tape 写入（lease-checked）+ 读取（asc/desc）+ 删除 | ✅ |
| `packages/store/src/memory-session-store.ts:54,168-187,338` | 内存 tape（Map<sessionId, TapeRecord[]>） | ✅ |
| `packages/types/src/session-store.ts:198` | `getTape(sessionId, opts?: GetTapeOptions)` 契约 | ✅ |

### 1.2 fold（harness-facing）

| 位置 | 内容 |
|------|------|
| `packages/harness-pi/src/tape-fold.ts:1-260` | `rehydrateFoldImages` + `foldTape` + `planTapeSeed` + `healFoldInterrupt` + `lintFold` |
| `packages/harness-pi/tests/harness-pi.test.ts:327` | dangling / healed 对拍 |

### 1.3 缺失部分（**这是 follow-up 的真正抓手**）

| 缺失 | 影响面 |
|------|------|
| `projectTapeEntries(sessionId, rows, opts?)` | 渲染路径需要从 `SessionEntry[]` 读 — admin / web-ui / inbox / search 都依赖 |
| `createTranscriptSource(store)` | 抽象读源入口（forRender + forViewer + 锚点 + 限额） |
| `renderableTapeSlice(rows)` | 渲染版本切片（`render_import` 截断 + `legacy_import` 阻断） |
| `tapeHasRenderBlockers(rows)` | 闸门（legacy_import / legacy_patch 阻断服务） |
| `entryMirror(row)` / `boundAnnotation(row)` | 把 `annotation` 行翻回 `SessionEntry[]` 形态 |
| `userDraft` / `toolResultDraft` | user / toolResult 行重塑 |
| `coverage gate` | `coveredSeq >= latestEntrySeq` 检查 + watermark 锁定 |
| `searchRowsFromEntries` | 搜索行生成（admin / 全文搜索依赖） |

---

## 2. qm tape-projection.ts 入口拆解（对照目标）

qm `src/harness/tape-projection.ts`（539 行）三段：

```
A. 类型与切片（1-100）
   - DraftEntry / DraftEvent / TapeMessage / BoundAnnotation
   - renderableTapeSlice / tapeHasRenderBlockers / entryMirror / boundAnnotation
   - userDraft / toolResultDraft

B. 投影主循环（199-395）
   - projectTapeEntries(sessionId, tapeRows, opts?)
   - opts.anchored：用 boundAnnotation 锚点 → 锚点前为 base
   - 主循环：扫描每行 → 产出 DraftEvent[]（item / bound / coarse）
   - 末尾 settle 算法：把 DraftEvent 解析为 SessionEntry[] + coveredSeq + baseSeq

C. 读源抽象（419-521）
   - TranscriptStore pick
   - createTranscriptSource(sessions)
     - projected() 内部逻辑：latestEntrySeq → cap → getTape → projectTapeEntries
     - forRender / forViewer / with 锚点 + 限额 + 参与者窗口
   - searchRowsFromEntries(entries, sinceSeq)：搜索行生成

D. 测试覆盖（1211 行 test/tape-projection.test.ts + 763 行 tape-retirement.test.ts）
   - 字节对拍、coarse run、mirror involvement、interrupt heal、retirement 闸门
```

qm-next 的对位应当落在 **`packages/store/src/tape-projection.ts`**（与
`tape-fold.ts` 同包不同文件）——renderer 投影是 store 层职责（属于读源
抽象），不属于 harness-pi（harness 已在 `tape-fold.ts`）。

---

## 3. 提议：M-Tape-0..3 串行批

### M-Tape-0 Spec 落盘 + parity-deviations 登记（~0.5d）

**目标**：把 qm `docs/session-tape-spec.md`（320L）以 qm-next 风格移植，
并在 `docs/parity-deviations.md` 加一条 entry 记录 renderer 投影的延期。

- [ ] 0.1 `repos/qm-next/docs/session-tape-spec.md`（qm-verbatim 翻译）
  - 不删 "Image references" / "Migration" / "Resolved questions" 三节；
    它们是契约
  - 标注 qm-next 立场：cordis 单进程 + memory+PG 双实现 + 飞书 v1 渠道
  - 在 "What this buys" 节注明：qm-next 当前 fold（harness-pi）已落地，
    projection（store）未落地；模型视图新鲜、渲染视图 legacy，**不一致**
- [ ] 0.2 `repos/qm-next/docs/parity-deviations.md` 加 ## Tape Renderer Projection（2026-09-26）
  - 引 qm `src/harness/tape-projection.ts:1-539` 作为参考实现
  - 标 #56 / #57 / #58 三个偏差：
    - **#56**：`projectTapeEntries` 缺失（qm-verbatim 移植起点）
    - **#57**：`createTranscriptSource` 缺失（qm-verbatim 移植起点）
    - **#58**：`runtime-recovery.ts` 缺失（qm-verbatim 移植起点）
- [ ] 0.3 在 P5 19.0 数据迁移 runbook (`docs/migration.md`) 引用新 spec：
  - 19.0 "session_tape" 节末尾链接 `docs/session-tape-spec.md`

### M-Tape-1 Projection + TranscriptSource（~1.5d）

**目标**：port qm tape-projection.ts A/B/C 三段到
`packages/store/src/tape-projection.ts`，接入 qm-next SessionStore。

- [ ] 1.1 类型与切片段（qm L1-100 移植）
  - `DraftEntry` / `DraftEvent` / `TapeMessage` / `BoundAnnotation` 类型
  - `renderableTapeSlice(rows)`：找最近 `render_import` 截断
  - `tapeHasRenderBlockers(rows)`：`legacy_import` / `legacy_patch` 阻断
  - `entryMirror(row)` / `boundAnnotation(row)`：annotation → DraftEntry 翻
  - `userDraft` / `toolResultDraft`：message → DraftEntry 翻
  - **qm-verbatim 命名 + 行为**（偏差表登记）
- [ ] 1.2 投影主循环段（qm L199-395 移植）
  - `projectTapeEntries(sessionId, tapeRows, opts?)`
  - opts.anchored 锚点逻辑
  - 主循环：kind 分流 + coarse run + coveredSeq 累加
  - settle 算法：DraftEvent[] → SessionEntry[] + coveredSeq + baseSeq
  - **关键不变量**：同一 `tape + audience` 产出同一 `entries[]`
  - 测试覆盖：coverage gap、coarse run、mirror involvement、interrupt heal
- [ ] 1.3 `createTranscriptSource(sessions)` 段（qm L419-521 移植）
  - TranscriptStore pick: `getEntries | visibleEntries | getTape |
    latestEntrySeq | participantWindowsOf` + 可选
    `getTranscriptEntries | canReadTranscriptSuffix`
  - `projected()` 内部：`latestEntrySeq` → 限额 cap → `getTape` →
    `projectTapeEntries` → 锚点判定
  - `forRender(sessionId, opts?)`：读 + 限额 + 早期 seq 计数
  - `forViewer(sessionId, principalId, opts?)`：参与者窗口过滤 +
    `entryWithinTenure`
- [ ] 1.4 `searchRowsFromEntries(entries, sinceSeq)` 移植（qm L523-538）
  - admin / search / inbox 搜索行生成
- [ ] 1.5 `pnpm typecheck` + `pnpm test`（无 PG：memory store 单测 +
  foldLint 对拍）+ `pnpm test:pg` 全绿
- [ ] 1.6 字节对拍套件：`packages/store/tests/tape-projection.test.ts`
  - 取 qm `test/tape-projection.test.ts` 至少前 50 行种子用例
  - 渲染视图 = fold 视图 的 byte-equality property test（qm `tape-parity-gate.test.ts` 移植）

### M-Tape-2 Runtime Recovery（~0.5d）

**目标**：port qm `runtime-recovery.ts`（33L）到 qm-next，提供崩溃后
runtime choice 恢复。

- [ ] 2.1 `packages/runs/src/runtime-recovery.ts`（qm-verbatim 移植）
  - `recoveredRuntime(entries, runId, actorId): RuntimeChoice | undefined`
  - 反向扫描 session entries，匹配 `tool='runtime' && runId && actorId &&
    runtimeHandoff.choice` 的最新一条
  - 类型守卫：`isHarnessId(choice.harnessId)` + `typeof choice.modelId === 'string'`
  - 测试：3 条连续 tool_result 中取最新；不存在时返 undefined
- [ ] 2.2 接 `packages/orchestrator/src/orchestrator.ts:107` 周边：
  - harness `resolveChoice` 前先 `recoveredRuntime(history, runId, actorId)`
  - 找到 → 用作 fallback；与 `choice?.harnessId` 取并集
- [ ] 2.3 `pnpm typecheck` + `pnpm test` 全绿；parity-deviations #58 标注"已 closed"

### M-Tape-3 渲染路径接通 + 字节对拍闸门（~1d）

**目标**：把 admin / web-ui / inbox 的读源切到 `createTranscriptSource`，
让 renderer 视图也走 tape。

- [ ] 3.1 在 `packages/api/src/service.ts` 暴露 `createTranscriptSource(deps.sessions)`
- [ ] 3.2 `@qm/admin` 的 transcript / spend / error 视图：替换
  `getEntries → forRender`（admin 的 transcripts 路由 + /admin/ui 桥）
- [ ] 3.3 `@qm/web-ui` 的 chat / inbox / contexts 视图：替换
  `getEntries → forRender`
- [ ] 3.4 `@qm/web-ui` 的 personal-scope tool result 过滤：用 `entryWithinTenure`
  + `forViewer`（qm `transcript-source.ts` 的 viewer 路径）
- [ ] 3.5 **新门禁** `pnpm check:tape-renderer`：跑一次 cold-rebuild 后
  `fold(tape) === forRender(tape).entries`（qm `tape-parity-gate.test.ts`
  移植为常规 assertion）
  - 失败即 fail：renderer 视图与 harness 视图不一致
  - 写入 `scripts/check-tape-renderer.sh`，接 `pnpm check:im` 同级
- [ ] 3.6 `pnpm test:pg` + `pnpm test` 全绿；`parity-deviations` 收口
  （#56 / #57 / #58 → closed）+ CHANGELOG + 打 tag `tape-renderer`

---

## 4. 验收基线

```bash
# 每批末跑：
cd repos/qm-next
pnpm install
pnpm typecheck                                    # 零错
pnpm test                                         # 全绿（含新增 tape-projection.test.ts）
pnpm test:pg                                      # 全绿
pnpm check:im                                     # 零平台符号
pnpm check:soul                                   # 占位 prompt 恒零（qm-soul 遗留门禁）
pnpm check:tape-renderer                          # M-Tape-3 后新增

# 字节对拍（renderer == harness）：
pnpm test -- packages/store/tests/tape-projection.test.ts
pnpm test -- packages/store/tests/tape-parity-gate.test.ts
```

---

## 5. 风险

1. **qm-verbatim 风险**：port 1.1-1.4 是大段抄 qm 代码（539L 投影 + 102L
   TranscriptSource）。qm-next 是 Cordis 风格 + 严格类型 + IM 中立；qm
   tape-projection.ts 用宽松 `unknown` + 多重 `(row.payload as {...})`
   cast。要保持功能字节一致但通过 qm-next 的 typecheck，需要：(a) 把
   `unknown` 收敛到具体 union 类型；(b) `TapeRecord.payload` 类型用
   qm-next 的窄类型；(c) 不允许 `as any`。建议先写 type signature，
   再 copy body。
2. **coarse run 语义**：qm 的 coarse run 是处理 foreign-harness tape 的
   兜底（`harness !== 'pi'` 触发）。qm-next 有 pi / claude / codex /
   opencode 四引擎，coarse run 触发频率更高。要在测试套件里覆盖多
   引擎组合（参照 qm `tape-projection.test.ts` 中的 harness 切换用例）。
3. **memory+PG 双实现对称性**：projection 是纯函数，无 I/O，所以只有
   一份实现；测时分别用 `MemorySessionStore` 和 `PostgresSessionStore`
   走 `createTranscriptSource`，确认两侧结果一致。
4. **renderer 视图的 IM 过滤**：qm-next 的 forRender 不应混入 IM 平台词
   —— `check:im` 门禁要继续覆盖 `packages/store/src/tape-projection.ts`。
5. **tape-retirement 闸门**：qm 的 763 行 `tape-retirement.test.ts` 涉及
   "冻结 + 退役 + 替换" 三态。qm-next v1 不做 retirement（M-Soul-3
   decision），但要预留接口：`projectTapeEntries` 在
   `legacy_import || legacy_patch` 时返 null，调用方降级 legacy
   reconstruction（qm 同语义）。

---

## 6. 不在 follow-up 内（显式不做）

| 项 | 原因 |
|----|------|
| Tape 退役（retirement） | qm-next v1 不做，runbook 仅留 hook |
| Tape foreign-harness 转换（`harness_change` event） | qm-next 单进程多引擎不跨实例，无此需求 |
| Tape 同 byte-parity 测试从 qm 拉过来（1211 行） | 工作量超 1.5d；只取种子用例，剩余 follow-up M-Tape-3.5 门禁长期补 |
| `session_llm_requests` 迁移 | P5 19.0 已经在做，跟 M-Tape 不撞车；本 follow-up 不重做 |

---

## 7. 与现有 in-flight 车道的关系

| 车道 | 现状 | 与本 follow-up 关系 |
|------|------|--------------------|
| **qm-soul** (M-Soul-5 已收口) | tag `soul` | 不冲突；本 follow-up 接 qm-soul 之后 |
| **X3b Command Gate** (X3b 批 6) | 收口在即 | 不冲突 |
| **P5 19.0 数据迁移** | 19.0 已记录 session_tape schema 决策 | **本 follow-up 是 19.0 spec 章节的兑现**；建议把 M-Tape-0..3 归在 19.0 子车道 |
| **P5 21.0 worker 拆分** | 远期 | M-Tape-2 runtime-recovery 是 21.0 的先决条件之一 |

**建议落点**：把 M-Tape-0..3 挂在 P5 19.0 子车道"session_tape renderer 投影"。

---

## 8. 执行顺序（一页纸）

| 阶段 | 时长 | 入口 | 出口 |
|------|-----:|------|------|
| **M-Tape-0** | 0.5d | qm `docs/session-tape-spec.md` 落盘 + parity-deviations #56/#57/#58 | spec + 三条延期登记 |
| **M-Tape-1** | 1.5d | `packages/store/src/tape-projection.ts` qm-verbatim port | projection + TranscriptSource + 字节对拍套件 |
| **M-Tape-2** | 0.5d | `packages/runs/src/runtime-recovery.ts` qm-verbatim port + 接到 orchestrator | runtime choice 恢复通路 |
| **M-Tape-3** | 1d | 渲染路径接通 + `pnpm check:tape-renderer` 闸门 | renderer == harness 字节一致 |

总预算 ~3.5d ai，与 M-Soul（~7d）量级匹配；与 qm-soul 一样走"契约 →
纯函数 → 接线 → 对拍"四段节奏。

---

## 9. 与 qm 上游工作的对齐

qm 上游在 415 commits 中对 tape 的投入：

| qm commit | qm-next 影响 |
|-----------|--------------|
| `docs/session-tape-spec.md` | M-Tape-0 spec 文档 |
| `src/harness/tape-projection.ts` (539L) | M-Tape-1 projection 主循环 |
| `src/harness/runtime-recovery.ts` (33L) | M-Tape-2 runtime choice 恢复 |
| `src/harness/tape-fold.ts` (~300L) | ✅ qm-next 已对位（harness-pi 260L） |
| `Recover failed compaction with bounded recent context` (#1634) | M-Tape-2 上下文崩后回收旁路 |
| `test/tape-projection.test.ts` (1211L) | M-Tape-1 测试种子 + M-Tape-3.5 字节闸门 |
| `test/tape-retirement.test.ts` (763L) | 不在 follow-up（qm-next v1 不做 retirement） |
| `Preserve exact transcripts on the session tape` | 已隐含在 qm-next fold；spec 落盘时引用 |

qm 上游的同步点（`qm-sync-2026-09-26.md`）和本 follow-up 同期落盘；
下次 qm 上游同步时，可对照本表刷新优先级。