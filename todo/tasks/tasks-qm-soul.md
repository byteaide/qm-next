# Tasks: qm-soul — qm-next 产品灵魂层（协议模板 + Soul 联邦 + 模式选择）

Based on [ai-dev-tasks](https://github.com/snarktank/ai-dev-tasks) task format, with time tracking.

**PRD:** 本文件 §背景与证据（PRD-lite，自包含）；上游分析：2026-09-21 qm vs qm-next 架构审查（cbm 图谱 + 源码直读）
**Created:** 2026-09-21
**Status:** In Progress（feature/qm-soul worktree）
**Estimate:** ~7d ai 总工作量；串行为主（契约→纯函数→组装→行为），M-Soul-4 可分叉并行

<!--TOON:tasks_meta{id,feature,prd,status,est,est_ai,logged}:
tasks-qm-soul,qm-soul（qm-next 产品灵魂层）,本文件§背景与证据,planned,~7d,~7d,2026-09-21T00:00Z
-->

## 背景与证据（PRD-lite）

qm 的产品灵魂层不是一段提示词，而是**16 段顺序组装管线 + 三模式协议帧 + soul 联邦**：

1. **组装管线**（qm `src/core/orchestrator.ts:857-963`）：modeFrame → resolution.systemPrompt（soul 联邦）→ sharedCore → securityPrompt → 记忆策略行 → computerBlock → 部署 hints → skillsIndex → gatewayBlock → homeChannel → cronBlock → sharedFilesBlock ─┤ stableSystemBytes（缓存边界）├─ timeBlock → memoryBlock → onboardingBlock。
2. **三模式协议帧**（qm `src/resolution/protocols/*.md` + `orchestrator.ts:857-862`）：`surfaceTools`→mode-autonomous（沉默默认、post/reach 二动词、行为变更=编辑 guidance）；非自动化 DM/web→mode-conversation（流式对话）；否则 mode-fallback。
3. **Soul 联邦**（qm `src/resolution/resolution-service.ts:52-72`）：org soul 在上，scope soul 以 "MUST NOT override the organization policy" 守卫拼接。
4. **fail-loud 渲染器**（qm `src/resolution/prompt-vars.ts:10-24`）：`applyPromptVars` 未解析 token 直接 throw（与 qm-next 设计原则 7 一致）。

**qm-next 现状（2026-09-21 cbm 复查）——零件大半已在，缺组装器：**

| 零件 | 位置 | 状态 |
|---|---|---|
| Surface 工具全量（post/reach/stay_silent/read_thread/…） | `packages/harness-pi/src/pi-tools.ts:2248-2672`（provider-neutral） | ✅ 完整，但 `surfaceTools` 无人激活 |
| SoulStore + org 组合 + 越权守卫（qm 文案逐字） | `packages/api/src/services/soul-store.ts` + `routes/soul-routes.ts` + 测试 | ✅ memory-only（lane-A） |
| renderSecurityPolicyPrompt（byte-equivalent） | `packages/security/src/security-posture.ts:194` | ✅ 未入 prompt |
| Resolution 装饰器缝 | `packages/memory/src/resolution.ts`、`packages/skills/src/resolution.ts` | ✅ 模式确立 |
| systemCacheBoundary | `packages/types/src/harness.ts:114` + pi-harness `:1245-1247` | ✅ 管道就绪 |
| guidance 工具（soulRead/soulWrite） | `pi-tools.ts:2106-2168` | ⚠️ 被 `packages/orchestrator/src/tool-context.ts:248` 返回 CONTROL_UNAVAILABLE——死工具 |
| ambient judge + standing orders | `@qm/approvals` | ✅ mode-autonomous 前置件已工作 |

**缺口（即本文件任务来源）：** ① 四个协议模板 + 渲染器零文件；② orchestrator 不设 `surfaceTools`、不选帧（`packages/orchestrator/src/orchestrator.ts:139-156` 原样透传）；③ `devResolution` 一行占位（`packages/api/src/service.ts:497` `'You are qm-next.'`），不读 SoulStore；④ 安全 prompt/branding 未注入；⑤ 环境事实/时间块/交付菜单等区块缺失；⑥ `TurnResolution` 契约过薄（`packages/types/src/orchestrator.ts:25-28` 仅 2 字段）。

## 并行执行规程（沿 p002）

- **车道标记**：`【串行门】`= 单点执行，产出冻结契约；`【A】`/`【B】`= 并行车道；`【汇合】`= 合并验收。
- **隔离方式**：同仓库按包目录隔离；`pnpm install` 主会话执行；只有主会话提交 git；契约变更回主会话裁决。
- **契约先行**：每车道对冻结契约编程；遇契约缺口即停回报。
- **验收纪律**：每里程碑 `pnpm typecheck` + `pnpm test`（PG 用例跳过）+ `check:im` + `rescope-check`；收口加 `pnpm test:pg` 全绿 + `check:soul`（本文件 5.1 新设）。

## Relevant Files

### 平移来源（qm，只读）
- `repos/qm/src/resolution/prompt-vars.ts` — `applyPromptVars`/`loadProtocolFile`（原样移植）
- `repos/qm/src/resolution/protocols/{shared-core,mode-autonomous,mode-conversation,mode-fallback}.md` — 协议模板正文
- `repos/qm/src/core/orchestrator.ts:857-963` — 组装顺序与模式选择（**行为基准**）
- `repos/qm/src/resolution/resolution-service.ts:15-100` — soul 联邦与守卫文案
- `repos/qm/src/core/environment-facts.ts` — computerBlock 环境事实渲染
- `repos/qm/src/resolution/branding.ts` — botName/orgName/botHandle 清洗规则

### 产出（qm-next）
- `repos/qm-next/packages/orchestrator/src/protocols/` — 模板 + 渲染器（新目录）
- `repos/qm-next/packages/orchestrator/src/frame-composer.ts` — 帧组装器（命名实现时定）
- `repos/qm-next/packages/types/src/orchestrator.ts` — `TurnResolution` 增量扩展
- `repos/qm-next/packages/api/src/service.ts` — 真 ResolutionService 替换 devResolution
- `repos/qm-next/packages/api/src/services/soul-store.ts` — PG twin
- `repos/qm-next/docs/adr/0018-soul-layer-is-composed-protocol-frames.md` — ADR（草稿见附录 A）
- `repos/qm-next/docs/parity-deviations.md` — 平台词偏差（#55 预登记）

## Notes

- **byte-identical 基准 + 唯一允许偏离**：平台词汇。qm 模板含 "You're on Slack" 字样，`check:im` 门禁禁平台符号 → `{{#if slack}}` 改 `{{#if imChannel}}` + `{{imLabel}}` 变量注入（bridge 从 provider capabilities 传显示名）。记偏差 #55，golden fixture 同步标注。
- **模式选择基准逻辑**（qm orchestrator.ts:857-862）：`input.surfaceTools` → autonomous；`!automatedTurn && (dm || web)` → conversation；否则 fallback。qm-next 的 origin/自动化判定沿用 admission 既有语义，不新造概念。
- **装饰器顺序对齐 qm**：memory/skills 装饰器追加块必须落在组装器的对应段位之后（skills 块=段⑧、memory 块=段⑭），防止 prompt 语义漂移——若装饰器在 frame composer 之前执行则顺序错乱，实现时明确先后（推荐：composer 先于装饰器，边界后块由装饰器继续持有）。
- **SoulStore PG twin 沿用 qm 表名** `soul_configs`/`soul_history`（DurableMap 族，迁移即直拷；并入 20.0 暖建表模式；`withSchemaLock` 串行——P5 已修的 DDL 竞态先例）。
- **guidance 激活保 qm 语义**：读返回 effectiveSoul+soulVersion；写限个人 scope（org 写走 admin 面，403 阶梯对齐 qm `soul_update_denied`）。
- **不改 harness 四包**：`surfaceTools`/`systemCacheBoundary` 消费端已就绪。
- e2e 真机验收沿 P5 惯例：log 落 `docs/e2e-feishu-*.log`。

## Tasks

### M-Soul-0 契约决策（1 串行门，~0.5d）

- [x] 0.1 【串行门】ADR-0018 落 qm-next `docs/adr/`（草稿=附录 A，status 转 accepted） ~2h
- [x] 0.2 【串行门】平台词汇决策定稿：`imChannel`/`imLabel` 变量方案 + `check:im` 扫描范围扩到 `protocols/`；偏差 #55 预登记 parity-deviations ~1h（protocols/ 位于 orchestrator/src 内，既有 CORE_SOURCES 扫描已覆盖，脚本零改动）
- [x] 0.3 【串行门】golden fixture 采集：从 qm 渲染三模式 × (soul 有/无) × (web/IM) 共 12 组产物入 `packages/orchestrator/tests/golden/`（平台词替换点逐一标注） ~2h（生成器 scripts/generate-soul-golden.ts，qm 渲染器直跑）

### M-Soul-1 协议模板栈（A 车道，纯函数最低风险，~1.5d）

- [x] 1.1 `packages/orchestrator/src/protocols/prompt-vars.ts` 原样移植 + 未解析 token throw / 条件分支 / 变量替换单测 ~2h
- [x] 1.2 四模板 neutralized 移植（`{{slack}}`→`{{imChannel}}`/`{{imLabel}}`，其余 byte-identical）+ 每模板快照测试 ~4h（12/12 golden 字节对拍绿；shared-core 还有 2 处平台词：botHandle 行 + 文件段落，已列入 #55 清单）
- [x] 1.3 `check:im` 脚本扩展扫描 `protocols/` 目录；typecheck/test 全绿 ~1h

### M-Soul-2 组装器 + Soul 接线（串行，核心 PR，~2d）

- [x] 2.1 `TurnResolution` 增量扩展（`surfaceTools?`/`systemCacheBoundary?`/`memoryBlock?` 全可选，不破坏 M1 冻结）+ frame composer 实现 qm 段序 ①-⑤+⑧（安全 prompt 注入、skills 块落位） ~4h（composer=packages/orchestrator/src/frame-composer.ts；boundary 由 composer 产出经 orchestrator 传 HarnessTurnInput.systemCacheBoundary，不落在 TurnResolution 上；memory/skills 装饰器改为产出独立区块字段，orchestrator 按段位拼装——⑧入边界前、⑭入边界后）
- [x] 2.2 `api/src/service.ts`：`devResolution` → 真 ResolutionService：SoulStore.effectiveSoul（段②）+ branding 解析（botName/orgName 从 admin branding store 或 config；botHandle 从 IM envelope→gatewayBlock 段⑨）；无 soul/branding 配置时回退现行为（向后兼容 profile） ~4h（botName/orgName=surfaceConfig.branding{selfLabel,orgName}；securityPosture 配置新增，默认 auto；占位默认串 'You are qm-next.' 已从 Config schema 移除——5.1 门禁要求全仓为零；无 soul 时 soul 段为空、composer 仍出完整协议帧）
- [x] 2.3 SoulStore PG twin（DurableMap `soul_configs`+`soul_history`，暖建表 + withSchemaLock；迁移器 ENTITY_COPIES 评估直拷 vs export-seed） ~3h（createPostgresSoulStore：createPostgresMap 双表 + withSchemaLock 经 pg-pool；ready() 按 version 重放 history 水合缓存；直拷兼容性已记录在 store 头注，迁入器配置归并迁移 runbook 车道）
- [x] 2.4 guidance 工具激活：`tool-context.ts:248` soulRead/soulWrite 接 SoulStore（个人写/org 读/qm 错误阶梯）；harness-pi guidance 路径对拍测试 ~2h（org 写拒绝在 tool-context 层统一执行；api facade 供 read/write）
- [x] 2.5 golden 对拍测试：composer 渲染产物 vs 0.3 fixtures（结构 diff 记偏差表） ~2h（frame-composer.test.ts 12/12 字节对拍；渲染期 imLabel='Slack' 时与 qm 完全一致，偏差 #55 仅存在于源码词汇层）

### M-Soul-3 模式选择激活（串行，行为质变点，~1d）

- [x] 3.1 orchestrator 按 qm 逻辑设 `surfaceTools`（ambient/自动化带目的地→autonomous；非自动化 dm/web→conversation；否则 fallback）并传 `systemCacheBoundary` ~2h（composeFrame.selectFrameMode/deriveSurfaceTools + orchestrator 接线，行为测试 mode selection rides the harness turn input）
- [x] 3.2 im-bridge 补传 surface 显示名（provider label）、botHandle；`TurnInput` 增量加 `proactiveOpener?`（可选） ~2h（GatewayContext.displayLabel + bridge surfaceLabels/botHandle 配置（服务 Config 透传），部署配置供值——core 源码保持零平台词）
- [x] 3.3 行为对拍：mock harness 断言（ambient 群聊未寻址→stay_silent/无投递；DM→对话式直回）+ 四引擎 `surfaceTools` 路径冒烟 ~3h（orchestrator.test.ts 捕获式 harness：ambient→autonomous+surfaceTools=true、DM→conversation、automation→fallback；ambient 静默的投递级断言与四引擎真机冒烟归 5.2 飞书 e2e 静默腿）

### M-Soul-4 环境事实与动态区块（B 车道可与 M-Soul-3 并行，~1.5d）

- [ ] 4.1 computerBlock：qm `environment-facts.ts` 渲染逻辑平移，接 `@qm/sandbox` local profile（机器规格 + 登录态） ~3h
- [ ] 4.2 timeBlock（IANA 时区）+ `stableSystemBytes` 划界验证（pi-harness cache 边界语义测试） ~2h
- [ ] 4.3 交付菜单（⑪ cronBlock 多目的地）/共享文件（⑫ ACL grantedHandles）/onboarding（⑮）依赖矩阵评估 → 本轮收编或二期 backlog 显式记录 ~2h

### M-Soul-5 对拍门禁（汇合，~0.5d）

- [ ] 5.1 新门禁 `pnpm check:soul`：全仓 grep `'You are qm-next.'` 占位恒零（防占位回流） ~1h
- [ ] 5.2 飞书 e2e 第四腿：ambient 群聊静默腿（未寻址消息 → 断言零投递），log 落 `docs/e2e-feishu-soul.log` ~2h
- [ ] 5.3 parity-deviations 收口（#55 + 实施中发现项）+ CHANGELOG + `pnpm test:pg` 全绿；打 tag `soul` ~2h

## 附录 A · ADR-0018 草稿（M-Soul-0 落盘时复制到 qm-next `docs/adr/0018-soul-layer-is-composed-protocol-frames.md`）

```markdown
---
status: proposed
---

# The soul layer is composed protocol frames owned by the orchestrator

The system prompt is a fixed-order composition, not a single stored string.
The orchestrator composes it each turn from named segments in a stable order:
a mode frame selected by turn origin (autonomous for ambient and automated
turns with a destination, conversation for interactive DM/web turns, fallback
otherwise), the scope's effective soul (org policy authoritative, lower-scope
instructions guarded as non-overriding), a shared behavioral core, the
rendered security policy, and live facts (computer profile, time, memory
recall, onboarding). A byte boundary recorded after the stable segments feeds
the harness prompt-cache boundary. Rendering is fail-loud: an unresolved
template token aborts the compose instead of reaching the model. Platform
vocabulary never enters core protocol text — channel-specific wording arrives
as injected variables sourced from the IM provider, keeping the check:im gate
meaningful.

## Considered Options

- Keep the one-line configured prompt: rejected because agent behavior
  contracts (silence-by-default, delivery verbs, memory-as-index, credential
  allowlist) would live nowhere; the model improvises them per turn.
- Compose frames inside the resolution decorator chain: rejected because mode
  selection needs turn-origin context (origin kind, surface, destination)
  that resolution must not own, and decorator order would silently govern
  prompt segment order.
- A dedicated soul package: rejected for now — the composer needs admission
  outcomes and harness-facing types; a package split would freeze a seam
  before the segment set stabilizes. Revisit once segments exceed the
  orchestrator package boundary.
- Render memory/skills blocks inside the composer: rejected — the existing
  resolution decorators already own those blocks and their stores; the
  composer only fixes their position relative to the cache boundary.
```
