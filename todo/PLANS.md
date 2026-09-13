---
mode: subagent
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->
# Execution Plans

Complex, multi-session work requiring research, design decisions, and detailed tracking.

Based on [OpenAI's PLANS.md](https://cookbook.openai.com/articles/codex_exec_plans)
with TOON-enhanced parsing and
[Beads](https://github.com/steveyegge/beads) integration
for dependency visualization.

<!--TOON:meta{version,format,updated}:
1.0,plans-md+toon,{{DATE}}
-->

## Format

Each plan includes:

- **Plan ID**: `p001`, `p002`, etc. (for cross-referencing)
- **Status**: Planning / In Progress (Phase X/Y) / Blocked / Completed
- **Time Estimate**: `~2w (ai:1w test:0.5w read:0.5w)`
- **Timestamps**: `logged:`, `started:`, `completed:`
- **Dependencies**: `blocked-by:p001` or `blocks:p003`
- **Linkage (The Pin)**: File:line references for search hit-rate (see below)
- **Progress**: Timestamped checkboxes with estimates and actuals
- **Decision Log**: Key decisions with rationale
- **Surprises & Discoveries**: Unexpected findings
- **Outcomes & Retrospective**: Results and lessons (when complete)

### Linkage (The Pin)

Based on [Loom's spec-as-lookup-table pattern](https://ghuntley.com/ralph/),
each plan should include a Linkage section that functions as a lookup table for
AI search:

| Concept | Files | Lines | Synonyms |
| --------- | ------- | ------- | ---------- |
| {concept} | {file path} | {line range} | {related terms} |

**Why this matters:**

- Reduces hallucination by providing explicit anchors
- Improves search hit-rate with synonyms
- Points to exact file hunks for context
- Prevents AI from inventing when it should reference

## Active Plans

### p002: qm-parity — qm-next 全功能对齐（qm 全功能替身）

**Status:** Planning（待用户拍板 Open Questions 后开道）
**Owner:** @wxd
**Tags:** #qm-parity #qm-next #parity
**Estimate:** ~23d (ai:20d test:3d read:2h)；双车道并行墙钟 ~3-4 周
**Dependencies:** p001（已完成）
**PRD:** [todo/tasks/prd-qm-parity.md](tasks/prd-qm-parity.md)
**Tasks:** [todo/tasks/tasks-qm-parity.md](tasks/tasks-qm-parity.md)
**Logged:** 2026-09-13

#### Purpose

v0.1.0 只覆盖 qm 最核心的 ~11%（15k/133k 行 TS）。本计划把 qm-next 补齐为 qm 的生产级全功能替身：真 agent 引擎（4 harness + model/credentials/sandbox）、全 API 面（30 routes）+ admin/auth/portal 控制台、长尾子系统与 M3 砍除项回填、多渠道 IM、数据迁移与切换演练，全部落在 cordis 插件架构上。

#### Development Environment

| Item | Value |
|------|-------|
| Language/runtime | TypeScript (strict, ESM, NodeNext)，Node ^22.19 \|\| >=24 |
| Install | `cd repos/qm-next && pnpm install`（并行阶段开始前由主会话执行一次） |
| Tests | `pnpm test` / `pnpm test:pg`（一次性 PG16 容器对拍）；真机飞书 runbook `repos/qm-next/docs/e2e-feishu.md` |
| Do NOT | worker 不执行 git 写命令（主会话统一提交）；qm 仓只读（平移来源） |

#### Linkage (The Pin)

| Concept | Files | Lines | Synonyms |
|---------|-------|-------|----------|
| 4 引擎 harness（平移源） | repos/qm/src/harness/{pi-harness,pi-tools,claude-harness,codex-harness,opencode-harness}.ts | 2190+3097, 967, 1415, 1188 | pi, claude, codex, opencode, runTurn |
| harness 共享件 | repos/qm/src/harness/{tape-fold,replay,context-compaction,goal,grind}.ts | 331,322,242,166,75 | compaction, tape, goal |
| 模型网关 | repos/qm/src/model/ | 10 文件 | model-catalog, gateway, subscription-oauth |
| 凭据链 | repos/qm/src/credentials/ | 11 文件 | keychain, secret-source, harness-auth-env |
| 沙箱 | repos/qm/src/sandbox/ | 21 文件 | local-sandbox, aws, porter, sprites |
| runs 深化 | repos/qm/src/runs/ | 17 文件 | worker, reaper, session-state-bus, run-activity |
| API 面（30 routes） | repos/qm/src/api/routes/ | - | admin, keychain, connectors, deployments |
| admin/控制台 | repos/qm/src/admin/ + plugins/{admin,portal,auth}/ | 17+21+17 文件 | grants, metrics-sink, SSO |
| 长尾子系统 | repos/qm/src/{mcp,connectors,monitors,tasks,environments,projects,acl,security,processes,insights,classify,webhooks,search,files,deploy,deployment}/ | ~20 目录 | P4 checklist |
| v0.1.0 OUT 项（回填源） | todo/tasks/tasks-qm-next.md | 12.0-16.0 落地注记 | judge, job-queue, consent, sync engine |
| im-slack 复活源 | repos/qm-next git `d7d2db3` | - | ImProvider, mrkdwn, Block Kit |
| 运行时装配对照 | repos/qm/src/wiring.ts | 1842 | buildApp |

#### Progress

- [ ] (2026-09-13) Phase P1 真引擎回路：契约冻结 →【A credentials+model ‖ B pi-harness+sandbox】→ 汇合真任务对拍 ~5d
- [ ] Phase P2 多引擎 + runs：claude ‖ codex ‖ opencode ‖ runs 深化 → router 配置化 ~4d
- [ ] Phase P3 API 面与控制台：routes 契约 →【A api ‖ B admin/auth/portal】→ web-ui 后端化 ~5d
- [ ] Phase P4 长尾 + 回填：IM 域 ‖ memory/skills/reach 完整化 ‖ 长尾子系统 → OUT 项对账 ~5d
- [ ] Phase P5 多渠道 + 迁移 + 切换：slack 复活 ‖ dingtalk/wecom → 迁移器 → 双跑演练 + tag v1.0.0 ~4d

#### Decision Log

- 2026-09-13 全功能替身立项：v0.1.0 缺口盘点为据（harness 4 引擎/model/credentials/sandbox/30 routes/admin/长尾/延期项/迁移）；数据迁移从 non-goal 转正
- 2026-09-13 引擎依赖 pin qm 同版本（pi security fork、claude-agent-sdk 0.3.211、codex 0.144.5、opencode 1.17.18、pg-boss 12.x），回避引擎行为漂移
- 2026-09-13 API 对齐标准为"路由形状兼容"（迁移期 qm CLI/自动化不破坏），非逐行照抄；偏差记录 `docs/parity-deviations.md`
- 2026-09-13 durable-by-default 沿 qm 铁律：生产路径 PG 强制，内存实现仅测试

#### Surprises & Discoveries

- qm 的 harness 层是 4 引擎而非 1：claude-agent-sdk / codex / opencode / pi（yc-software security fork）并存，共享件（tape-fold/replay/compaction）可独立成包
- qm 133k 行中 web-ui SPA（66 文件）已随 v0.1.0 字节级平移，实际剩余平移面比总量小一档
- qm-next orchestrator 已按 qm harness 接口形状编程（176 行骨架消费 `runTurn`），P1 契约冻结有现成基线

<!--TOON:active_plans[1]{id,title,status,phase,total_phases,owner,tags,est,est_ai,est_test,est_read,logged,started}:
p002,qm-parity — qm-next 全功能对齐（qm 全功能替身）,planning,0,5,wxd,#qm-parity #qm-next #parity,~23d,~20d,~3d,~2h,2026-09-13,
-->

## Completed Plans

<!-- Move completed plans here with Outcomes & Retrospective -->

### p001: qm-next — Cordis 重写 + 飞书 IM 适配层

**Status:** Completed（v0.1.0 @ `e245b5d`，2026-09-13；tasks 文件 Status: Done，含完整决策与验收记录）
**Owner:** @wxd
**Tags:** #qm-next #cordis #feishu #rewrite
**Estimate:** ~11d (ai:7d test:3d read:1h)；双 agent 并行墙钟 ~7-8d
**Dependencies:** -
**PRD:** [todo/tasks/prd-qm-next.md](tasks/prd-qm-next.md)
**Tasks:** [todo/tasks/tasks-qm-next.md](tasks/tasks-qm-next.md)
**Logged:** 2026-09-12

#### Purpose

以 Cordis 插件架构（dsh 同源内核 vendor rescope）重写 qm 为全插件企业 agent 编排平台；IM 为一等插件类别，飞书首发，Slack/企微/钉钉可扩展；qm 域逻辑平移复用。

#### Development Environment

| Item | Value |
|------|-------|
| Language/runtime | TypeScript (strict, ESM, NodeNext)，Node ^22.19 \|\| >=24 |
| Install | `cd repos/qm-next && pnpm install`（并行阶段开始前由主会话执行一次） |
| Tests | `pnpm test`（node test runner / 对拍用例） |
| Do NOT | worker 不执行 git 写命令（主会话统一提交）；canonical `aa` 仓只读，产出全在 `repos/qm-next` 新仓 |

#### Linkage (The Pin)

| Concept | Files | Lines | Synonyms |
|---------|-------|-------|----------|
| handleTurn 主循环（平移源） | repos/qm/src/core/orchestrator.ts | 401,449,2017,2834,2851 | turn, 编排, agent loop |
| turn HTTP 入口 | repos/qm/src/api/routes/turns.ts | 31,167 | /v1/turns, postTurn |
| run 队列语义 | repos/qm/src/runs/run-store.ts | 19,69 | enqueue, claim, heartbeat, lease |
| 插件↔core 边界（要泛化的反面教材） | repos/qm/src/api/slack-core-client.ts | 61,185-189 | SlackCoreClient, callCore |
| Slack 形状类型（要替换） | repos/qm/src/types.ts | 74,82,170-171,199 | Destination, threadTs, surface |
| surface 默认值（要消灭） | repos/qm/src/api/app-ambient.ts | 268,333 | surface=slack |
| 应用组装（对照） | repos/qm/src/wiring.ts | 412,1387 | buildApp, createServer |
| Slack 能力全集（M4 改造源） | repos/qm/src/slack/ | - | mrkdwn, approvals, directory |
| Cordis 内核（vendor 源） | repos/deepseek-harness/vendor/cordis/src/ | - | Context, Service, Fiber, effect |
| IM 契约先例 | repos/deepseek-harness/packages/webhook/webhook/README.md | - | webhookRuntime, register, dispatch |
| rescope 规则 | repos/deepseek-harness/docs/rescope.md | - | @deepseek-ai → @qm |
| 插件编写规范 | repos/deepseek-harness/docs/cordis-primer.md | - | inject, waterfall, cordis.yml |

#### Progress

- [x] (2026-09-12) Phase 1 M0 基座：vendor 6 包 + rescope @qm + profile 启动冒烟 ~1d
- [x] Phase 2 M1 核心回路：契约冻结 →【A 存储层‖B 编排层】→ 汇合 API e2e ~3d/墙钟 2d
- [x] Phase 3 M2 IM：飞书 SDK spike（可提前）→ im-core 契约 →【A 投递‖B im-feishu】→ 真机冒烟 ~3d/墙钟 2d
- [x] Phase 4 M3 企业回归：5 包全并行（approvals/triggers/memory+skills/reach+directory/web-ui）→ 回归 ~3d/墙钟 2d
- [x] Phase 5 M4 多平台：im-slack ‖ im-dingtalk → 双渠道验收 → CI 门禁 + tag v0.1.0 ~1d（范围拍板：v1 只做飞书；slack 实现存 `d7d2db3`，dingtalk/企微/双渠道延期）

#### Decision Log

- 2026-09-12 cordis 来源：自 dsh vendor 拷贝 6 包（cordis/cosmokit/schemastery/loader/include/timer），rescope `@deepseek-ai`→`@qm`；group/hmr/logger-console 暂缓
- 2026-09-12 构建有意偏离 dsh：单阶段 tsc emit `lib/`，不用 tsdown 双段（M0 简化，记录于 README）
- 2026-09-12 并行方式：同仓库按包目录隔离 + 契约先行（串行门冻结接口）；worker 无 git 写权限；备选 lane 分支方案暂不采用
- 2026-09-12 域逻辑平移不重写：orchestrator/stores/harnesses 以平移为主，剥离 Slack 分支
- 2026-09-12 飞书默认自建应用 + WebSocket 长连接；SDK `@larksuiteoapi/node-sdk` 于 M2 spike 定案
- 2026-09-12 surface 全链路显式化，禁止默认渠道值

#### Surprises & Discoveries

- qm core 未直接依赖 `@slack/*`（隔离在 src/slack/），但类型层 Slack 形状渗透 10+ 处——重写的关键是类型契约而非依赖切割
- qm `plugins/chassis` 已是"源码级共享件"约定（与 cordis 插件理念同构），迁移心智成本低
- `/v1/connectors/catalog` 是 OAuth 服务目录，与 IM 无关，不可复用其名

#### Outcomes & Retrospective

- 交付：`v0.1.0` @ `e245b5d`，tag 链 `m0`/`m1`/`m2`/`m3`；`test:pg` 239/239 全绿；飞书真机 e2e 三条腿（审批卡/ambient/cron fire）通过。
- 范围拍板（2026-09-13）：v1 只做飞书；im-slack 当次实现后移出包集（代码存 `d7d2db3` 可复活）；双渠道验收延期。
- 遗留（转 p002）：真 harness（4 引擎）、model/credentials/sandbox、30 routes API 面、admin/auth/portal、长尾子系统、M3 OUT 项、数据迁移——见 p002。

<!--TOON:completed_plans[1]{id,title,owner,tags,est,actual,logged,started,completed,lead_time_days}:
p001,qm-next — Cordis 重写 + 飞书 IM 适配层,wxd,#qm-next #cordis #feishu #rewrite,~11d,~2d 墙钟,2026-09-12,2026-09-12,2026-09-13,1
-->

## Archived Plans

<!-- Plans that were abandoned or superseded -->

<!--TOON:archived_plans[0]{id,title,reason,logged,archived}:
-->

---

## Plan Template

```markdown
### p00X: Plan Title

**Status:** Planning
**Owner:** @username
**Tags:** #tag1 #tag2
**Estimate:** ~Xd (ai:Xd test:Xd read:Xd)
**Dependencies:** blocked-by:p001 (if any)
**PRD:** [todo/tasks/prd-{slug}.md](tasks/prd-{slug}.md)
**Tasks:** [todo/tasks/tasks-{slug}.md](tasks/tasks-{slug}.md)
**Logged:** YYYY-MM-DD

#### Purpose

Brief description of why this work matters.

#### Development Environment

<!-- Required for Python, Node.js, and any project with non-trivial setup.
     Workers read this section to avoid broken installs in worktrees. -->

| Item | Value |
|------|-------|
| Language/runtime | e.g. Python 3.12, Node 20 |
| Venv/install | e.g. `python3 -m venv .venv && pip install -e ".[dev]"` |
| Tests | e.g. `source .venv/bin/activate && pytest` |
| Do NOT | e.g. install globally; use the canonical worktree venv |

#### Linkage (The Pin)

| Concept | Files | Lines | Synonyms |
|---------|-------|-------|----------|
| {main concept} | src/path/file.ts | 45-120 | {term1}, {term2} |
| {related concept} | src/path/other.ts | 12-89 | {term3}, {term4} |

#### Progress

- [ ] (YYYY-MM-DD HH:MMZ) Phase 1: Description ~Xh
- [ ] (YYYY-MM-DD HH:MMZ) Phase 2: Description ~Xh

#### Decision Log

(Decisions recorded during implementation)

#### Surprises & Discoveries

(Unexpected findings during implementation)
```

---

## Analytics

<!--TOON:dependencies-->
<!-- Format: child_id|relation|parent_id -->
<!--/TOON:dependencies-->

<!--TOON:analytics{total_plans,active,completed,archived,avg_lead_time_days,avg_variance_pct}:
1,1,0,0,,
-->
