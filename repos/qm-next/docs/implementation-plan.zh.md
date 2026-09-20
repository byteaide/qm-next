# 架构实施计划

状态：**Phase 0–7 已完成 — 2026-09-20**（Phase 7 清理已落地；其中一项由负责人豁免解决：ADR-0010 审批续接执行器曾推迟到专属切片，现已在 `feat/approval-continuation` 上**落地**（同日）——见 Phase 7 的"推迟到专属切片"一节。§5 的发布阻断项仍作为发布 PR 的证据。）
范围：实施 `docs/adr/0001`–`docs/adr/0017` 中记录的目标模型，并由 `docs/architecture.md` 汇总。

本计划有意将行为变更拆分为多个阶段。一个阶段只有在 Memory 和 Postgres 两种模式下都通过其阶段关卡后，才算完成。在某个必需关卡为红色时，不得开始下一阶段。

Phase 5 已合并于 `453ca26`。Phase 6（连接器 OAuth + ADR-0017 令牌保险库）以切片 6.1–6.7 直接落在 `main`（至 `6b70c85`）。Phase 7 在 `chore/architecture-cutover` 上开启，测试影响评估位于 `docs/test-impact/phase-7.md`；切片进度记录在该文件的 changelog 与下方 Phase 7 清单中。

## 0. 基本规则

### 执行规则

1. 每个阶段使用一个约定式提交分支：
   - `chore/architecture-gates`
   - `feat/run-lifecycle`
   - `feat/command-gate`
   - `feat/turn-admission`
   - `refactor/trigger-runtime`
   - `feat/im-intake`
   - `feat/connector-oauth`
   - `chore/architecture-cutover`
2. 每个 PR 保持可回滚。禁止长期双写；临时灰度标志仅在附带明确移除任务时才可接受。
3. 新行为必须由 `@qm/types` 中的目标契约表示。不得扩展旧版 `done` 模型。
4. 某个阶段可以在标志后面发布，前提是新旧路径不会成为竞争性的真相来源。灰度标志必须通过 Phase 0 引入的 `RolloutFlag` 端口声明；从其他任何位置读取标志属于架构违规。

### 关卡执行与测试影响

- 本计划中的每个关卡均按 `docs/gate-enforcement.md` 中的描述执行。该文档是关卡分类、覆盖率阈值、不稳定测试处理、豁免流程和发布阻断项的唯一真相来源。
- 每个阶段以 `docs/test-impact/<phase>.md` 处的测试影响评估开头。模板位于 `docs/test-impact/template.md`。评估必须在该阶段首个 PR 开启前合并，并与阶段关卡一同审查。
- 没有匹配测试影响评估的阶段关闭在审查时会被拒绝。
- 各阶段 ADR 引用（Phase N → ADR-XXXX）同时记录在阶段章节和对应的测试影响评估中。

### 每个 PR 的全局关卡

根据 `docs/gate-enforcement.md`，以下关卡为**严格关卡**（始终开启、始终阻断）和**阶段条件关卡**（按领域或阶段要求）。合并前全部必需。

每个 PR 必需：

```bash
pnpm typecheck
pnpm test
pnpm test:architecture   # Phase 0 引入；按 gate-enforcement.md §6 不可豁免
pnpm test:pg
pnpm check:im
pnpm rescope-check
```

合并阶段前必需：

```bash
pnpm test:all
pnpm test:sandbox-policy
```

按触碰领域追加的关卡：

| 领域 | 追加关卡 |
|---|---|
| API / CLI | `pnpm test:cli` |
| 用户故事 | `pnpm test:user-stories` |
| Wave 2 冒烟 | `pnpm test:smoke-wave2` |

以下为**发布阻断项**（按 `docs/gate-enforcement.md` §7），在发布清单而非各 PR 上跟踪：

- 真实沙箱切换演练证据
- OAuth 令牌脱敏扫描
- 发布提交上的 Memory/Postgres 契约一致性
- 生产级数据样本上的迁移投影
- `docs/gate-enforcement.md` §7 所列指标和告警族的 on-call 告警接线

发布阻断项**绝不**以"如果基础设施可用"为条件。如果底层基础设施缺失，则发布暂停。

---

## Phase 0 — 目标契约与架构关卡

**分支：** `chore/architecture-gates`
**状态：** 已完成 — 合并至 main（提交 `0be39c1`）。测试影响评估已合并于 `docs/test-impact/phase-0.md`。

### 范围

1. 在 `packages/types` 中添加仅目标契约，不切换运行时行为：
   - `RunOutcome`
   - `FailureReason`
   - `RunState`
   - `AttemptState`
   - `RunSnapshot`
   - `EventCursor`
   - `RunEvent` 信封与类型化事件集
   - `RunObservation`
   - `CommandRequest`
   - `CommandDecision`
   - `AdmissionRecord`
   - `ApprovalContinuation`
   - 最小化 `TriggerRuntime`
   - 并发原语端口：
     - `LeaseStore`（按令牌获取 / 续约 / 释放）
     - `SequenceAllocator`（单调 `(run_id, seq)`）
     - `SessionReservationStore`（会话续接预留）
   - `RolloutFlag` 端口（灰度标志的唯一注册位置）
2. 添加确定性生命周期测试夹具：
   - 假时钟
   - 内存态持久事件日志
   - Postgres 兼容存储契约套件，覆盖 `LeaseStore`、`SequenceAllocator`、`SessionReservationStore`、`RolloutFlag`
   - 事件订阅者框架
3. 添加 `pnpm test:architecture` 作为静态和契约导向关卡。
4. 记录当前与目标的差异检查，不删除旧版路径。
5. 提交 `docs/test-impact/phase-0.md`，从 `docs/test-impact/template.md` 填写。
6. 提交 `docs/known-violations.md`，至少预填：旧版 `done` 写入、延迟 `api.cronsRuntime` 写入、路由本地 OAuth 挂起 Map、`im-core` 中的 IM 平台符号、命令策略折叠为退出码。每个条目映射到解决它的阶段。
7. 建立 ADR 可追溯性：本阶段的契约在其 JSDoc 中携带对所实现 ADR 的引用（ADR-0001、ADR-0003、ADR-0010、ADR-0013）。

### 边界检查

架构关卡应在以下情况失败：

- 运行时代码在目标 Run 路径上写入旧版 `done`；
- 事件总线在持久终端状态之前关闭 Run；
- Trigger 导入了 API 实现；
- Trigger 延迟写入 `api.cronsRuntime`；
- 安全筛查在生产 Turn 路径上仅从 HTTP 路由导入；
- OAuth 挂起状态存储在路由本地 Map 中；
- 命令策略结果在目标路径上被折叠为普通退出码；
- Memory 和 PG 实现在契约套件上存在分歧（相同种子下断言应逐位一致）；
- `LeaseStore` 在无令牌情况下被获取；
- `(run_id, seq)` 在 `SequenceAllocator` 之外生成；
- 灰度标志从注册的 `RolloutFlag` 端口以外的位置读取；
- `SessionReservationStore` 在拥有该 Run 达到持久终端状态之前释放预留。

### 阶段关卡

- [x] `pnpm test:architecture` 存在，在 CI 中运行，且按 `docs/gate-enforcement.md` §6 不可豁免。
- [x] 目标类型契约编译通过。
- [x] 旧版代码仍通过现有测试。
- [x] `docs/known-violations.md` 存在，预填条目映射到后续阶段。
- [x] `docs/test-impact/phase-0.md` 已合并。
- [x] `LeaseStore`、`SequenceAllocator`、`SessionReservationStore`、`RolloutFlag` 的 Memory 和 PG 实现通过同一契约套件。
- [x] 并发原语端口在其 JSDoc 中携带 ADR 引用。
- [x] 无运行时行为变更。

**关联 ADR：** 0001、0003、0010、0013。

---

## Phase 1 — Run 拥有的生命周期与观测

**分支：** `feat/run-lifecycle`
**状态：** 已完成 — 合并至 main（切片 1.1–1.6，提交范围 `a8f63b1`–`45fa310`；合并 `1132b6e`）。测试影响评估已合并于 `docs/test-impact/phase-1.md`。

### 目标

使 Run 执行成为状态转换、终端结果、持久事件历史和观测的唯一拥有者。

### 实施切片

#### 1.1 Run 状态机

- 实现目标 Run 和 Attempt 状态机。
- 从所有新写入路径中移除 `done`。
- 强制有效转换：
  - Run：`queued → running → awaiting_approval? → succeeded / failed / cancelled`
  - Attempt：`queued → running → suspended? → succeeded / failed / cancelled`
- 为每个失败的 Run 附带 `FailureReason`。

#### 1.2 持久 Run 事件日志

- 分配单调的 per-Run `seq`。
- 在 `(run_id, seq)` 上强制唯一性。
- 使持久化事件不可变。
- 将 Run 状态转换及其事件放入同一事务。
- 仅在提交后通知订阅者。
- 在非终端执行事件上保留 Attempt 身份。
- 跨 Attempt 保留完整事件历史；不在 Attempt 失败时关闭它。

#### 1.3 执行所有权与心跳

- 生产 Turn 执行必须通过 Run 拥有的路径来声明、心跳/续约、完成或失败。
- 过期声明仅可使用原始租约令牌使过期的 Attempt 失效。
- Reaper 不得强制释放在过期 Run 被观察后获取的较新会话租约。
- 重试的 Attempt 仍是同一 Run 的一部分并继续同一事件日志。

#### 1.4 Run 观测契约

- 实现 `snapshot()` 以及 `replay(from)` / `subscribe(from)`。
- API 和 Web 消费同一 Run 观测契约。
- 授权遵循 Session/Run 可见性；仅持有 Run ID 不足够。
- 应用生产者模式白名单和观测边界密钥过滤/扫描。
- SSE 保持为 Web 传输适配器，而非真相来源。

#### 1.5 旧版投影与灰度

- 保持旧版行物理不变。
- 使用已接受的语义投影旧版读取：
  - 旧版成功结果 → `succeeded`
  - 静默结果 → `succeeded`
  - 拒绝结果 → `failed`，原因为 `command_refused`
  - 失败结果 → `failed`，原因为可用失败原因
  - 无续接上下文的待审批 → `failed`，原因为 `approval_continuation_unavailable`
- 为新观测路径添加显式灰度标志，通过 `RolloutFlag` 端口声明。
- 在切换时移除旧观测路径；不保留双重真相来源。

#### 1.6 可观测性基线

可观测性必须在本阶段合并**之前**到位，以便后续阶段有运营信号。这是指标和告警基线；后续阶段扩展相同指标族，而非引入并行的指标族。

**指标（除注明外均为计数器）：**

- `run_event_commit_total{outcome=terminal|non_terminal}` — 终端与非终端提交计数。
- `run_event_transaction_failures_total` — 显式失败计数器。
- `run_seq_conflict_total` — 重复 `(run_id, seq)` 拒绝。
- `run_attempt_retry_total` — Attempt 重新入队计数。
- `run_lease_renew_total`、`run_lease_reap_total` — 所有权流量。
- `run_lease_ownership_conflict_total` — Reaper 对较新会话租约的拒绝。
- `redaction_hit_total{boundary}` — 在日志/观测边界捕获的密钥形字符串。

**告警（必须呼叫 on-call）：**

- `run_event_transaction_failures_total` 速率超阈值。
- `run_seq_conflict_total` 在 15 分钟窗口内非零。
- `run_lease_ownership_conflict_total` 非零。
- `redaction_hit_total` 非零（表示生产者在泄露密钥）。

**日志：** 结构化；绝不包含密钥（见 §1.4）。每个指标和告警在 Phase 1 合并前在 `docs/operations.md` 中有运行手册条目。

### 阶段关卡

必需测试：

1. **状态转换测试**
   - 无效转换被拒绝。
   - 每个终端 Run 恰好有一个 Run 结果。
   - 每个失败的 Run 有失败原因。
   - `done` 在目标写入路径上被拒绝。

2. **事务测试**
   - 状态和事件一起提交。
   - 失败的事务不留下状态变更也不留下事件。
   - 重复 `(run_id, seq)` 被拒绝。
   - 订阅者通知不在提交前发生。
   - 终端事件在终端状态持久之前不可被观测。

3. **重试与 Attempt 测试**
   - Attempt 失败可在保留同一 Run 的情况下重新入队。
   - Attempt 事件携带 Attempt 身份。
   - 事件日志在 Attempt 失败后仍可用。
   - 第二个 Attempt 不能创建新 Run 身份。

4. **租约测试**
   - 在租约过期前续约的 Run 永不被 Reaper 回收。
   - 过期租约通过令牌比较失去所有权。
   - Reaper 不能释放较新的会话租约。
   - 关闭仅释放执行器拥有的租约。

5. **观测测试**
   - 快照与回放一致。
   - 从游标重连不产生重复终端事件。
   - 未授权调用者不能通过 Run ID 枚举或订阅。
   - 携带密钥的生产者输入在离开观测边界前被脱敏。
   - Memory 和 Postgres 实现通过同一契约套件。

6. **迁移测试**
   - 旧版成功、静默、拒绝、失败和待审批行按指定映射。
   - 现有物理行不被读取投影重写。
   - 新写入绝不使用 `done`。

7. **灰度测试**
   - 标志关闭使用旧版路径。
   - 标志开启使用目标观测。
   - 在合并到下一阶段前存在标志移除任务。

**追加命令：**

```bash
pnpm test:architecture
pnpm test:pg
pnpm test:user-stories
```

**关联 ADR：** 0001、0005、0011、0013、0014。

---

## Phase 2 — 命令门与审批续接

**分支：** `feat/command-gate`
**状态：** 已完成 — 合并至 main（切片 2.1–2.7，提交范围 `0009c07`–`11830ad`；合并 `1132b6e`）。测试影响评估已合并于 `docs/test-impact/phase-2.md`。

### 目标

将策略决策变为生产不变量，并使待审批成为非终端、可恢复的 Run 状态。

### 实施切片

#### 2.1 结构化命令门

- 引入 `CommandRequest`，包含：
  - 工具或操作类型
  - 结构化参数或 argv
  - 执行上下文
  - 目标资源
  - 原始文本（如存在）
- 引入恰好一个结构化决策：
  - `allow`
  - `deny`
  - `require_approval`
- 门控所有有副作用的操作：
  - shell 执行
  - 文件修改
  - 发布/分享
  - 后台任务修改
  - cron/webhook 修改
  - MCP 修改
  - 记忆修改
- 门控敏感读取，即使它们不修改状态。
- 不门控纯非敏感读取。

#### 2.2 生产策略配置

- 生产环境在启动时必须显式选择一个策略。
- 缺少生产策略导致启动失败。
- 将现有 `default-denylist` 作为可选的最小基线策略暴露。
- 允许运维策略收紧基线，包括白名单模式。
- 配置缺失时不得静默回退到任何策略。

#### 2.3 审批模型

- 审批要求创建：
  - 一个审批请求
  - 一个审批续接
  - `attempt.suspended`
  - Run 状态 `awaiting_approval`
- 保留：
  - 原始 Run ID
  - 原始 Attempt ID
  - 命令请求身份
  - 挂起的工具调用身份
  - agent/session 上下文引用
  - 审批请求 ID
- 在 Run 保持待审批期间释放执行器和 Run 租约。
- 获取会话续接预留，使另一个 Run 不能静默修改同一 Session。

#### 2.4 审批决策与恢复

- `approvals` 拥有请求/决策状态机。
- `runs` 拥有 Run 和 Attempt 状态。
- 命令门创建请求。
- Web 和 IM 仅提交决策；它们不得创建后继 Run。
- 仅原始请求者可批准或拒绝。
- 重复决策是幂等的。
- 批准在同一 Run 中创建续接 Attempt。
- 拒绝使同一 Run 以 `approval_denied` 失败。
- 过期使同一 Run 以 `approval_expired` 失败。
- 默认 TTL 为 24 小时且必须存储在审批请求上。
- 持久化清扫使未决请求过期。

#### 2.5 审批 TTL 生命周期

默认 TTL 为 24 小时。TTL 生命周期必须显式，以便历史回放和审计保持正确：

- TTL 在创建时存储在审批请求上，除以下情况外永不修改：
  - 成功决策（终端路径；决策时间记录在 Run 事件上）；
  - 原始请求者的续约（记录 `approval.renewed`；续约**不**超过绝对过期时间，即 `created_at + max_ttl`）。
- 绝对过期后的续约尝试返回结构化的 `approval_expired` 响应，且不创建 `approval.renewed` 事件。
- 持久化清扫是过期事件的唯一权威。决策尝试期间的惰性过期是被禁止的 — 清扫必须运行，事件必须持久化，然后后续决策才看到 `approval_expired`。
- `max_ttl` 可按部署配置，但记录在审批请求上，以保持历史回放正确。

#### 2.6 会话续接预留释放顺序

预留防止另一个 Run 在一个 Run 等待审批期间静默修改同一 Session。释放顺序必须明确：

1. 决策（批准 / 拒绝 / 过期）被处理且 Run 状态转换**已持久**。
2. 终端 Run 事件（`approval.decided` 或 `approval.expired`）被持久化。
3. 会话续接预留**仅在步骤 2 之后**释放。
4. 仅在步骤 3 之后，任何新的同 Session Run 才离开 `queued`。

在步骤 2 之前释放预留会留下一个窗口，使另一个 Run 观察到空预留但待审批 Run 尚未终端。这是 Phase 2 的边界检查。

#### 2.7 可观测性

复用 §1.6 的指标。追加：

- `approval_request_total{outcome=requested|approved|rejected|expired}`。
- `approval_renewal_total{outcome=accepted|rejected}`。
- `approval_ttl_sweep_total{outcome=expired|no_op}`。
- `session_reservation_release_order_violation_total` — 必须始终为零；非零即事故。
- `command_gate_decision_total{decision=allow|deny|require_approval}`。

**告警（必须呼叫 on-call）：**

- `command_gate_decision_total{decision="deny"}` 在 15 分钟窗口内速率飙升。
- `approval_ttl_sweep_total{outcome="no_op"}` 持续超过 2× 清扫间隔（表明清扫已死）。
- 任何非零 `session_reservation_release_order_violation_total`。

### 阶段关卡

必需测试：

1. **策略测试**
   - 缺少生产策略导致启动失败。
   - 显式基线策略启动成功。
   - `deny`、`allow` 和 `require_approval` 保持可区分。
   - 策略拒绝不表示为普通退出码。
   - 有副作用的工具不能绕过门。
   - 敏感读取可要求门控。
   - 纯非敏感读取不要求门控。

2. **审批生命周期测试**
   - 审批要求挂起 Attempt。
   - Run 变为 `awaiting_approval`，非终端。
   - 原始 Run 身份保持稳定。
   - 执行器租约被释放。
   - 会话续接预留阻止冲突的同 Session 执行。
   - 预留持有时新的同 Session Run 入队。

3. **恢复正确性测试**
   - 审批恢复保存的命令点，不是原始输入的盲目重放。
   - 批准的命令恰好执行一次。
   - Agent 上下文对续接 Attempt 可用。
   - 不创建后继 Run。
   - 审批与恢复之间的重启仍然恰好恢复一次。

4. **拒绝与过期测试**
   - 拒绝使同一 Run 以 `approval_denied` 失败。
   - 过期使同一 Run 以 `approval_expired` 失败。
   - 两条路径都不执行挂起的命令。
   - 两者在持久状态转换后产生终端 Run 事件。

5. **授权与幂等性测试**
   - 非请求者决策被禁止。
   - 重复请求者决策返回原始结果。
   - 重复投递不能创建第二个续接 Attempt。
   - TTL 清扫对每个过期请求恰好运行一次。

6. **观测测试**
   - `approval.requested`、`approval.decided`、`approval.expired`、`attempt.suspended` 和 `attempt.resumed` 可观测。
   - 挂起和恢复解释 Run 为何未终端。
   - 无命令密钥或令牌进入事件。

**追加命令：**

```bash
pnpm test:architecture
pnpm test:sandbox-policy
pnpm test:user-stories
pnpm test:pg
```

**关联 ADR：** 0002、0010、0012。

---

## Phase 3 — Turn 准入与安全筛查

**分支：** `feat/turn-admission`
**状态：** 已完成 — 合并至 main（切片 3.1–3.3，提交范围 `694f329`–`b039490`；合并 `c67c13c`）。测试影响评估已合并于 `docs/test-impact/phase-3.md`。

### 目标

使准入成为命名的编排器接缝，并使安全筛查成为真正的生产阶段。

### 实施切片

#### 3.1 准入接缝

- 在 `orchestrator` 内实现 Turn 准入。
- 消费窄端口而非无界依赖包。
- 保持固定瀑布：
  1. 身份与授权
  2. 速率限制
  3. 预算
  4. 安全筛查
  5. 解析与会话租约
  6. 分发
- 被拒绝的工作创建准入记录，绝不创建 Run。
- 准入记录包含决策原因、参与者、来源、安全结果和速率限制/预算上下文，不含密钥。

#### 3.2 安全筛查端口

- 将筛查实现保持在安全拥有的端口之后。
- 编排器拥有阶段顺序，而非筛查算法。
- 支持模式：
  - `off`
  - `shadow`
  - `enforce`
- 首个生产切片使用影子模式。
- 影子记录存储：
  - 阶段
  - 决策
  - 原因
  - 规则身份
  - 脱敏摘录
  - 适用时的参与者/会话/Run 引用
- 影子模式筛查失败记录 `screen_unavailable` 并放行 Turn。
- 强制模式筛查失败拒绝 Turn 并创建准入记录。
- 强制模式需要显式运维切换。
- 切换需要预声明的样本量、误报审查、延迟、可用性和安全审查标准。

#### 3.3 可观测性

追加：

- `admission_decision_total{stage,decision}`，对应每个瀑布阶段（`identity`、`rate_limit`、`budget`、`screen`、`session`、`dispatch`）。
- `admission_record_total{outcome=accepted|rejected}`。
- `security_screen_decision_total{mode,decision=allow|deny|unavailable}`。
- `security_screen_unavailable_total{mode}` — 影子模式记录不可用；强制模式不记录（失败关闭行为记录为拒绝）。

**告警（必须呼叫 on-call）：**

- 生产 Turn 上任何强制模式拒绝。
- `security_screen_unavailable_total{mode="enforce"}` — 必须始终为零；非零表示筛查器在生产中失败且 Turn 被拒绝，这是正确行为但表明筛查器中断。
- `admission_decision_total{stage="identity",decision="deny"}` 速率超过基线 3 倍。

### 阶段关卡

必需测试：

1. **瀑布顺序测试**
   - 身份失败阻止速率限制、预算、筛查和分发。
   - 速率限制失败阻止预算、筛查和分发。
   - 预算失败阻止筛查和分发。
   - 强制模式下筛查失败阻止会话解析和分发。

2. **准入记录测试**
   - 被拒绝的工作无 Run ID。
   - 被拒绝的工作有准入记录。
   - 准入拒绝不创建 Run 事件。
   - 敏感载荷被脱敏。

3. **影子模式测试**
   - 允许、拒绝、失败和不可用决策被记录。
   - 无影子决策阻断 Turn。
   - 影子记录与 Run 事件分开留存。

4. **强制模式测试**
   - 拒绝阻断分发。
   - 筛查器失败关闭。
   - 需要显式切换。
   - 不存在自动基于时间的升级。

5. **配置测试**
   - 缺少模式有确定性默认。
   - 无效模式导致启动失败。
   - 无完成标准的强制模式是运维/流程决策，非自动代码行为。

**追加命令：**

```bash
pnpm test:architecture
pnpm test:user-stories
pnpm test:pg
```

**关联 ADR：** 0004、0006、0007。

---

## Phase 4 — 触发器运行时解耦

**分支：** `refactor/trigger-runtime`
**状态：** 已完成 — 合并至 main（切片 4.1–4.4，提交范围 `92d3a3c`–`8585c08`；合并 `72f9e19`）。测试影响评估已合并于 `docs/test-impact/phase-4.md`。

### 目标

消除 Trigger ↔ API 包循环并消除延迟运行时写入。

### 实施切片

1. 在 `packages/types` 中定义最小 `TriggerRuntime`。
2. 仅暴露触发器所需操作：
   - submit
   - health
   - identity
3. API 在组合期间提供实现。
4. 触发器消费契约/符号，而非 `ApiService`。
5. 移除 `api.cronsRuntime` 延迟写入。
6. 将 cron 调度存储和租约机制保持在触发器边界之后。
7. 保持每个调度槽的 cron 触发幂等性。

### 阶段关卡

必需测试：

1. **边界测试**
   - `packages/triggers` 不依赖 `@qm/api`。
   - `packages/api` 不导入触发器实现用于运行时分发。
   - 无运行时代码赋值 `api.cronsRuntime`。
   - 架构关卡拒绝旧的依赖循环。

2. **运行时行为测试**
   - 触发器可通过最小契约提交 Turn。
   - 健康和身份检查正常工作。
   - cron 槽在重复投递下每槽触发一次。
   - 租约恢复不重复已完成的工作。
   - 触发器中的 Run 观测订阅者看到与 API 起源 Run 相同的 Run 身份（Run 是跨越边界的唯一身份；触发器不导入 `ApiService`）。

3. **失败测试**
   - 运行时提交失败产生结构化触发器错误。
   - 触发期间 API 不可用不静默消费槽。
   - 重试不重复执行成功的工作。

**追加命令：**

```bash
pnpm test:architecture
pnpm test:cli
pnpm test:pg
```

**关联 ADR：** 0003。

---

## Phase 5 — 持久 IM 接入与扇出

**分支：** `feat/im-intake`

### 目标

使文档化的 IM 扇出成为真实的、持久的、重启安全的、可独立恢复的。

### 实施切片

1. 在 `im-core` 中添加持久接入收件箱。
2. 按提供方加提供方投递身份为接入记录建立键。
3. 在 Turn 创建前去重。
4. 实现显式订阅者：
   - bridge
   - mirror
   - audit
5. 为每个订阅者提供独立的持久游标。
6. 以退避重试失败的订阅者。
7. 将耗尽的订阅者送入死信队列，同时保持可观测。死信记录携带仅管理员可用的 `redelivery_url`（运维工具，不暴露给最终用户）和一个 `last_error` 字段，该字段绝不包含密钥。死信操作（列表 / 检查 / 重放）仅限管理员、需审计、且绝不自动重放。
8. 保持平台无关的核心；提供方细节保留在 `im-*` 适配器中。

#### 5.5 可观测性

追加：

- `im_intake_dedup_total{result=new|duplicate}`。
- `im_subscriber_lag{subscriber}`（仪表，以事件为单位）。
- `im_subscriber_retry_total{subscriber,outcome=ok|fail}`。
- `im_subscriber_dead_letter_total{subscriber}`。

**告警（必须呼叫 on-call）：**

- 任何死信事件。
- 订阅者延迟超过 N× 预期节奏（N 按订阅者配置）。
- 订阅者重试耗尽。

### 阶段关卡

必需测试：

1. **去重测试**
   - 重复实时投递创建一个 Turn。
   - 重启后重复投递创建一个 Turn。
   - 缓存驱逐/滚动后重复投递创建一个 Turn。
   - 不同的提供方事件不被混淆。

2. **扇出测试**
   - bridge、mirror 和 audit 各自接收已接受的接入。
   - 每个订阅者有自己的游标。
   - 一个失败的订阅者不阻塞其他订阅者。
   - 重试最终向失败的订阅者重新投递。
   - 耗尽的订阅者进入死信而不丢失失败记录。

3. **Turn 生命周期测试**
   - bridge 失败不将接入标记为永久消费。
   - 已接受的接入在重试时映射到同一 Turn 身份。
   - 出站投递保留自己的幂等键。

4. **隔离测试**
   - `pnpm check:im` 通过。
   - IM 核心无提供方特定符号。
   - 重启恢复在途接入而不重复出站回复。

**追加命令：**

```bash
pnpm check:im
pnpm test:architecture
pnpm test:pg
pnpm test:smoke-wave2
```

**关联 ADR：** 0008、0015。

---

## Phase 6 — 连接器 OAuth 生命周期

**分支：** `feat/connector-oauth`

### 目标

将 OAuth 所有权移出 HTTP 转换，并使流程在重启/多实例下安全。

### 实施切片

1. 将流程状态、同意链接、提供方交换和令牌持久化移入连接器上下文。
2. 将 API 路由简化为 HTTP 适配器：
   - 验证回调
   - 归一化提供方载荷
   - 调用连接器操作
   - 返回/脱敏结果
3. 从生产运行时中删除路由本地提供方注册表和挂起链接 Map。
4. 将现有持久 OAuth 和同意存储接入路由生命周期。
5. 对 OAuth 令牌进行静态加密。
6. 将令牌解密限制在短生命周期的连接器提供方调用中。
7. 将令牌值排除在日志、Run 事件、观测、准入记录和管理诊断之外。
8. Phase 6 在涵盖 OAuth 令牌静态加密的**新 ADR** 合并之前不得开启首个 PR。该 ADR（编号在编写时由架构负责人分配）必须涵盖：
   - KEK / DEK 模型和密钥分离。
   - 轮换频率和轮换流程（在线 + 离线场景）。
   - 启动时密钥缺失的行为：**失败关闭**，与 §2.2 中缺少生产策略的情况同等处理。
   - 解密事件的审计日志，无载荷。
   - 密钥托管和灾难恢复流程。
   该 ADR 的审查必须在 Phase 6 首个 PR 开启前完成。本计划不预分配 ADR 编号；编号由架构负责人在编写 ADR 时决定。
9. 在 `docs/operations.md` 中提供 OAuth 轮换和密钥缺失事故的运行手册条目。

#### 6.5 可观测性

追加：

- `oauth_flow_total{step=start|callback|complete,outcome=ok|fail}`。
- `oauth_token_decrypt_total{provider,outcome=ok|error}`。
- `oauth_redaction_hit_total` — 在观测/日志边界捕获的令牌形字符串计数。与通用 `redaction_hit_total{boundary}` 区分，以使 OAuth 特定事故明确无误。

**告警（必须呼叫 on-call）：**

- 任何非零 `oauth_token_decrypt_total{outcome="error"}`。
- 任何非零 `oauth_redaction_hit_total`。

### 阶段关卡

必需测试：

1. **流程生命周期测试**
   - 启动、回调和完成通过连接器拥有的流程成功。
   - 启动与回调之间的重启可完成流程。
   - 回调路由到另一个模拟实例可完成流程。
   - 重复回调不创建重复令牌或账户。

2. **状态测试**
   - 过期的同意不能被交换。
   - 已使用的同意链接不能被重放。
   - 失败的交换在不暴露密钥的情况下保持可诊断。
   - 重试安全的提供方操作不重复外部授权。

3. **令牌保护测试**
   - 令牌静态加密。
   - 令牌明文不存在于：
     - 应用日志
     - Run 事件
     - 观测载荷
     - 准入记录
     - 审批记录
     - 管理诊断
   - 诊断仅可显示提供方、存在性、过期时间和脱敏标识符。

4. **边界测试**
   - 路由模块不拥有 OAuth 生命周期状态。
   - 提供方适配器不绕过持久存储。
   - 架构关卡拒绝进程本地挂起 OAuth Map。

**追加命令：**

```bash
pnpm test:architecture
pnpm test:pg
pnpm test:user-stories
```

**关联 ADR：** 0009、0016。（本阶段 §8 要求的 OAuth 令牌静态加密新 ADR 必须合并；其编号在 ADR 编写时分配。）

---

## Phase 7 — 旧版切换与清理

**分支：** `chore/architecture-cutover`

### 目标

移除过时路径并使目标模型成为唯一的生产模型。

### 清理清单

- [x] 移除旧版 Run 终端 `done` 写入。（切片 7.4 — store 无条件打上 `runSource='target'`；`status='done'` 写入分支已删除。历史行在数据迁移物理重写之前，继续经 Phase 1 投影读取。）
- [x] 移除 Attempt 失败时关闭事件流。（切片 7.6 — 旧版 SSE `finish()` 补偿路径随 `/api/runs/:id/events` 的删除而消亡；观测订阅路由在终端事件处结束流，因此 Attempt 失败时其流自然关闭。）
- [x] 移除编排器拥有的订阅者真相。（切片 7.6 — KV-006：编排器仅通过目标事件日志发布由分配器赋 `seq` 的类型化非终端事件（`attempt.started` / 已脱敏的 `progress` / `attempt.finished`）；turn runner 在 RunStore 提交后发布 `run.finished`；旧版总线与编排器的流关闭已删除。）
- [x] 移除复制 Run 观测的 Web 轮询/回放补偿。（切片 7.6 — web 旧版 SSE 路由及其 `runEvents.replay` 补偿已删除；SPA 消费 `/api/runs/:id/observation/subscribe` 的类型化 `run_observation` 帧，并在终端事件处对 run wire 做最后一次轮询。）
- [x] 移除 Web/IM 后继 Run 审批逻辑。（**已由负责人决策 A 解决，2026-09-20 — 从 Phase 7 豁免并推迟到专属的 ADR-0010 审批续接执行器切片；该切片现已在 `feat/approval-continuation` 上落地（同日）。** 范围发现：运行时从未进入挂起/恢复状态 — `pending_approval` 以 `succeeded` 完成，决策路径经后续 turn（新 Run）重新驱动；store 原语与决策 glue 已存在但没有执行器支撑。推迟的切片实现了该执行器：决策面现在经 `applyApprovalDecision` 路由且不再创建后继 Run；`docs/architecture.md` §7 描述当前行为。）
- [x] 移除 `api.cronsRuntime` 兼容字段。（切片 7.2 — `wire-cron-runtime.ts` 已删除；cron/scheduler/deliveries 从 Cordis registry 惰性读取；零命中的架构测试）
- [x] 移除 API 路由本地 OAuth 挂起状态。（已在 Phase 6 解决 — KV-003）
- [x] 移除进程本地 IM 去重作为权威机制。（切片 7.3 — `seenEvents` Map 已删除；持久 Intake Inbox accept 是唯一权威且无条件）
- [x] 在灰度标志的切换关卡通过后移除临时灰度标志。（切片 7.3/7.4 — `target.im-intake` 与 `target.run-observation` 已从 RolloutFlag 端口表面删除；registry 本身为未来标志保留）
- [x] 将 `docs/architecture.md` 从"当前与目标"更新为当前目标行为。（已完成 — 文档现在描述切换后的运行时：持久事件日志是唯一的 Run 事件来源、仅观测的 web 流、已删除的旧版契约；原唯一剩余的非目标区域 — ADR-0010 审批续接执行器 — 的差距已由续接执行器切片关闭，见下方"推迟到专属切片"。）
- [x] 仅在适用时标记被取代的 ADR。（已评估 — 无适用项：ADR-0005（旧版投影）在 `migrate:qm` 物理重写历史行之前仍是权威；被取代标记随数据迁移交付，见 TIA §10。）
- [x] 验证 `done` 在目标路径上**物理消失**：`rg "term:\s*['\"]done['\"]" packages/` 在目标运行时代码中返回零命中（`legacy/` 下的旧版兼容垫片按其位置排除；此 grep 在 `pnpm test:architecture` 中）。
- [x] 验证 Phase 0 中注册的每个灰度标志都有移除 PR 链接或已被移除。（两个已注册标志均在此分支移除；TIA §4 记录了被删标志的测试）

本分支上额外完成的关卡修复切片（记录在 TIA changelog 中）：

- 切片 7.1 — 全仓 `pnpm typecheck` 修复至绿色（债务记录于 `16c9370`）。
- 切片 7.5a — KV-005：沙箱策略落到类型化 `CommandDecision` 形状（`LegacyCommandDecision` 已删除）。
- 切片 7.6 — KV-006：旧版 RunEventBus + web 旧版 SSE 已删除；目标事件日志是唯一的 Run 事件生产者；web SPA 使用观测订阅流。

### 推迟到专属切片（负责人决策 A，2026-09-20）— 已实现

**ADR-0010 收尾 — 审批续接执行器。已落在
`feat/approval-continuation`（2026-09-20）。** 范围（按归档）：一个
`suspendForApproval` RunStore 转换（`awaiting_approval` + 执行器租约
释放 + `deliveryState.pendingApproval` 中的持久审批续接）、turn runner 中
可认领的续接通道（`claimNextContinuation` — 持久发现，因此审批与恢复之间的
重启仍恰好恢复一次）、转发进 `harness.turns.runTurn` 的 `TurnInput.approval`
（带 `commandRequestId`）、待审批状态在观测快照 + wire（`awaiting_approval`
状态）+ IM 挂起投递（`onSuspension`）中的表示，以及改经
`applyApprovalDecision` 路由的决策面（Web `/api/approvals/:id` + IM 卡片
点击），从而不创建后继 Run。未接线的执行器使挂起的 turn 以
`approval_continuation_unavailable` 失败关闭 — 待审批永远不会以成功收场。
验收证据：`packages/api/tests/approval-continuation-executor.test.ts`
（Phase 2 恢复测试 — "审批恢复保存的命令点，而非盲目重放"、"不创建后继
Run"、"审批与恢复之间的重启仍恰好恢复一次"），外加
`packages/store/tests/stores.test.ts` 中的 memory/Postgres 契约用例。

### 阶段关卡

#### 1. 静态关卡

```bash
pnpm typecheck
pnpm test
pnpm test:architecture
pnpm check:im
pnpm rescope-check
pnpm test:pg
```

#### 2. 持久化关卡

- Memory/Postgres 契约一致性套件绿色。
- 迁移投影在生产级数据样本上通过（发布阻断项；见 §5）。

#### 3. 集成关卡

```bash
pnpm test:all
pnpm test:cli
pnpm test:user-stories
pnpm test:smoke-wave2
```

#### 4. 安全关卡（每 PR）

```bash
pnpm test:sandbox-policy
```

加上每 PR 安全测试：

- OAuth 令牌脱敏扫描（CI 关卡）。
- 准入拒绝审计测试。
- 审批挂起 / 恢复 / 拒绝 / 过期测试。

#### 5. 发布阻断项

按 `docs/gate-enforcement.md` §7，以下必须在发布 PR 上提供证据，**而非**在各个清理 PR 上。这些都不以基础设施可用性为条件；如果底层基础设施缺失，则发布暂停。

- [ ] **真实沙箱切换演练证据已附。** 如果真实沙箱基础设施不可用，则发布不交付；演练是硬性前提，不是可选项。
- [ ] **OAuth 令牌脱敏扫描报告已附。**
- [ ] **Memory/Postgres 契约一致性在发布提交上绿色。**
- [ ] **迁移投影在生产级数据样本上绿色。**
- [ ] **On-call 告警接线已验证**，覆盖各阶段累积的指标和告警族：
  - Run 事件事务失败、重复 seq 冲突、过期租约所有权冲突、脱敏命中（Phase 1）
  - 命令门决策、审批结果、审批续接失败、会话预留释放顺序违规（Phase 2）
  - 安全筛查决策和强制模式拒绝（Phase 3）
  - IM 订阅者延迟 / 死信（Phase 5）
  - OAuth 脱敏命中和解密错误（Phase 6）

#### 6. 运营关卡

- [x] 灰度标志已移除。（slice 7.3/7.4 — `target.im-intake` 与 `target.run-observation` 已从 `RolloutFlag` 端口表面删除；核验：残留引用仅为 JSDoc 注释和一个契约测试 fixture key，无生产注册。）
- [ ] §1.6 / §2.7 / §3.3 / §5.5 / §6.5 中添加的指标和告警已接线到 on-call 轮班，配有仪表盘和运行手册。（未完成 — 属 §5"On-call 告警接线核验"的 release-PR 证据；这是唯一无法在 release PR 前结清的运营关卡。）
- [x] `docs/architecture.md` 已更新为当前目标行为（无"当前与目标"框架）。（Phase 7 切换时完成，延续执行器切片重写 §7 后再次核验；`rg "current vs target" docs/architecture.md` 零命中。）
- [x] `docs/known-violations.md` 为空（所有条目已解决）。（所有可随阶段解决的条目均已解决；live block 仅保留 KV-004 — 提供方适配器平台符号的永久 gate 白名单，由 `pnpm check:im` 强制，不是未解决违规。）
- [x] 每个清理项至少有一个在清理前失败、清理后通过的测试 — 各阶段测试影响评估中的回归篮子纪律保持完整。（TIA §12 自检（`docs/test-impact/phase-7.md`）：回归篮子内存与 PG 双绿 — `pnpm test` 927/0/51、`pnpm test:pg` 1033/0/4；所有"预期破坏"测试已按 TIA §3/§11 处置。）

**关联 ADR：** 0001–0016 全部，加上执行期间引入的任何 ADR（例如 Phase 6 §8 要求的 OAuth 令牌静态加密 ADR）。

---

## 推荐合并顺序

| 顺序 | 阶段 | 为何此顺序 |
|---|---|---|
| 1 | Phase 0 | 建立目标契约并防止新违规。 |
| 2 | Phase 1 | Run 真相是每个入口点的基础。 |
| 3 | Phase 2 | 审批和策略语义依赖非终端 Run 状态。 |
| 4 | Phase 3 | 准入在更多接入路径迁移前形式化边界。 |
| 5 | Phase 4 | 触发器解耦在 Run 真相存在后隔离良好。 |
| 6 | Phase 5 | IM 扇出消费稳定的 Turn/Run 行为。 |
| 7 | Phase 6 | OAuth 是安全关键的但大部分独立于生命周期内部。 |
| 8 | Phase 7 | 仅在目标关卡稳定后清理。 |

## 完成定义

架构审查在以下**全部**条件为真时才视为实施完成：

1. Run 是终端状态和 Run 事件历史的唯一拥有者。
2. `done` 在目标生产路径上**物理消失**（由 Phase 7 grep 关卡验证，而非仅通过写入时拒绝）。
3. 状态和事件事务一致；会话续接预留释放顺序被强制执行（见 §2.6）。
4. 观测基于游标、已授权且已脱敏。
5. 审批挂起并恢复同一 Run。
6. 生产策略不能在无显式命令门基线的情况下运行；生产不能在无已合并 ADR 中声明的 OAuth 加密策略的情况下启动（Phase 6 §8 要求的那个）。
7. 准入拒绝可审计而不成为 Run。
8. 触发器、IM 和连接器 OAuth 边界与其 ADR 匹配。
9. 所有必需的 Memory 和 Postgres 关卡通过。
10. 旧版补偿路径和临时灰度标志已移除。
11. 每个阶段都有已合并的测试影响评估于 `docs/test-impact/<phase>.md`。
12. `docs/gate-enforcement.md` §7 中的所有发布阻断项在最终发布 PR 上有证据。
13. §1.6 / §2.7 / §3.3 / §5.5 / §6.5 的可观测性已接线到 on-call 轮班，配有仪表盘和运行手册；告警为 Phase 7 §5 所列族呼叫。
14. `docs/known-violations.md` 为空。
15. `docs/architecture.md` 描述当前目标行为，而非"当前与目标"。
