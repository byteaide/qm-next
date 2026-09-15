# Product Requirements Document: qm-parity — qm-next 全功能对齐（qm 全功能替身）

<!--TOON:prd{id,feature,author,status,est,est_ai,est_test,est_read,logged}:
prd-qm-parity,qm-parity（qm-next 全功能对齐）,wxd + AI DevOps,draft,~23d,~20d,~3d,~2h,2026-09-13T00:00Z
-->

## Overview

**Feature:** qm-parity — 在 qm-next（cordis 全插件架构）上补齐 qm 全量功能，成为 qm 的生产级全功能替身
**Author:** wxd + AI DevOps
**Date:** 2026-09-13
**Status:** Approved — P1-P4 closed（tag `p4` at `0517959`）；P5 in scope
**Estimate:** ~23d (ai:~20d test:~3d)；双车道并行墙钟 ~3-4 周
**前置:** p001 qm-next v0.1.0（`e245b5d`，`test:pg` 239/239 基线）

### Problem Statement

v0.1.0 完成了核心回路 + 飞书 IM + 企业能力切片（≈15k 行 TS），但对照 qm 全量（≈133k 行 TS，src+plugins）仍是刻意子集。缺口（2026-09-13 会话盘点）：

1. **真 agent 引擎缺位**：qm-next 只有 echo mock harness；qm 的 4 引擎 harness（pi 5287L / claude 967L / codex ~1740L / opencode ~1188L + 共享 compaction/tape/goal/grind/replay ≈1136L）全未平移。**当前 qm-next 不能干真活。**
2. **引擎燃料缺位**：model 网关（10 文件）、credentials/keychain（11 文件）、sandbox（21 文件）未平移。
3. **API 面悬殊**：qm 30 条 routes vs qm-next 3 条（turns/runs/healthz）；admin/auth/portal 插件未平移；web-ui 大量 stub 视图。
4. **长尾子系统未平移**：mcp/connectors/monitors/tasks/environments/projects/acl/security/processes/insights/classify/webhooks/search/files/egress-authz/deploy/deployment 等 ~20 个 src 子系统。
5. **v0.1.0 拍板延期项**：多渠道 IM（slack 代码存 `d7d2db3`）、judge 真模型、job-queue、consent/provenance、memory/skills 完整能力等。
6. **数据迁移未做**（原 PRD non-goal，替身目标下必须解除）。

### Goal

qm-next 达成与 qm 的功能对等：同一份 qm 生产任务面（真 harness 干活、多引擎、全 API 面、admin/portal 控制台、多渠道 IM、数据可迁移），全部运行在 cordis 插件架构上，最终以数据迁移 + 双跑演练收束切换。

**成功判据：** 飞书/web 里 qm 的每一个日常使用场景在 qm-next 上有等价路径；qm PG 数据可迁入 qm-next 并通过回归；切换演练（灰度双跑）通过后 qm 可退役。

## User Stories

- 作为群成员，我在飞书 @agent 派发真实编码/运维任务，agent 用真模型+真工具执行并流式回复（不再是 echo）。
- 作为平台运营者，我在 web-ui/admin 里管理凭据、connector、模型、审批、监控，与 qm 操作面一一对应。
- 作为运维者，我把 qm 生产库迁移到 qm-next 并双跑灰度，随时可回退。
- 作为多渠道用户，我在 Slack/飞书（及钉钉/企微）上获得同一 agent 服务。

## Functional Requirements

### P1 真引擎回路（关键路径，~5d ai）

1. **Harness 契约冻结**（串行门）：以 qm-next orchestrator 已消费的 `runTurn` 形状为基线，补齐 model/credentials/sandbox 端口定义（`@qm/types`）。
2. **credentials/keychain 平移**（qm `src/credentials/`，11 文件）：keychain、secret-source、harness-auth-env、connector-token 为主；secret-drop/device-flow/resident-auth 按引用跟进。memory + PG 双实现，durable-by-default。
3. **model 网关平移**（qm `src/model/`，10 文件）：catalog/gateway/pi-models/custom-providers/subscription-oauth/user-model-credential-store。
4. **pi-harness 平移**（5287L）：pi-harness + pi-tools + 共享件（tape-fold/context-compaction/goal/grind/replay）+ sandbox 最小集（local-sandbox）。
5. **汇合验收**：飞书 @机器人执行真实编码任务，与 qm 同任务对拍（结果/耗时）；`test:pg` 基线扩充。

### P2 多引擎 + runs 深化（~4d ai）

6. **三引擎并行车道**：claude-harness（967L）/ codex-harness+auth（~1740L）/ opencode-harness+plugin（~1188L），依赖 P1 的 credentials/model 端口。引擎 npm 依赖 pin qm 同版本（pi 用 yc-software fork security 构建）。
7. **runs 深化**（qm `src/runs/` 余量）：worker/reaper/drain/task-protection/session-state-bus/run-activity-store/run-signal-store/instance-registry/turn-stream。
8. **harness-router 配置化**：per-surface/per-model 引擎路由，配置经 cordis profile。

### P3 API 面与控制台（~5d ai）

9. **API routes 对齐**（qm `src/api/routes/` 30 条）：admin/auth-broker/blobs/connectors/context(-policy)/credentials/crons/deployments/directory/egress-audit/environments/keychain/projects/reach/search/secret-drop/session-state/skill-packs/surface(-cache)/user-model-auth/webhooks/emoji。契约：与 qm 路由形状兼容（迁移期 qm CLI/自动化不破坏）。
10. **admin 服务 + PG sinks**（qm `src/admin/`，17 文件）：grants/metrics/error-log/audit-log/credential-usage/egress-audit/invite-email + plugins/admin UI 平移。
11. **web-ui stub 后端化**：files/webhooks/connectors/keychain/search/memory/user-model-auth/deploy 视图接真 store；playground 启用；绑定与鉴权硬化（解除 127.0.0.1 无鉴权 dev 态）。
12. **auth + portal**：capability-token/aws-role-broker/replay-dedupe + plugins/auth + plugins/portal SSO。

### P4 长尾子系统 + M3 砍除项回填（~5d ai）

13. **M3 延期项回填**：judge 真模型 + ambient cursors、reaction-as-ack、agent-request directives、memory strategy modes/memorable relay/pack 摄取/sync engine、skills pack store/ingest/materialize/sync engine、reach identity merge/openGroup、consent/keychain-ask/edit-notice/provenance、job-queue（pg-boss）。
14. **长尾子系统**：mcp（server-store+tool-service）/connectors 全量（OAuth flows/browser-session/consent-link）/monitors/tasks/environments/projects/acl/security-screener/processes/insights/classify/webhooks/search/egress-authz/deploy（aws/docker/fly/porter providers）/deployment layers。

### P5 web 深化 + 数据迁移 + 切换（~4d ai；2026-09-15 拍板：slack/钉钉/企微 **suspended**，v1 只做飞书 + web 端）

15. **web 端深化**：web-ui 真活收尾（流式 SSE、deep-link 回退、错误页）+ portal SSO/admin-login-link/API relay 真路径连接性 + 体验硬化（mobile 适配 / dark mode / 键盘可达 / lighthouse a11y ≥ 95）。
16. **数据迁移**（关键路径）：schema diff 报告（qm vs qm-next PG 全表）→ 迁移器（sessions/runs/directory/memory/skills/approvals/cron/delivery/audit/metrics 全表）→ 演练迁移 + 回滚路径 + `docs/migration.md` runbook。
17. **监控/合规/生产化**：error-log/metrics/audit-log 完整化 + 健康检查端点 + 监控面板占位；运维 runbook（启动/关闭/回滚/扩缩容/迁移）+ PG snapshot 备份还原演练。
18. **切换演练**：灰度双跑（instance-registry 流量切分）+ blue-green 部署形态 + worker 进程拆分验证；全门禁绿后 tag `v1.0.0`。

> **suspended 项**（保留实现 git 历史 `d7d2db3` im-slack 全集；im-dingtalk/im-wecom 不在 v1 范围）：
> - im-slack 复活
> - im-dingtalk（Stream）+ im-wecom（回调）
> - 双渠道真机验收（原 v0.1.0 20.0）
>
> 任何上述项将来重启按 `ImProvider` 契约复用现有飞书通道测试矩阵。

## Non-Goals

- 不改 qm（参考实现只读）；所有变更落在 qm-next。
- 不重设计 qm 的产品语义；对齐优先于优化（发现明显缺陷记录到 qm-next `docs/parity-deviations.md`，不静默偏离）。
- 不做 qm CLI 之外的全新客户端形态。

## Technical Considerations

- **平移纪律延续 p001**：契约先行串行门 → 包目录隔离车道 → 汇合 `test:pg` 对拍；worker 无 git 写权限。
- **durable-by-default**（沿 qm AGENTS.md 铁律）：生产路径一律 PG 实现，内存实现仅测试。
- **依赖 pin**：pi（yc-software security fork）、claude-agent-sdk 0.3.211、codex 0.144.5、opencode 1.17.18、pg-boss 12.x 与 qm 完全一致，回避引擎行为漂移。
- **门禁持续**：`check:im`（core 无 IM 符号）、rescope-check、typecheck strict、`test:pg`。
- **风格**：qm-next 现行 cordis 插件规范为准；qm 的 zero-comment 铁律同样适用于平移件。

## Time Estimate Breakdown

| Phase | AI Time | Test Time | Total |
|-------|---------|-----------|-------|
| P1 真引擎回路 | 4d | 1d | 5d |
| P2 多引擎 + runs | 3.5d | 0.5d | 4d |
| P3 API 面与控制台 | 4.5d | 0.5d | 5d |
| P4 长尾 + 回填 | 4.5d | 0.5d | 5d |
| P5 web 深化 + 迁移 + 切换 | 3.5d | 0.5d | 4d |
| **Total** | **~20d** | **~3d** | **~23d** |

双车道并行墙钟 ~3-4 周（P2 三引擎可三车道；P4 可拆多车道）。

## Milestones & Acceptance

| 里程碑 | 交付 | 验收标准 |
|--------|------|---------|
| P1 真引擎 | credentials/model/pi-harness/local-sandbox | 飞书真任务对拍 qm；`test:pg` 基线增长且全绿 |
| P2 多引擎 | claude/codex/opencode harness + runs 深化 | 四引擎同 profile 可切换；session-state/activity 持久化 |
| P3 API+控制台 | 30 routes + admin/auth/portal + web-ui 全活 | qm API 面路由级对齐清单过；admin UI 可操作 |
| P4 长尾回填 | M3 砍除项 + 长尾子系统 | v0.1.0 tasks 12-16 OUT 项逐条关闭；子系统路由/存储对拍 |
| P5 web 深化 + 迁移 + 切换 | web-ui 真活 + 迁移器 + 灰度双跑 | 迁移演练+回滚通过；web 真活；tag `v1.0.0` |

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| qm 日常任务场景覆盖 | 100% 等价路径 | 场景清单逐项对拍（P1 起） |
| qm API routes 对齐 | 30/30 兼容 | 路由契约清单（P3） |
| 数据迁移 | 0 丢失、可回滚 | 演练迁移行数校验 + 双跑 diff（P5） |
| 引擎可用性 | 4/4 引擎真任务通过 | 每 harness 一条真任务冒烟（P2） |

## Open Questions / Decision Points

- [x] ~~引擎优先级：P1 pi 先行外，P2 三引擎顺序按 qm 实际使用频率排（待用户给出主力引擎）。~~ 拍板：claude/codex/opencode 平等齐上（2026-09-13 P2 9.0 汇合结论）
- [x] ~~长尾子系统全量确认：playgrounds/insights/monitors/classify 等是否全部在"全功能"内~~ 拍板：16.0 全 11 tranches 全部落地（2026-09-15 P4 17.0 汇合）
- [ ] 数据迁移已从 non-goal 转正（替身目标隐含）——确认目标库是独立 PG 实例还是复用 qm 实例。
- [x] ~~slack/钉钉/企微确认回填（原 M4 延期项 18.0/19.0/20.0）。~~ 拍板：suspended；v1 只做飞书 + web（2026-09-15）
- [ ] 切换终态：qm 退役时间表 vs 长期双跑。

## Appendix

### Evidence（qm 功能面盘点，2026-09-13）

- 代码量：qm src+plugins ≈ 133,654 行 TS；qm-next packages ≈ 15,036 行（不含已平移 SPA）。
- harness 引擎：pi-harness 2190L + pi-tools 3097L；claude-harness 967L；codex-harness 1415L + app-server 325L + auth 3 件；opencode-harness 1188L + plugin；共享 tape-fold 331L/replay 322L/context-compaction 242L/goal 166L/grind 75L。
- wiring.ts 运行时装配引用 ~80 模块族；api/routes 30 条；credentials 11 文件；model 10 文件；sandbox 21 文件；admin 17 文件。
- v0.1.0 已有：types/store(内存+PG)/orchestrator/api(3 routes)/im-core/im-feishu/im-bridge/approvals/triggers/memory(切片)/skills(切片)/reach/directory/web-ui(SPA 平移+薄 server)。

### Related Documents

- p001: `todo/PLANS.md`（v0.1.0 计划与决策日志）
- 基线: `todo/tasks/tasks-qm-next.md`（含 v0.1.0 拍板延期记录）
- 架构: `repos/qm-next/docs/architecture.md`、`repos/qm-next/docs/m3-scope.md`

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-09-13 | AI DevOps | Initial draft（基于 qm 全量盘点与 v0.1.0 缺口分析） |
| 2026-09-15 | AI DevOps | P1-P4 关闭（tag `p4` at `0517959`）；P5 范围重整：slack/钉钉/企微 **suspended**，新增 web 深化 + 监控合规生产化车道 |
