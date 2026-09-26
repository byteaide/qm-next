# Tasks: qm-post-soul — qm-soul 收口后优化批（M-Tape renderer + capability token 压缩 + ownership 抽象）

Based on [ai-dev-tasks](https://github.com/snarktank/ai-dev-tasks) task format, with time tracking.

**PRD:** [prd-qm-post-soul.md](prd-qm-post-soul.md)
**Created:** 2026-09-26
**Status:** Planning（决策已签字，见 `todo/notes/qm-next-decision-2026-09-26.md`）
**Estimate:** ~5d ai 总工作量；3 车道并行墙钟 ~3.5d（lane A 主路径 ~3.5d；lane B + lane C 串行在 lane A 之后半周）

<!--TOON:tasks_meta{id,feature,prd,status,est,est_ai,est_test,est_read,logged,started,completed}:
tasks-qm-post-soul,qm-post-soul（renderer 投影 + token 压缩 + ownership 抽象）,prd-qm-post-soul,planning,~5d,~4d,~1d,~2h,2026-09-26T00:00Z,
-->

## 并行执行规程（沿 p002）

- **车道标记**：`【串行门】` = 单点执行，产出冻结契约；`【A】` / `【B】` / `【C】` = 并行车道；`【汇合】` = 合并验收。
- **隔离方式**：同仓库按包目录隔离；`pnpm install` 主会话执行；只有主会话提交 git；契约变更回主会话裁决。
- **契约先行**：每车道对冻结契约编程；遇契约缺口即停回报。
- **验收纪律**：每里程碑 `pnpm typecheck` + `pnpm test`（PG 用例跳过）+ `pnpm test:pg` + `pnpm check:im` + `pnpm check:soul`；收口加 `pnpm check:tape-renderer`（M-Tape-3 新设）。

## Relevant Files

### 平移来源（qm，只读）

- `repos/qm/src/harness/tape-projection.ts` — `projectTapeEntries` + `createTranscriptSource`（539L）
- `repos/qm/src/harness/runtime-recovery.ts` — `recoveredRuntime`（33L）
- `repos/qm/src/harness/tape-fold.ts` — 已对位到 `harness-pi/tape-fold.ts`（不再复用）
- `repos/qm/docs/session-tape-spec.md` — spec 文档（320L）
- `repos/qm/test/tape-projection.test.ts` — 字节对拍测试套件（1211L，本批取 50 行种子）
- `repos/qm/test/tape-parity-gate.test.ts` — 字节对拍闸门（45L）

### 平移来源（qm-next 既有参考）

- `repos/qm-next/packages/harness-pi/src/tape-fold.ts`（260L）— harness-facing fold；本批 store-side projection 是其对位
- `repos/qm-next/packages/store/src/schema.ts:75` — `session_tape` 表 DDL
- `repos/qm-next/packages/store/src/postgres-session-store.ts:263-309` — tape 写入（lease-checked）+ 读取
- `repos/qm-next/packages/store/src/memory-session-store.ts:54-338` — 内存 tape
- `repos/qm-next/packages/types/src/session-store.ts:198` — `getTape` 契约
- `repos/qm-next/packages/auth/src/capability-token.ts`（104L）— 加压缩字段
- `repos/qm-next/packages/runs/src/task-protection.ts` — 加 stub 函数

### 产出（qm-next）

- `repos/qm-next/docs/session-tape-spec.md` — 新建（qm-verbatim 翻译 + qm-next 立场标注）
- `repos/qm-next/docs/parity-deviations.md` — 追加 ## Tape Renderer Projection + ## Capability Token Compression + ## Background Ownership Types 节
- `repos/qm-next/docs/migration.md` — 19.0 "session_tape" 节末尾链接新 spec
- `repos/qm-next/docs/adr/0020-background-ownership-types.md` — 新 ADR 草稿
- `repos/qm-next/packages/store/src/tape-projection.ts` — 新建 539L 移植
- `repos/qm-next/packages/store/tests/tape-projection.test.ts` — 新建 50+ 用例种子
- `repos/qm-next/packages/runs/src/ownership.ts` — 新建（类型 + stub）
- `repos/qm-next/packages/runs/src/runtime-recovery.ts` — 新建 33L 移植
- `repos/qm-next/packages/auth/src/capability-token.ts` — 加 `compressFlag` + `compressPayload` + `decompressPayload`
- `repos/qm-next/packages/api/src/service.ts` — 暴露 `createTranscriptSource`
- `repos/qm-next/scripts/check-tape-renderer.sh` — 新门禁
- `repos/qm-next/CHANGELOG.md` — [Unreleased] 段更新

## Notes

- **qm-verbatim 是约束不是偷懒**：projection 539L + recovery 33L 都是 qm 经过 review 的代码，逐行移植 + 命名 + 行为对齐比重写更安全（review 风险低、可对拍）。偏差表登记 #56/#57/#58/#59。
- **lane A 阻塞 lane B/C 顺序**：M-Tape-1 的 typecheck 是已知长尾（qm `unknown` cast 收敛）；先开 lane A，lane B/C 在 lane A 0.5 后启动（类型冻结后可独立分支）。
- **renderer 视图的 IM 过滤**：`check:im` 门禁要继续覆盖 `packages/store/src/tape-projection.ts`；CORE_SOURCES 范围已含 `packages/store/src`。
- **capability token 压缩默认 opt-in**：避免静默改线上协议；`packages/auth/config/compress-tokens: true` 显式启用。
- **ownership 仅类型层纪律**：不写 PG twin / memory twin / reaper 集成；stub 函数 throw "not yet implemented"；现有 caller 编译通过即可。
- **tape retirement 不在本批**：qm-next v1 不做冻结 + 退役；接口预留但实现延后；详见 `parity-deviations.md` ## Tape Retirement 节（待补）。
- **parity-deviations #60**：model gateway catalog 延期登记（关闭 P1-3.1；qm-verbatim port 留作重启参考）。
- **tag 链**：commit `3d956f1`（决策记录）→ lane A 收口 → lane B 收口 → lane C 收口 → 汇合打 tag `optim-2026-09`。

## Tasks

### A.0 【串行门】M-Tape-0 Spec 落盘 + parity 登记（~0.5d）

- [ ] 0.1 `repos/qm-next/docs/session-tape-spec.md` 新建（qm-verbatim 翻译 + qm-next 立场标注）~2h
  - 不删 "Image references" / "Migration" / "Resolved questions" 三节
  - 在 "What this buys" 节注明：qm-next 当前 fold（harness-pi）已落地，projection（store）未落地
  - 标注 qm-next 立场：cordis 单进程 + memory+PG 双实现 + 飞书 v1 渠道
- [ ] 0.2 `repos/qm-next/docs/parity-deviations.md` 加 ## Tape Renderer Projection（2026-09-26）~1h
  - 引 qm `src/harness/tape-projection.ts:1-539` + `runtime-recovery.ts:1-33` 为参考实现
  - 标 #56 #57 #58 三条延期：
    - **#56**：`projectTapeEntries` 缺失（qm-verbatim 移植起点）
    - **#57**：`createTranscriptSource` 缺失（qm-verbatim 移植起点）
    - **#58**：`runtime-recovery.ts` 缺失（qm-verbatim 移植起点）
- [ ] 0.3 `repos/qm-next/docs/migration.md` 第 19.0 "session_tape" 节末尾链接 `docs/session-tape-spec.md` ~0.5h
- [ ] 0.4 串行门验收：`pnpm typecheck` + `pnpm check:im` + `pnpm check:soul` 全绿 ~0.5h

### A.1 【A】M-Tape-1 Projection + TranscriptSource（~1.5d）

- [ ] 1.1 类型与切片段（qm L1-100 移植）~2h
  - `DraftEntry` / `DraftEvent` / `TapeMessage` / `BoundAnnotation` 类型
  - `renderableTapeSlice(rows)`：找最近 `render_import` 截断
  - `tapeHasRenderBlockers(rows)`：`legacy_import` / `legacy_patch` 阻断
  - `entryMirror(row)` / `boundAnnotation(row)`：annotation → DraftEntry 翻
  - `userDraft` / `toolResultDraft`：message → DraftEntry 翻
  - **qm-verbatim 命名 + 行为**
- [ ] 1.2 投影主循环段（qm L199-395 移植）~3h
  - `projectTapeEntries(sessionId, tapeRows, opts?)`
  - opts.anchored 锚点逻辑
  - 主循环：kind 分流 + coarse run + coveredSeq 累加
  - settle 算法：DraftEvent[] → SessionEntry[] + coveredSeq + baseSeq
  - **关键不变量**：同一 `tape + audience` 产出同一 `entries[]`
- [ ] 1.3 `createTranscriptSource(sessions)` 段（qm L419-521 移植）~3h
  - TranscriptStore pick: `getEntries | visibleEntries | getTape | latestEntrySeq | participantWindowsOf` + 可选 `getTranscriptEntries | canReadTranscriptSuffix`
  - `projected()` 内部：`latestEntrySeq` → 限额 cap → `getTape` → `projectTapeEntries` → 锚点判定
  - `forRender(sessionId, opts?)`：读 + 限额 + 早期 seq 计数
  - `forViewer(sessionId, principalId, opts?)`：参与者窗口过滤 + `entryWithinTenure`
- [ ] 1.4 `searchRowsFromEntries(entries, sinceSeq)` 移植（qm L523-538）~1h
  - admin / search / inbox 搜索行生成
- [ ] 1.5 测试套件（qm-verbatim 50 行种子 + qm-next 多引擎覆盖）~3h
  - `repos/qm-next/packages/store/tests/tape-projection.test.ts`
  - coverage gap / coarse run / mirror involvement / interrupt heal
  - **多引擎组合**：pi / claude / codex / opencode 四种 harness 切换用例
- [ ] 1.6 `pnpm typecheck` + `pnpm test`（无 PG：memory store 单测 + foldLint 对拍）~1h
- [ ] 1.7 `pnpm test:pg`（PostgresSessionStore 走 createTranscriptSource 双侧一致）~1h

### A.2 【A】M-Tape-2 Runtime Recovery（~0.5d）

- [ ] 2.1 `repos/qm-next/packages/runs/src/runtime-recovery.ts`（qm-verbatim port 33L）~2h
  - `recoveredRuntime(entries, runId, actorId): RuntimeChoice | undefined`
  - 反向扫描 session entries，匹配 `tool='runtime' && runId && actorId && runtimeHandoff.choice` 的最新一条
  - 类型守卫：`isHarnessId(choice.harnessId)` + `typeof choice.modelId === 'string'`
- [ ] 2.2 接 `repos/qm-next/packages/orchestrator/src/orchestrator.ts:107` 周边 ~1h
  - harness `resolveChoice` 前先 `recoveredRuntime(history, runId, actorId)`
  - 找到 → 用作 fallback；与 `choice?.harnessId` 取并集
- [ ] 2.3 测试：3 条连续 tool_result 中取最新；不存在时返 undefined ~1h
- [ ] 2.4 `pnpm typecheck` + `pnpm test` 全绿；parity-deviations #58 标注 "已 closed" ~0.5h

### A.3 【A】M-Tape-3 渲染路径接通 + 字节对拍闸门（~1d）

- [ ] 3.1 `repos/qm-next/packages/api/src/service.ts` 暴露 `createTranscriptSource(deps.sessions)` ~1h
- [ ] 3.2 `@qm/admin` 的 transcript / spend / error 视图：替换 `getEntries → forRender` ~2h
- [ ] 3.3 `@qm/web-ui` 的 chat / inbox / contexts 视图：替换 `getEntries → forRender` ~2h
- [ ] 3.4 `@qm/web-ui` 的 personal-scope tool result 过滤：用 `entryWithinTenure` + `forViewer` ~1h
- [ ] 3.5 **新门禁 `pnpm check:tape-renderer`** ~2h
  - `repos/qm-next/scripts/check-tape-renderer.sh`
  - cold-rebuild 后 `fold(tape) === forRender(tape).entries`
  - 失败即 fail；接 `pnpm check:im` 同级
- [ ] 3.6 `pnpm test:pg` + `pnpm test` 全绿；parity-deviations 收口（#56/#57/#58 → closed）~1h

### B 【B】Capability Token 压缩（~0.5d，可与 A.2/A.3 并行）

- [ ] B.1 `repos/qm-next/packages/auth/src/capability-token.ts`（现有 104L + 增量）~1h
  - 加 `compressFlag` 字段（默认关）
  - 加 `compressPayload(obj)` / `decompressPayload(s)` 工具函数（与 qm 同名）
- [ ] B.2 触发压缩阈值：payload 字节数 ≥ 1024 → gzipped base64；< 1024 直传 ~0.5h
- [ ] B.3 `packages/auth/config/compress-tokens: true` opt-in 配置项 ~0.5h
- [ ] B.4 测试：双向 PG 兼容（存储 + 读取）~1h
- [ ] B.5 `pnpm typecheck` + `pnpm test` + `pnpm test:pg` 全绿；parity-deviations #59 登记 ~0.5h

### C 【C】Background Ownership 类型层（~1d，可与 A.2/A.3 并行）

- [ ] C.1 ADR-0020 草稿 `repos/qm-next/docs/adr/0020-background-ownership-types.md` ~1h
  - 状态：proposed（待 M-Soul-3 决策后转 accepted）
  - 说明 P5 21.0 启动时如何填充 ownership 实现
- [ ] C.2 `repos/qm-next/packages/runs/src/ownership.ts`（新建）~1h
  - 定义 `Ownership` / `TransferToken` / `OwnershipLease` 三个类型
  - 类型守卫函数：`isTransferToken(x)` / `isOwnershipLease(x)`
- [ ] C.3 接 `repos/qm-next/packages/runs/src/task-protection.ts`（已有）~1h
  - 增加 stub 函数：
    - `tryHandoverOwnership(lease: OwnershipLease, token: TransferToken): Ownership | undefined` → throw "not yet implemented"
    - `acceptHandover(token: TransferToken): Ownership | undefined` → throw "not yet implemented"
- [ ] C.4 测试：stub 函数行为正确（throw）；类型契约编译通过；现有 caller 编译通过 ~1h
- [ ] C.5 **不写实现**：PG twin / memory twin / reaper 集成全部延后到 P5 21.0 启动（文档明示）
- [ ] C.6 `pnpm typecheck` + `pnpm test` 全绿 ~0.5h

### D 【汇合】文档收口 + tag（~0.5d）

- [ ] D.1 `repos/qm-next/CHANGELOG.md` [Unreleased] 段：post-soul 优化批（M-Tape + token 压缩 + ownership 类型）~1h
- [ ] D.2 `repos/qm-next/docs/parity-deviations.md` 收口 #56/#57/#58/#59 → closed；#60 model gateway catalog 延期登记 ~0.5h
- [ ] D.3 `repos/qm-next/docs/architecture.md` 更新：renderer 投影接通 + capability token 压缩 + ownership 类型层 ~0.5h
- [ ] D.4 `repos/qm-next/docs/operations.md` 更新：capability token 压缩开关说明 ~0.5h
- [ ] D.5 五门禁全绿：`pnpm typecheck` + `pnpm test` + `pnpm test:pg` + `pnpm check:im` + `pnpm check:soul` + `pnpm check:tape-renderer` ~1h
- [ ] D.6 打 tag `optim-2026-09`（不绑 commit hash；D.5 后最近 commit 即 tag 点）~0.5h

## Acceptance Baseline

```bash
# 每里程碑末跑：
cd repos/qm-next
pnpm install                                    # 增量
pnpm typecheck                                  # 零错
pnpm test                                       # 全绿（含新增 tape-projection.test.ts）
pnpm test:pg                                    # 全绿
pnpm check:im                                   # 零平台符号（覆盖 tape-projection.ts）
pnpm check:soul                                 # 占位 prompt 恒零（qm-soul 遗留门禁）
pnpm check:tape-renderer                        # M-Tape-3 后启用
```

## Risk & Mitigation

1. **qm-verbatim port 与 qm-next strict typecheck 冲突**（qm `unknown` cast 多）
   - 先写 type signature（union 类型）再 copy body；不允许 `as any`
   - 测试套件用 qm `tape-projection.test.ts` 种子 50 行验证
2. **coarse run 在 qm-next 多引擎（pi/claude/codex/opencode）触发频率高**
   - 测试套件覆盖多引擎组合（参照 qm `tape-projection.test.ts` 的 harness 切换用例）
3. **memory+PG 双实现对称性**
   - projection 是纯函数无 I/O；测时分别用 `MemorySessionStore` 和 `PostgresSessionStore` 走 `createTranscriptSource`，确认两侧结果一致
4. **renderer 视图的 IM 过滤**
   - `check:im` 门禁覆盖 `packages/store/src/tape-projection.ts`
5. **capability token 压缩在 PG 路径不兼容**
   - 准备回退到 deflate（双向 PG 测试提前跑）
6. **ownership stub 与现有 lease 类型冲突**
   - 先做 type-only import；不改 `task-protection.ts` 现有 caller
   - 若冲突，改 `task-protection.ts` 的 lease 类型 +0.5d

## Tag 链

- `qm-soul`（2026-09-21，本批之前）
- `optim-2026-09`（本批收口，D.6）

## Open Questions（执行中可能产生）

- Q1：capability token 压缩阈值是否 1024？ → 起步用 1024；测后调整
- Q2：ownership 类型是否拆 `OwnershipClaim` / `OwnershipGrant` 两层？ → 起步一层；后续按需
- Q3：renderer 视图切换是否分阶段（双源读 + 灰度）？ → 起步一次性切换；出问题回退到 `getEntries` fallback