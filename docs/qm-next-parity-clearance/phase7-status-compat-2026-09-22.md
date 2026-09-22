# Phase 7 cutover：`runs.complete()` 与观测端 `status` 字段的兼容性 finding（2026-09-22）

> **TL;DR.** Phase 7 切到 `runSource='target'` 后，`runs.complete()` 只写 `targetState`、**不再写** `status='done'`，但 `GET /v1/runs/:id` 仍把这条**永不变**的 `status` 字段暴露给所有观察端——包括 qm-next 自家 `scripts/qa-smoke.ts:187` 的 S4 终态判定。这导致 (a) 任何用 `status === 'done'` 的轮询都会**永远卡住**（async 路径假"挂起"），(b) 对照 `CONTEXT.md` 明文定义的 Run State 词表（`queued / running / awaiting approval / succeeded / failed / cancelled`，明确 *avoid `done`/`status`*），观测端语义与词表割裂。

## 1. 复现

最小复现（已运行验证）：

```ts
// 提交 async turn（无需 sandbox/工具，纯 echo 也复现）
const submit = await POST('/v1/turns?async=1', { text: 'Reply: PONG', surface: 'api', conversation: { kind: 'dm', threadRef: 'phase7-test' } })
const runId = submit.body.runId

// 轮询直到终态（错误实现）
while (true) {
  const body = await GET(`/v1/runs/${runId}`)
  if (body.status === 'done' || body.status === 'failed') break  // ← 永远不命中
  await sleep(400)
}
```

**实际观察**（`runner-async.mts` 输出，2026-09-22）：

```text
[S0#1] status=pending/target=queued       t+0.0s  attempt=0
[S0#1] status=running/target=running      t+0.3s  attempt=1
[S0#1] status=running/target=succeeded    t+2.4s  attempt=1   ← result 已写入，targetState 已 succeeded
                                                                  status 永远 stuck 在 running
```

最小化复现脚本：`/Users/wxd/.aidevops/.agent-workspace/tmp/qm-next-scenario-e2e/runner-async.mts`（最小配置）+ `runner-async-full.mts`（全 15 服务配置）。两种配置下现象一致。

## 2. 期望 vs 实际

| 维度 | 期望（按 CONTEXT.md 词表） | 实际（Phase 7 cutover 后） |
|---|---|---|
| Run 终态语义 | `targetState ∈ {succeeded, failed, cancelled}` 是唯一终态信号 | 同左，但 `targetState` 仅写入 run 内部字段 |
| `status` 字段 | 应归一化为 `Run State` 词表值（`queued/running/awaiting approval/succeeded/...`），或干脆移除 | 永远是 `pending` 或 `running`，**永不推进** |
| 第三方观测 | 任一字段都可作为终态信号（语义统一） | 必须查 `targetState` 才能判定终态 |

## 3. 根因（已二分定位）

`packages/store/src/memory-run-store.ts:179-195` 的 `complete()` 实现：

```ts
async complete(runId, leaseToken, result) {
  ...
  run.targetState = 'succeeded'      // ✅ 写
  // run.status = 'done'             // ❌ 永不再写
  delete run.failureReason
  run.result = result
  ...
}
```

文件头注释明确写："the legacy `status='done'` literal is never written"。Phase 7 cutover 把所有新行标 `runSource='target'`，历史 `runSource='legacy'` 行可能仍写 `status='done'`（迁移脚本未跑过）。

`GET /v1/runs/:id` 直接返回该 run 对象，未做 `targetState → status` 的归一化。

## 4. 影响范围

| 受影响方 | 现状 | 风险等级 |
|---|---|---|
| **qm-next 自家 qa-smoke §S4**（`scripts/qa-smoke.ts:187` `if (body.status === 'done' \|\| body.status === 'failed')`） | 同 bug：async PONG 也会"挂起" | **高 — S4 实质已回归** |
| **CONTEXT.md `Run State` 词条** | 仍按 `succeeded/failed/cancelled` 描述 | 中 — 文档与字段语义不一致 |
| **`docs/parity-api-contract.md` `GET /v1/runs/:id`** | 未注明 `status` 不再推进、与 `targetState` 区分 | 中 — 集成方无从知晓 |
| **任何第三方观测代码 / 监控仪表 / alerting** | 同 bug | 高 — 一旦有人在生产轮询，会误判 |

## 5. 修复方向（候选，按 ROI 排）

### A. 文档与观测端契约（最小 ROI）
- 更新 `CONTEXT.md`：明确 target-source 行的 `status` 字段不再推进；观测端必须用 `targetState`
- 更新 `docs/parity-api-contract.md` §`GET /v1/runs/:id`：注明字段语义分层
- 更新 `scripts/qa-smoke.ts` §S4：终态判定改为 `targetState in {succeeded, failed, cancelled}`

**成本**：纯文档 + 1 行代码改动。**价值**：保住现有观测代码能正确判终态。

### B. API 归一化（中等 ROI）
- `GET /v1/runs/:id` 内部：若 `targetState ∈ {succeeded, failed, cancelled}` 且 `status` 尚未推进，则**对外**暴露 `status` 与 `targetState` 一致
- 不改存储，只改读取路径

**成本**：~30 行，1 个文件改 + 1-2 个回归测试。**价值**：所有现存观测端（包含 qa-smoke §S4、第三方）零改动即恢复工作。

### C. 写时归一化（最彻底 ROI，但风险最高）
- `runs.complete()` 内部：写完 `targetState` 后，同步把 `status` 设为对应值（`succeeded` / `failed` / `cancelled`）——与 CONTEXT.md 词表对齐
- 触发历史 `runSource='legacy'` 行的迁移脚本

**成本**：~50 行 + 数据迁移脚本。**价值**：彻底消除字段语义分裂。**风险**：可能引入其他依赖 `status='running'` 作为中间态信号的代码路径的回归。

**推荐先 A 后 B**：A 立竿见影，B 是契约级修复；C 留到 Phase 8 收口。

## 6. 验证证据

| 证据 | 路径 / 命令 | 结果 |
|---|---|---|
| 最小复现（最小配置 + 完整配置双跑） | `/Users/wxd/.aidevops/.agent-workspace/tmp/qm-next-scenario-e2e/runner-async.mts` | `result.reply=PONG` 在 ~2s 写入，但 `status='running'` 永不推进 |
| 修复 monitor 后全套 4 场景 async 跑通 | `/Users/wxd/.aidevops/.agent-workspace/tmp/qm-next-scenario-e2e/runner-async-full.mts` | 4/4 PASS，38s 完成；状态时间线展示 status 永远 'running'，targetState 推进 |
| `runs.complete()` 实现 | `packages/store/src/memory-run-store.ts:179-195` | 见 §3 |
| `RunStore.complete()` 接口契约 | `packages/types/src/run.ts:204` | `(runId, leaseToken, result) => Promise<boolean>` |
| Phase 7 cutover 决策 | aa prior commits（`docs(plan,ledger): record 2026-09-22 closing decisions` 附近）；aa 本仓历史 `feature/qm-next-alignment-commandgate` 分支 | cutover 完成于 2026-09-20 |
| Run State 词表 | `CONTEXT.md` §"Run lifecycle" | 明文 avoid `done`/`status`/`result`；canonical states = `queued, running, awaiting approval, succeeded, failed, cancelled` |
| qa-smoke §S4 同病 | `scripts/qa-smoke.ts:187`（line 范围需在修复时复核） | `if (body.status === 'done' \|\| body.status === 'failed')` |

## 7. 关联 finding

- **qm-next 自家 X3a 审计**（`docs/qm-next-parity-clearance/x3a-command-policy-audit-2026-09-22.md`）：G2"双引擎均无生产接线"已通过 batch 4c/6 收口；本 finding 是**接通的代价**——观测端契约未随 Phase 7 cutover 同步。
- **`qm-vs-qm-next-diff-2026-09-22.md` §3.2 "未移植模块"**：未列入，因为这是 qm-next 自身 Phase 7 演进遗留的语义割裂，不是 vs qm 的偏差。

## 8. 后续

- 短期：本 finding 进入 `qm-next` repo 的 issue tracker（worker-ready 实现 issue = 方向 A 修复）。
- 中期：方向 B 写入 ADR-0020（观测端 API 归一化），作为 Phase 8 收口项。
- 长期：方向 C 待 Phase 8+ 决策，列入 `qm-next` 路线图。
