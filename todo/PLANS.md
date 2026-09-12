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

### p001: qm-next — Cordis 重写 + 飞书 IM 适配层

**Status:** In Progress (Phase 1/5)
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

- [ ] (2026-09-12) Phase 1 M0 基座：vendor 6 包 + rescope @qm + profile 启动冒烟 ~1d
- [ ] Phase 2 M1 核心回路：契约冻结 →【A 存储层‖B 编排层】→ 汇合 API e2e ~3d/墙钟 2d
- [ ] Phase 3 M2 IM：飞书 SDK spike（可提前）→ im-core 契约 →【A 投递‖B im-feishu】→ 真机冒烟 ~3d/墙钟 2d
- [ ] Phase 4 M3 企业回归：5 包全并行（approvals/triggers/memory+skills/reach+directory/web-ui）→ 回归 ~3d/墙钟 2d
- [ ] Phase 5 M4 多平台：im-slack ‖ im-dingtalk → 双渠道验收 → CI 门禁 + tag v0.1.0 ~1d

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

<!--TOON:active_plans[1]{id,title,status,phase,total_phases,owner,tags,est,est_ai,est_test,est_read,logged,started}:
p001,qm-next — Cordis 重写 + 飞书 IM 适配层,in_progress,1,5,wxd,#qm-next #cordis #feishu #rewrite,~11d,~7d,~3d,~1h,2026-09-12,
-->

## Completed Plans

<!-- Move completed plans here with Outcomes & Retrospective -->

<!--TOON:completed_plans[0]{id,title,owner,tags,est,actual,logged,started,completed,lead_time_days}:
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
