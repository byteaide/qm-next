# qm-next 运维 runbook（p002 P5 20.0）

**范围:** 生产启动/关闭、回滚、扩缩容、备份还原、迁移切换的运维动作单。
**配套:** 数据迁移细节见 [migration.md](migration.md)；架构见 [architecture.md](architecture.md)。

---

## 1. 生产形态与前置

| 项 | 要求 |
|----|------|
| 进程 | 单 Node 进程（cordis profile 组装）；`@qm/api` 为组合根，`@qm/im-bridge` + `@qm/im-feishu` 挂 IM 面 |
| 数据库 | Postgres 14+（演练/开发用 PG16）；**生产必须 `databaseUrl`**（durable-by-default：组合根据此选全部 PG twin） |
| 文件字节 | `filesDir` 指向持久卷（内容寻址 `files/<sha256>`；缺省时字节驻留内存并告警） |
| 观测 | `GET /healthz`（liveness，恒 200）；`GET /readyz`（readiness，PG 探针，down 时 503）；`GET /v1/admin/monitoring/summary`（管理面鉴权，面板占位数据源） |
| 密钥 | 全部经 profile `!!js` env 插值注入；禁止入库/入仓 |

## 2. 启动

1. **目标库自举**（空库或升级库）：`databaseUrl` 指向库后启动一次即完成 schema 落地——实体表由各 store 构造器建（`createPgPool` 启动即 DDL），DurableMap 表由组合根 boot 时 warmup（`entries()` 触发建表）。两条 DDL 路径共用 `qm-next:schema-init` advisory lock 串行执行，多实例同时启动安全（并发 `CREATE TABLE IF NOT EXISTS` 会撞 `pg_catalog.pg_type` 唯一索引）。启动中途失败（暖表/listen）会回滚已开资源（runner/app/PG 池全关），不留僵尸进程。迁移 runbook 第 3 步依赖此行为。
2. profile 装配检查单：`secrets` ≥ 1；`databaseUrl`；`filesDir`；IM 面（`@qm/im-bridge` 的 `ambientPolicySource: 'api'`、飞书凭据）；admin/portal 面（`portalIdentitySecret` / OIDC）。
3. 健康确认：`/readyz` 返回 `{"ok":true,"components":{"database":"up"}}` 后再放流量。
4. 交付队列自愈：`deliveries` 表租约到期自动可再认领——崩溃重启不丢投递，无需人工干预。

## 3. 关闭

1. 停入口流量（LB/入口摘流）。
2. `SIGTERM` 优雅卸载：runner 排空 → Fastify close → 引擎关闭 → 沙箱销毁 → PG 池关闭（cordis disposer 顺序执行）。
3. 兜底：超时后 `SIGKILL` 安全——所有运行态在 PG，租约过期自动回收（组合根 reaper 按 `reapIntervalMs`（默认 10s）扫过期租约，把在飞 run 重新排队交由其他实例认领；重排队按过期租约 CAS，只应用一次）；`files/<sha256>` 内容寻址写入是先写临时文件再原子 rename。

## 4. 回滚

| 场景 | 动作 |
|------|------|
| 部署后行为回退 | 摘流 → 回退到上一版本镜像/binary → `databaseUrl` 不动（schema 向后兼容；新列表一律 `ADD COLUMN` 演进）→ `/readyz` 过后放流 |
| 迁移后数据回退 | 见 migration.md Part C.2 第 10 步：入口切回 qm（数据未损）；已 commit 的目标库 `--rollback` 逆序清理后可重跑迁移 |
| 备份还原 | 见 §6：`pg_restore` 到新库 → `databaseUrl` 指向新库重启 |

## 5. 扩缩容

- **垂直优先**：v1 单进程编排；runner tick、投递 loop、调度 tick 都在同一进程。
- **水平就绪点**（v1 已具备的机制，按需启用）：
  - runs 认领：`FOR UPDATE SKIP LOCKED` + 租约，天然多 worker 安全；
  - 投递认领：同上（provider 维度租约）；
  - cron 调度：`LeaderLease`（PG advisory lock）保证单 leader tick；
  - 实例注册：`instance_heartbeats` 心跳表（21.0 已接线：实例随 drain 扫描心跳；新一代实例心跳会令旧代实例停领排空，心跳静默超过 liveness 窗口后旧代自动恢复）。
- **拆分形态**（21.0 已演练）：把 `@qm/im-bridge`/`@qm/im-feishu`（IO 密集）与 api/runner（CPU 密集）拆为多个 profile 进程，共享 `databaseUrl` 即可，无粘性路由。`pnpm rehearsal:cutover` 全链路 PASS：同 sha 灰度双跑共担队列 → 新 sha blue-green 交接（旧代停领、在飞排空）→ 回滚恢复 → 真子进程拆分 + SIGKILL 崩溃接管（租约过期 → 其他实例 attempt+1 重跑，全程 exactly-once）。
- **缩容**：直接摘流 + 优雅关闭；在飞 run 租约过期后由其他实例接管重跑。

## 6. 备份与还原（20.3）

- **快照**：`scripts/pg-snapshot.sh`（`pg_dump --format=custom`，附带 `files/` 目录 tar；两者放同一对象存储/卷）。
- **节奏建议**：每日全量快照 + WAL 归档（PG 侧配置）；`filesDir` 卷随库同窗口备份（元数据与字节同一还原点）。
- **还原演练**：`pnpm rehearsal:backup`——一次性 PG16 容器，播种 → 快照 → 破坏 → 还原 → 行数断言。**每次备份策略变更后必演一次。**
- **还原顺序**：先还原 PG（schema+数据一体），再还原 `files/` 字节目录，最后启动服务验 `/readyz` + 抽查文件内容流。

## 7. 迁移切换（摘要，全文见 migration.md Part C.2）

冻结源 → 备份 → 目标库自举（§2.1）→ `--verify-only` → dry run → `--commit` → 重播种 → 验收 → 放流。队列先 drain、待审 approvals 清零是硬前置。

## 8. 运维拍板记录（20.0）

- **runtime-config 族 / environments / projects / deploy 族**：`export-seed`（`--export-seed` 产出 JSON 种子，切换后经 admin API/console 重播种）——量小、变更频率低，PG twin 的维护成本高于重播种。
- **identity 面（`deactivated_principals` / `external_members`）**：v1 不带（不迁移、不建 twin）；启用停用名单需求出现时再立项。
- **surface-cache / channel_messages 等缓存类**：not-carried，重同步可重建。
- **webhooks**：PG twin 已落（同名 `webhooks` 表），但 qm 与 qm-next 记录形状不同——**数据走 export-seed，不做行级拷贝**。
- **S3 字节后端**：v1 仅 local-FS `DurableByteStore`；S3 变体平移延后（偏差记录 `parity-deviations.md` §P5 20.0）。

## 9. Phase 1 Run Lifecycle 指标（slice 1.6）

**范围:** Phase 1 §1.6 落地的 Run Event 日志、Lease 调度、新er-Session 跳过与脱敏指标的接线、告警阈值、排查路径。

**接线入口:** `packages/runs/src/observability.ts` 的 `RUN_METRICS` 常量是权威命名。`createRunMetricsRegistry()` 默认是 in-memory 实现（测试用）；生产环境通过 `ReaperOptions.metrics: { inc(name, labels) }` 注入后端实现（Prometheus / OTel / Sentry metrics 任选其一）。未注入时 reaper 走 fallback helper `bumpReaperNewerSessionCounter` 把数据打到 `@qm/runs` 内部默认 registry。

**集成示例（生产入口，伪代码）：**

```ts
import { createReaper, createRunMetricsRegistry, RUN_METRICS } from '@qm/runs'

const registry = createRunMetricsRegistry()
// 后端接入（伪代码）：wireBackend(registry, { pushgateway: process.env.PUSHGATEWAY_URL })

const reaper = createReaper(runs, sessions, {
  intervalMs: 10_000,
  reservations: sessionReservations,        // slice 1.3: 跳过 newer-Session overlap
  metrics: registry,                          // slice 1.6: 注入 metrics registry
  errors: errorSink,                          // 结构化错误日志（run_reap_* codes）
})
```

**指标清单（`RUN_METRICS`）：**

| 常量 | 指标名 | labels | 含义 |
|------|--------|--------|------|
| `EVENT_COMMIT_TOTAL` | `run_event_commit_total` | `outcome={succeeded,failed,cancelled}` | Run Event 日志成功 commit 计数 |
| `EVENT_TX_FAILURES_TOTAL` | `run_event_transaction_failures_total` | `stage={append,commit}` | Event 写入事务失败计数 |
| `SEQ_CONFLICT_TOTAL` | `run_seq_conflict_total` | (无) | `(run_id, seq)` 重复分配冲突（Phase 0 boundary） |
| `ATTEMPT_RETRY_TOTAL` | `run_attempt_retry_total` | (无) | Attempt 被 requeue 计数 |
| `LEASE_RENEW_TOTAL` | `run_lease_renew_total` | `outcome={ok,token_mismatch,expired,not_found}` | Lease renew 结果 |
| `LEASE_REAP_TOTAL` | `run_lease_reap_total` | `outcome={requeued,parked}` | Reaper 实际 retire 计数 |
| `LEASE_REAP_NEWER_SESSION_TOTAL` | `lease_reaper_newer_session_total` | `outcome={skipped_newer_session}` | Reaper 跳过（newer-Session overlap） |
| `LEASE_OWNERSHIP_CONFLICT_TOTAL` | `run_lease_ownership_conflict_total` | (无) | token 不匹配 / ownership 冲突 |
| `REDACTION_HIT_TOTAL` | `redaction_hit_total` | `sink={observation,log}` | 边界脱敏命中 |

**Reaper 错误码（`ReaperErrorSink.record`，§1.6 配套）：**

| Code | 触发条件 | 排查 |
|------|---------|------|
| `run_reap_parked` | Lease 过期 + max attempts 已满 | Run 达到最大重试次数，进入 failed。检查 Run.reason 字段 |
| `run_reap_requeued` | Lease 过期，但仍有重试预算 | 正常路径；spike 通常意味着 worker crash |
| `run_reap_skipped_newer_session` | Approval continuation 场景：Session 已被新 Run 占用 | 正常路径；spike 关联 approval 流量 |

**告警阈值（建议起始值，按 5min 窗口）：**

| 指标 | Warning | Critical | 排查 |
|------|---------|----------|------|
| `run_event_transaction_failures_total` 速率 | > 1/s | > 10/s | PG 写失败/事务竞争 → 查 PG 慢日志 |
| `run_seq_conflict_total` 速率 | > 0 | > 0（恒为 0） | Phase 0 boundary 违反 → 立刻 `aidevops security` |
| `run_lease_ownership_conflict_total` 速率 | > 0.1/s | > 1/s | Worker 抢占/崩溃 → 查 worker 日志 |
| `redaction_hit_total` 速率 | > 0.01/s（稳态） | > 0.1/s | 某 producer 漏脱敏 → 查对应 Run 的 source path |
| `run_reap_skipped_newer_session` 速率 | 任意 spike | - | Approval 续接正常；如比例 > 50% 查 approval 路径 |

**On-call 排查路径（5min 响应）：**

1. 拉 `/v1/admin/monitoring/summary`（20.0 monitoring 面）看组件健康。
2. 对照指标表查异常指标 → 找到对应 `outcome` label。
3. 对 `run_reap_skipped_newer_session` spike：对照 SessionReservationStore 调用方；正常比例 < 5%。
4. 对 `redaction_hit_total` spike：取样本 Run，grep producer 日志找未脱敏字段。
5. 对 `run_seq_conflict_total > 0`：立即锁定生产写入路径（Phase 0 boundary 违反，架构门应已拦截）。

**已知不在 §1.6 范围内（留待 Phase 2）：**

- Session → visible-principals lookup（ADR-0014 §3.2）；目前 web-ui/api observation 用 principal-only heuristic。
- 终端用户可见的 SLO 看板（slice 1.6 只覆盖 on-call 指标，不覆盖业务 SLO）。
- Backfill 工具：Phase 1 假设新写入已走 target 路径；旧 legacy 行的回填不在本 slice。

**回滚路径：** §4.6 — 摘流 → 回退镜像 → `databaseUrl` 不动（schema 向后兼容）。`target.run-observation` flag 切回 `false` 即可让所有新写入走 legacy 路径。

## 10. Phase 2 Command Gate 与 Approval 指标（slice 2.7）

**范围:** Phase 2 §2.7 落地的 Command Gate 决策、Approval 生命周期、TTL sweep、Reservation release order 的指标、告警阈值、排查路径。

**接线入口:** `packages/runs/src/observability.ts` 的 `RUN_METRICS` 常量 + 默认 `RunMetricsRegistry`。生产通过环境 profile 注入后端实现（Prometheus / OTel / Sentry 任选其一）；未注入时降级到默认内存 registry。

**指标清单（Phase 2 新增）：**

| 常量 | 指标名 | labels | 含义 |
|------|--------|--------|------|
| `COMMAND_GATE_DECISION_TOTAL` | `command_gate_decision_total` | `decision={allow,deny,require_approval}` | Command Gate 决策计数 |
| `APPROVAL_REQUEST_TOTAL` | `approval_request_total` | `outcome={requested,approved,rejected,expired}` | Approval Request 生命周期计数 |
| `APPROVAL_RENEWAL_TOTAL` | `approval_renewal_total` | `outcome={accepted,rejected}` | TTL 续期结果 |
| `APPROVAL_TTL_SWEEP_TOTAL` | `approval_ttl_sweep_total` | `outcome={expired,no_op}` | TTL sweep 每次 tick 的结果 |
| `SESSION_RESERVATION_RELEASE_ORDER_VIOLATION_TOTAL` | `session_reservation_release_order_violation_total` | (无) | Release order 违反（durable→event→release 边界） |

**告警阈值（必须 page on-call，§2.7 plan）：**

| 指标 | 阈值 | 排查 |
|------|------|------|
| `command_gate_decision_total{decision="deny"}` | 15min 窗口速率 spike | 某 policy 触发 deny 风暴 → 查 policy 配置 + 命令来源 |
| `approval_ttl_sweep_total{outcome="no_op"}` | 持续 > 2× sweep interval（sweep 死了） | 检查 sweep cron/leader lease → 找 leader 切换日志 |
| `session_reservation_release_order_violation_total` | 任意 > 0 | **Incident**：违反 §2.6 边界；立刻 grep release 调用方，看是否有直接绕过 helper 的路径 |

**On-call 5min 响应：**

1. `approval_request_total{outcome="expired"}` 持续 spike → 检查 sweep 周期是否够短；可能是 maxTtlMs 配错导致 approval 在过期窗口里堆积。
2. `approval_request_total{outcome="rejected"}` 持续 spike → 检查 gate 配置；operator 是否误把 allowlist 收紧。
3. `session_reservation_release_order_violation_total > 0` → 立即停服务读路径，grep `releaseApprovalReservation` 调用点；此 counter 必须永远为 0。
4. `command_gate_decision_total{decision="deny"}` spike → grep 命令来源 + 查 policy 变更记录；可能是一次策略升级的回滚信号。

**Phase 2 不在 §2.7 范围内（Phase 3+ 留）：**

- Decision UI 渲染（`packages/web-ui` 已就绪的决策入口 — slice 2.4 已埋点）
- Approval card 渲染（§U26.x 计划）
- 业务 SLO 看板（Phase 2 只覆盖 on-call 指标）
- Session-level authorization lookup（Phase 2 留 §3）

**回滚路径：** §4.6 — flag 切回 baseline + sweep 周期调长不会破坏 invariants；`session_reservation_release_order_violation_total` 不归零时需要紧急回退到上一版本（incident）。

## 11. Phase 3 Turn Admission 与 Security Screen 指标（slice 3.3）

**范围:** Phase 3 §3.3 落地的 Turn Admission Waterfall 决策、Admission Record 落盘、Security Screen 决策与可用性、Screener unavailable 计数；告警阈值；on-call 5min 响应路径。

**接线入口:** `packages/runs/src/observability.ts` 的 `RUN_METRICS` 常量 + 默认 `RunMetricsRegistry` + helper（`bumpAdmissionDecision`/`bumpAdmissionRecord`/`bumpSecurityScreenDecision`/`bumpSecurityScreenUnavailable`）。生产通过环境 profile 注入后端实现（Prometheus / OTel / Sentry 任选其一）；未注入时降级到默认内存 registry。

**指标清单（Phase 3 新增）：**

| 常量 | 指标名 | labels | 含义 |
|------|--------|--------|------|
| `ADMISSION_DECISION_TOTAL` | `admission_decision_total` | `stage={identity,rate_limit,budget,screen,session,dispatch}` × `decision={allow,deny,error,skipped}` | Turn Admission Waterfall 每阶段的决策计数 |
| `ADMISSION_RECORD_TOTAL` | `admission_record_total` | `outcome={accepted,rejected}` | Admission Record 落盘计数 |
| `SECURITY_SCREEN_DECISION_TOTAL` | `security_screen_decision_total` | `mode={off,shadow,enforce}` × `decision={allow,deny,unavailable}` | Security Screen 每次评估的决策 |
| `SECURITY_SCREEN_UNAVAILABLE_TOTAL` | `security_screen_unavailable_total` | `mode={shadow,enforce}` | Screener unavailable 计数 |

**Unavailable 计数策略（plan §3.3 重要约束）：**

- **Shadow 模式**：Screener unavailable 时**记录**该计数，但 Turn 仍然放行（plan §3.2 Shadow Mode 测试）。
- **Enforce 模式**：Screener unavailable 时**不**记录该计数。Turn 被拒绝（fail-closed），原因记录在 `admission_decision_total{stage="screen",decision="deny"}` 和 `admission_record_total{outcome="rejected"}` 上。

**告警阈值（必须 page on-call，plan §3.3）：**

| 指标 | 阈值 | 排查 |
|------|------|------|
| 任意 Enforce-mode rejection | 任意 > 0（production Turn） | incident：检查 screener + policy + rule 变更；查 `closingStage="screen"` 的 Admission Record |
| `security_screen_unavailable_total{mode="enforce"}` | **必须始终为 0**（plan §3.3 强约束）| screener outage indicator；Enforce 模式下 unavailable 表现为 Turn reject + Admission Record，但 unavailable counter 自身不归零说明计数器逻辑 bug |
| `admission_decision_total{stage="identity",decision="deny"}` | 速率超过 baseline × 3 | identity 层流量突增；可能是凭证泄露 / 自动化攻击 / 配置回滚 |
| `admission_record_total{outcome="rejected"}` | 持续 spike | 检查 `closingStage` 分布；rejected 落 Admission Record 不落 Run（ADR-0006） |

**On-call 5min 响应：**

1. **Enforce-mode rejection** → `grep closingStage=screen` 查 Admission Record → 读 `ruleId`/`reason` → 决定是否紧急调整 policy。
2. **`security_screen_unavailable_total{mode="enforce"}` 非零** → incident：立刻查 `@qm/security/screen-adapter.ts` 的 unavailable 路径；计数逻辑 bug 或 screener 全局故障。
3. **Identity deny spike** → grep 拒绝的 actor；可能是同一 principal 的重试风暴（rate-limit 应当先于 identity deny 拦截，但 identity 是 waterfall 第一阶段）→ 必要时收紧 identity port 的输入过滤。
4. **Admission Record rejected spike** → 看 `closingStage` 分布：
   - `identity`/`rate_limit`/`budget` → 对应端口策略变更；
   - `screen` → Security Screen rule 变更或 screener 状态；
   - `session` → lease 竞争或 conversation 路径异常；
   - `dispatch` → orchestrator-level 拒绝（plan §3.1 step 6）。

**Enforce 模式上线 checklist（plan §3.2 Cutover Gate）：**

- [ ] operator declaration 已就绪：`sampleSize`/`falsePositiveReview`/`latencyMs`/`availabilityPercent`/`securityReview`
- [ ] 至少 `securityReview=true` 且 `cutoverDeclared=true`
- [ ] shadow 阶段的 Shadow Records 已 review（per ADR-0004 §3 sample size criteria）
- [ ] screener 健康检查 + 可用性达标
- [ ] 回滚路径：把 `mode` 切回 `shadow`（无需重启服务，热切即可）

**Phase 3 不在 §3.3 范围内（Phase 4+ 留）：**

- 业务 SLO 看板（Phase 3 只覆盖 on-call 指标）
- Admission Record 的查询 API（admin-only，Phase 4 计划）
- Security Screen 与 Phase 4 Trigger Runtime 的整合（Trigger 进 Admission 路径）

**回滚路径：** §4.6 — flag 切回 baseline；`mode` 切回 `off`/`shadow` 不会破坏 invariants；Enforce 模式唯一的回滚路径是切回 Shadow，不是直接禁掉 Security Screen。

**Linked ADRs:** 0004 (Security Screen Shadow Mode), 0006 (rejections do not create Runs), 0007 (orchestrator seam with fixed waterfall)。

---

## 12. Phase 5 Durable IM Intake 与 Fan-out 指标（plan §5.5）

Phase 5（ADR-0008, ADR-0015）引入 durable Intake Inbox 与显式 subscriber
fan-out（bridge / mirror / audit）。本节是 §5.5 指标族的 on-call runbook；
指标经由 `@qm/runs` 的 in-process registry 暴露，生产接线（OTel/Sentry
backend）沿用 §9-§11 同一通道。

**指标：**

| 指标 | 类型 | Labels | 语义 |
|---|---|---|---|
| `im_intake_dedup_total` | counter | `result=new\|duplicate` | 每 accept 一次外部投递 tick 一次；`duplicate` 表示 Intake Key（provider+eventId）重复 |
| `im_subscriber_lag` | gauge | `subscriber` | subscriber 欠账事件数（latestSeq − cursor）；drain pass 时刷新 |
| `im_subscriber_retry_total` | counter | `subscriber`, `outcome=ok\|fail` | 每 subscriber 每次派发尝试 |
| `im_subscriber_dead_letter_total` | counter | `subscriber` | subscriber 耗尽重试、dead-letter 一条记录时 |

**告警（必须 page on-call）：**

- 任何 `im_subscriber_dead_letter_total` 增量（plan §5.5：任何 dead-letter 事件）。
- `im_subscriber_lag{subscriber}` 超过该 subscriber 配置的 N× 正常节奏
  （bridge 正常节奏为秒级；mirror/audit 依部署配置）。
- `im_subscriber_retry_total{outcome="fail"}` 持续增长（重试耗尽的前兆）。

**Runbook 动作：**

1. **Dead-letter 事件**：`list / inspect / replay` 均为 admin-only 操作。
   - `lastError` 已在记录时 redact（secret-free），可直接读；
   - `redeliveryUrl` 是 admin-only 操作端点
     （默认 `/admin/im/intake/dead-letters/{id}/replay`），永不自动重放；
   - replay 需 actor 身份并写入 audit（fanout `options.audit`）；
   - replay 失败返回 `replay_failed` + secret-free error，可再次 replay；
     成功后该 letter 标记 `redeliveredAt`/`redeliveredBy`，二次 replay 返回
     `already_redelivered`。
2. **Subscriber lag 增长**：检查该 subscriber 的 sink 健康（bridge → api
   turn 队列；mirror/audit → 各自 sink）。fan-out 严格按 seq 顺序派发，队头
   记录重试耗尽后 dead-letter 并跳过，不会阻塞后续记录，也不会阻塞其他
   subscriber（独立 cursor，ADR-0015）。
3. **`duplicate` 比例异常升高**：通常是 provider 侧重投；durable inbox 保证
   只派发一次，无需人工干预；若伴随 `new` 归零，检查 provider 连接。
4. **重启恢复**：cursor 与 inbox 均为 durable（Postgres twin：`im_intake` /
   `im_intake_cursors` / `im_intake_dead_letters`）；重启后 fan-out 从各自
   cursor 继续，bridge subscriber 依 `turnId`（first-writer-wins）保证同一条
   intake 只映射到同一个 Turn，无重复出站回复。

**Rollout：** intake 路径由 `target.im-intake` RolloutFlag 控制
（env `QM_ROLLOUT_TARGET_IM_INTAKE`，默认 off = legacy 直连 sink）。
flag 读取只经由 RolloutFlag port（§Phase 0 边界规则）。Phase 7 清理项负责
移除 flag 与 process-local registry dedup Map（KV-002 同批）。

**Linked ADRs:** 0008 (IM intake is durable fan-out), 0015 (IM subscribers have independent cursors)。

## 13. Phase 6 Connector OAuth 与 Token 加密（plan §6.5 + ADR-0017 runbook）

Phase 6（ADR-0009, ADR-0016, ADR-0017）把 OAuth 生命周期移入 Connector
上下文：flow state / consent link / provider exchange / token 持久化全部
落在 durable store（`oauth_flows` / `consent_links` / `connector_tokens`），
HTTP 路由只做适配器。Token 落库前经 AES-256-GCM 信封密封（KEK =
`deriveConnectorKey(secrets[0], 'connector-tokens')`，用途派生、不落盘）；
启动缺 key 物料时 fail-closed（同 §2.2 缺生产策略语义），无明文回退模式。

**指标（§6.5）：**

| 指标 | 类型 | Labels | 语义 |
|---|---|---|---|
| `oauth_flow_total` | counter | `step=start\|callback\|complete`, `outcome=ok\|fail` | 每个 OAuth 流程步骤 |
| `oauth_token_decrypt_total` | counter | `provider`, `outcome=ok\|error` | 每次 vault 解密；`error` 表示无 KEK 可解（记录需重连） |
| `oauth_redaction_hit_total` | counter | `boundary=log\|observation` | token 形状字符串在边界被拦（区别于通用 `redaction_hit_total`） |

**告警（必须 page on-call）：**

- 任何非零 `oauth_token_decrypt_total{outcome="error"}`（plan §6.5）。
- 任何非零 `oauth_redaction_hit_total`。
- `oauth_flow_total{step="complete",outcome="fail"}` 突增（provider
  侧故障或配置漂移）。

**Runbook 动作：**

1. **在线轮换 KEK**（ADR-0017 Rotation）：
   1. 在部署 secret store 生成新 secret，追加到 `config.secrets` 首位
      （现有语义：首条铸造、其余验证）；
   2. 重启——新 seal 一律落在新 KEK 下，旧记录仍可解；
   3. 执行重加密清扫 `vault.resealAll()`（返回 `{total, resealed}`）；
   4. 清扫后确认所有 `connector_tokens` 行的 `keyId` 等于当前 kid，
      方可从 `config.secrets` 移除旧 secret。
2. **启动失败：`connectors surface requires signing secret material
   (fail-closed, ADR-0017)`**：connectors surface 开启但 `config.secrets`
   缺失/为空。修复：从部署 secret store（gopass `qm-next/<env>/`）恢复
   secret 后重启。没有明文回退；不得以跳过 connectors surface 的方式绕过。
3. **解密错误（`decrypt error` 告警）**：某记录无链内 KEK 可解——通常
   是旧 secret 被过早移除。该 token 不可恢复（设计如此）：将对应
   `(host, principalId)` 标记 needs-reconnect、删除 sealed 行、由用户
   重新连接账号。
4. **`redaction_hit` 告警**：某生产路径输出了 token 形状字符串——
   按红线事件处理：定位 producer、评估泄露面、轮换相关 token。

**Linked ADRs:** 0009 (Connector context owns OAuth), 0016 (Connector
tokens stay out of observation), 0017 (OAuth token encryption at rest)。
