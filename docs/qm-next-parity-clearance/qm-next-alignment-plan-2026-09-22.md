# qm-next 对齐规划（2026-09-22）

**日期**：2026-09-22
**来源**：`qm-vs-qm-next-diff-2026-09-22.md` 第 3 节剩余差异清单 + 本轮定向侦察
**范围**：除 codex-device-login / 订阅 OAuth（凭据门控）与 Fly/AWS（2026-09-22 拍板不移植）之外的全部剩余差异
**方法**：对 `repos/qm/src`（参考实现）与 `repos/qm-next/packages`（现有底座）逐项定量核对，确定每项是**接线**（底座已在）、**移植**（需搬参考实现）还是**评估**（前置不明）。

---

## 0. 侦察核心结论：桩 ≠ 缺底座

ToolContext 的 14 个桩方法（`tool-context.ts:173-174,182-183,248-259,268`）背后，**四个底座包已经存在且相当完整**：

| 桩 | qm-next 现有底座 | 规模 | 缺口性质 |
|---|---|---|---|
| cron×9（`cronCreate..cronRetarget`） | `@qm/triggers`：`scheduler.ts`(298) + `fire.ts`(252) + memory/PG cron store + `pgboss-sink.ts` | 完整运行时 | **接线** |
| webhook×3 | `@qm/triggers` 契约 + intake 契约已冻结 | — | **接线 + 路由** |
| MCP（`mcpToolDefs`/`callMcpTool`） | `@qm/mcp`：`mcp-client.ts` + `mcp-tool-service.ts`(198) + `mcp-server-store.ts` | 完整客户端 | **接线** |
| shareArtifact | `@qm/acl`：`acl-store.ts` + `postgres-grant-store.ts` + `resource-ref.ts` | grant ledger 已在 | **接线** |
| publish / createPlayground | `@qm/portal` 包就绪 | 集成面不明 | **评估** |

qm 参考实现规模：`crons.ts` 489 行、`webhooks.ts` 176 行、`slack/delivery.ts` 489 行、`onboarding/onboarding.ts` 75 行、`policy/command-policy.ts` 911 行、`connectors/oauth.ts` 626 行（doc 记载）。

**结论**：对齐总量的 ~60% 是接线工作，不是移植。这显著改变工作量估计。

---

## 1. 集群 S — 安全边界收口（最小、独立、先行）

| 条目 | 现状 | 工作 | 验证 |
|---|---|---|---|
| S1 context-policy 成员检查（偏差 #44） | `context-policy-routes.ts` lane-A 接受任意 principalId | 接 directory 成员校验，越权 → 403 | route 测试：org 外 principal 被拒 |
| S2 soul `managesScope` 写校验 | `soul-routes.ts:1-6` 自文档未接 | 接 `@qm/acl`/directory 检查共享 scope 写权限 | route 测试：非托管 scope 写被拒 |

**性质**：两条独立 route 级校验，互不依赖，tier:simple。先关的理由：安全边界不依赖任何其他集群，且是"多租户公开服务"定位的硬前置中最便宜的两条。

---

## 2. 集群 T — ToolContext 控制面接线（最大用户价值）

对齐 qm"在对话里做自动化"的能力面。

| 条目 | 桩位置 | 工作 | 依赖 | 验证 |
|---|---|---|---|---|
| T1 cron×9 | `tool-context.ts:248-256` | 接 `@qm/triggers` scheduler/store/pgboss；语义对齐 qm `crons.ts` | pg-boss（已在） | 行为测试：create→fire→runs→patch→delete 全链 |
| T2 webhook×3 | `tool-context.ts:257-259` | 接 triggers 契约 + API webhook 路由（qm `webhooks.ts` 176 行） | T1 同底座 | 行为测试：create→回调投递→disable |
| T3 MCP | `tool-context.ts:182-183` | 接 `@qm/mcp` `mcpToolService`：defs 注入 + call 透传 | 无 | 行为测试：server 注册→toolDefs 可见→call 成功 |
| T4 shareArtifact | `tool-context.ts:268` | 接 `@qm/acl` grant store；`write()` 返回的 `shared` 从 `[]` 变真实 grant | 无 | 行为测试：share→跨 scope read 经 ACL 校验 |
| T5 publish + playground | `tool-context.ts:173-174` | **先评估**：portal/blobs 集成面 + sandbox 产物物化路径；再决定移植或维持诚实不可用 | 评估产出 | 评估报告先行 |

**顺序**：T1→T2（同底座、串行避免 triggers 包冲突）→ T3/T4（独立，可并行）→ T5（评估任务单独开）。
**注意**：tool 桩解除后须同步更新 `check:soul`/`check:im` 门禁无关；工具描述文案进入 system prompt 的部分纳入 composer golden 既有覆盖。

---

## 3. 集群 Q — 灵魂二期四段

| 条目 | qm 参考 | qm-next 底座 | 性质 |
|---|---|---|---|
| Q0 delivery-candidates + signing + apiBaseUrl | `slack/delivery.ts` 489 行 | 无移植 | ❌ **不移植**（2026-09-22 拍板：slack delivery 栈不移植；Q1/Q2 槽位按 ADR-0018 预留，段⑩⑪ 随之登记有意偏差——见台账 5.结论） |
| Q1 段⑩ home channel | composer 段位 | 槽位已按 ADR-0018 预留 | 随 Q0 不移植，登记有意偏差 |
| Q2 段⑪ cron 多目的地交付菜单 | composer 段位 | 槽位预留 | 随 Q0 不移植，登记有意偏差（原"依赖 Q0 + T1"挂起） |
| Q3 段⑫ grantedHandles（共享文件 ACL） | `primitives.ts` + `resolution-service.ts` | `@qm/acl` grant store 已在 | **接线**（ACL 侧）+ composer 段位 |
| Q4 段⑮ onboarding 检测 | `onboarding.ts` 75 行 | 无 | **小移植** |

**顺序**：Q0 → {Q1, Q3} → Q2（需 T1 完成）→ Q4。
**验证**：golden 对拍从 12/12 扩展——每段新增至少 1 个 composer 级案例；渲染输出与 qm 字节对拍（沿用 #55 的 imLabel 中立化规则）。
**同时收口**：Q3 关闭"②安全边界"组里的 grantedHandles ACL 缺口；Q0 落地后段⑨⑩⑪的措辞重复问题（#55b 相关）重新评估是否收敛。

---

## 4. 集群 M — 多实例前置（⏸ 暂缓，2026-09-22 拍板）

> **拍板（2026-09-22）**：Fly/AWS 部署 provider **不移植**（原 §6 外部门控行移除）；集群 M 随之与 Fly/AWS 解耦、**暂缓**——独立价值为 qm-next 自身部署运行时面的多实例正确性（当前 Docker 单实例形态够用）。**触发条件 = 生产需要第二实例（扩容/滚动重启/HA）时重启本集群**。

| 条目 | 现状 | 工作 | 验证 |
|---|---|---|---|
| M1 environments/projects PG twin | `api/src/services/` 每进程（#816 评论） | 存储族 PG twin 化，沿用 `withSchemaLock` 暖建模式 | 迁移演练 + 双进程读一致测试 |
| M2 多实例心跳真交接 | `instance_heartbeats` 表在；`TRUNCATE_ONLY` 仅 notes | 租约交接语义：心跳超时 → 任务/部署 reassign | 双进程演练：kill 一实例，另一实例接管 |

**性质**：M1 先行（M2 的 reassign 依赖共享存储视图）。暂缓期间每进程存储与心跳现状（🟡 行）维持"有意为之/挂起"登记，不视为缺口。

---

## 5. 集群 X — 独立收尾（条件触发，不阻塞主线）

| 条目 | 现状 | 触发条件 | 性质 |
|---|---|---|---|
| X3a command-policy 引擎差距审计 | ✅ 完成（2026-09-22，`x3a-command-policy-audit-2026-09-22.md`）：双引擎休眠为最高差距；X3b 最小版不被 scannableCommand 阻塞 | 已产出解锁路径 | 审计报告 |
| X3b command-policy-simulate 501 → 实现 | ✅ 完成（2026-09-22，4a/4b/4c）：最小版（引擎唤醒 + safe-regex + inline policy）→ scannableCommand 全量移植（qm 语料全绿）→ 每作用域存储/CRUD/分层（simulate qm 保真 + composePolicy/evaluateCommandWithLayer + per-scope policyFor）→ G6 收敛（ADR-0019：规则引擎即 CommandGate 的 rule-engine 策略）+ G8 审批链路（ExecResult.policyVerdict → 审批卡 matched/approvalKey）。X3a 差距 G1-G8 全闭合；CommandGate 生产 startup 装配随部署运行时面 | 移植 |
| X1 connectors/oauth.ts | 无（626 行：PROVIDERS+well-known+PKCE+refresh） | P5 IM providers 落地，或独立拍板 | 移植 |
| X2 portal impersonation | ✅ 完成（2026-09-22 第 5 批 5b）：核心语义+审计（`impersonate.start/stop` 审计 + 7 条路由测试）→ portal 侧 `/auth/impersonate` 密封流（门 + core 审计 + cookie 封装 + stop + 代理 principal 换面 `imp` 声明，逐请求 admin 复核；e2e 过真实 api+web-ui+portal） | 移植 |

---

## 6. 外部门控（不排期，条件触发）

| 条目 | 门控 | 就位后动作 |
|---|---|---|
| codex-device-login + 订阅 OAuth | ChatGPT 凭据 | 代码就绪，凭据到位即验证 `user-model-auth-routes.ts:55,83` 链路 |
| 5.2 飞书真机静默腿 | FEISHU 凭据（已在库）+ 人工发消息 | 断言 ambient 群聊未寻址消息零投递；差一次人工配合 |

> codex-device-login + 订阅 OAuth 已于 2026-09-22 拍板**搁置**（有意偏差，代码就绪，不再等凭据；原门控行移除）。Fly/AWS provider 同日拍板不移植（见 §4 拍板注记）。

---

## 7. 执行顺序与 dispatch 建议

```
第 1 批（并行两单元）:
  单元一: S1 → S2 → T1 → T2          （owner: packages/{api,triggers}）
  单元二: T3 → T4 → Q3               （owner: packages/{mcp,acl,orchestrator}）

第 2 批:
  Q0 (tier:thinking, 设计决策: delivery 平台中立化) → Q1 → Q4
  T5 评估（独立，报告产出）

第 3 批:
  Q2 (依赖 Q0+T1，随偏差挂起) → X2 → M1 → M2（集群 M 2026-09-22 拍板暂缓）
  X3a 审计建议随第 1 批并行派出（只读，不占包 ownership）

第 4 批（条件触发）:
  X3b / X1 / 凭据门控两项（Fly-AWS PRD 已于 2026-09-22 拍板不移植，移除）
```

> **2026-09-22 收尾拍板**：第 1-5 批全部完成（含 X3b 4a/4b/4c、5a/5b）。Fly/AWS 不移植；集群 M 暂缓（触发 = 需要多实例部署）。实现面剩余仅 CommandGate 生产 startup 装配（随部署运行时面）。

**包 ownership 矩阵**（避免并行冲突）：
- 单元一：`packages/api`（routes）、`packages/triggers`
- 单元二：`packages/mcp`、`packages/acl`、`packages/orchestrator`（tool-context 接线部分与单元一在 `tool-context.ts` 有文件级交叉——**T1-T4 全部走同一 worktree 串行**，或按方法区块拆分 PR 顺序）
- 集群 Q：`packages/orchestrator`（protocols/composer）+ `im-core`/`im-feishu`
- 集群 M：`packages/api/src/services` + `packages/store`

**总工作量粗估**（按 2026-09-21 批次速率校准）：
- 接线项（S1/S2/T1-T4/Q1/Q2/Q3）：每条 0.5-1 天
- 移植项（Q0/Q4/X1/X2）：Q0 2-3 天（含设计决策），其余 0.5-1 天
- 评估/审计（T5/X3a）：各 0.5 天
- 多实例（M1/M2）：各 1-2 天（含演练）

## 8. 验收标准

全部集群关闭后，`qm-vs-qm-next-diff` 全景表应达到：
- 🔴 凭据受限项 → 保留（外部门控，代码就绪）
- 🟡 全部条目 → 🟢 或转为"有意偏差"登记（T5 评估、X3a 审计产出决定）
- 每条关闭附带：route/行为测试 + 证据 commit + 差异台账行更新
