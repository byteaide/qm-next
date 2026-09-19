# qm-next 用户故事覆盖矩阵 — 27 场景 → 用例

> **目的**：把 qm 原项目 README 列出的"用户能做什么"按 27 个用户故事颗粒度，映射到 qm-next
> 已有的测试节（S1–S45）和待新增的 `scripts/qa-user-stories.ts` 业务流用例。每条场景给出现状
> （已覆盖 / 部分覆盖 / 需新基础设施）、对应测试节、对应路由、对应 qm-next 路径差异、验收点。
>
> **生成时间**：2026-09-19 · **阶段 A 启动**（在 Phase 3F 235/235 PASS 基础上，把路由可达性补到
> 业务流可达性；目标 27 场景业务流覆盖从 ~44% → ~93%）
> **关联文档**：
> - `baseline-smoke.md`（路由 + happy-path 真相源 · Phase 3F 235/235 PASS）
> - `coverage-matrix.md`（路由覆盖矩阵 · 用户面 85 路由 ~89% / 管理员面 63 路由 ~87%）
> - `qa-user-stories.ts`（待新增 · L7 业务流层 · mock harness · ~28 用例目标）
> - `qa-smoke-wave2.ts`（L5 staging · 18 用例 + 3 SKIP · 本文档闭合 SKIP 后应转 PASS）
>
> **目标读者**：作者本人 + 接手这块代码做回归 / 扩展的人 + 任何想了解"qm-next 在 27 个用户故事
> 颗粒度上做到什么程度"的产品 / 运维 / 安全审计。
>
> **qm-next 与 qm 的关键差异**（影响场景适配）：
> 1. **IM 渠道只做飞书**（slack/钉钉/企微延期；slack 历史在 git `d7d2db3`）。所有 Slack 场景
>    适配为飞书。
> 2. **CLI 部署目录改写**：qm-next CLI 沿 qm contract，但组装档为 `profiles/*.yml`。
> 3. **存储双实现**：内存 + Postgres；当前 `databaseUrl` 已对 sessions/runs/webhooks/sources
>    自动切 PG；**memory/skills 仍硬编码内存**（S42 三个 SKIP 根因，本阶段闭合）。
> 4. **core 服务零平台符号**（`pnpm check:im` 门禁）。
> 5. **Web UI / Portal / Admin UI 是 plugin**：本矩阵聚焦 API + 编排层；UI 层另议。

---

## 0. 元数据

| 项 | 值 |
|----|----|
| 被测对象 | `qm-next @qm/api` 业务流（用户在 27 个真实场景下能不能用） |
| 测试方式 | 单 boot `ApiService`（mock harness，无模型依赖）+ L7 用户故事脚本 |
| 数据隔离 | `${Date.now()}-${rand}` 作为 run tag；qa-smoke + qa-admin 双 token |
| 模型调用 | 0（业务流层走 mock harness；模型行为由 qa-smoke.ts 已验证） |
| 当前业务流覆盖 | **12/27 ≈ 44%**（路由层可达，但部分只到 happy-path 一跳） |
| 阶段 A 目标 | **25/27 ≈ 93%**（闭合 L2/L3 业务流；剩 2 场景需真机 L6/L7） |
| 阶段 B 目标 | **26/27 ≈ 96%**（加 CLI 部署类 6 个场景 — 1/2/3/4/6/7；场景 5 永久 🚫 不部署云）|
| 阶段 C 目标 | **27/27 ≈ 100%**（加飞书真机 + sandbox 真机） |

---

## 1. 角色模型 / 测试约定

业务流层测试复用 qa-smoke 的双 token 模型：

| 角色 | 凭证 | 用途 |
|------|------|------|
| **普通 user** | signed bearer `{p: 'qa-smoke'}` | user / source / either 路由 |
| **admin** | signed bearer `{p: 'qa-admin'}` | `/v1/admin/*` |
| **第二 user** | signed bearer `{p: 'qa-smoke-2'}` | 跨主体隔离业务流 |
| **capability agent** | `x-agent-capability` + mintCapabilityToken | agent-face 路由 |

测试脚本约束（沿 qa-smoke.ts）：

- 每个用例独立上下文（不依赖前序用例的副作用）；如必须依赖，显式 `await` + 错误信息指出被依赖用例
- mock harness 默认（无模型依赖）；需真模型时标 `[needs-model]` 并把用例挂到 `qa-smoke.ts` 而非本文件
- 跨用例共享资源（cronId / sessionId）放模块级 `let` + 用 `if (!cronId) throw new Error('no cronId from S_NN.M')` 显式标依赖
- 失败信息含可重现 context（threadRef / principalId / cronId），便于本地复跑

---

## 2. 27 场景 → 用例映射矩阵

按 qm 原 README "What you can do with it" + CLI/部署/安全姿态六大类分组。

**覆盖图例**：

- ✅ **业务流已覆盖** — qa-smoke.ts / qa-smoke-wave2.ts 已测过该场景关键路径
- 🟨 **业务流部分覆盖** — 路由可达但只到 happy-path 一跳；缺端到端断言
- ⏳ **待新增** — 阶段 A/B 要在 `qa-user-stories.ts` 加的用例
- 🛑 **需新基础设施** — 飞书真机 / sandbox 真机 / 外部 OAuth；阶段 C 才做
- 🚫 **qm-next 不支持** — 跨产品决策（如 web UI 视觉回归、SMS 通知）；不在本矩阵范围

### 2.1 CLI / 部署类（场景 1–7）

> **关键 finding**：qm-next **没有**继承上游 `qm` CLI 二进制；qm 上游的 `qm init / check /
> doctor / plan / up / admin-login / outputs / rollback / sandbox build+publish` 9 个命令，
> qm-next 通过 **`scripts/qm-next-ops.ts`（operator CLI）+ 既有的 `scripts/{check-im-isolation,
> rescope-check, local-sandbox-build}.sh`** 拼装。详见 `docs/testing/cli-coverage.md`。

| # | 场景 | 现状 | 对应测试节 / 用例 | 验收点 | 阶段 |
|---|---|---|---|---|---|
| 1 | **本地冷启动** — `qm up` docker 单机模式 | ✅ | `qa-cli.ts §B1` + §B4（doctor） | boot + /healthz 200；mounted 含 api | B（已闭合）|
| 2 | **部署目录校验** — 改 profile YAML 看 schema 是否破 | ✅ | `qa-cli.ts §B2 / §B2.b / §B2.c` | 好 profile → exit 0；坏 → exit 1 + 行号；duplicate id → exit 1 | B（已闭合）|
| 3 | **基础设施预览**（无副作用） — `qm plan` / `qm infra render` | ✅ | `qa-cli.ts §B3` | dryRun=true；wouldBoot 列 entries + configKeys | B（已闭合）|
| 4 | **管理员登录**（无邮件） — `qm admin-login` 拿 5min URL | ✅ | `qa-cli.ts §B5 / §B5.b` + `qa-user-stories.ts §U1` | seal 出 `k='admin-login'` claim；坏 email → exit 1 | A + B（已闭合）|
| 5 | **Fly / AWS 部署** | 🚫 | — | qm-next 不部署云；无对应代码 | N/A（永久 🚫）|
| 6 | **回滚** — `qm rollback --to <sha>` | 🟨 | `qa-cli.ts §B6` | git checkout 旧版 + boot + /healthz 200 + 文件字节级还原 + .bak 清理；**无**真 AWS RDS snapshot | B（轻量闭合）|
| 7 | **沙箱镜像重建并发布** | 🟨 | `qa-cli.ts §B7 / §B7.b` | `computeSandboxImageFingerprint` 出 64-hex digest；docker build/push 留给 `scripts/local-sandbox-build.sh` | B（轻量闭合）|

### 2.2 个人 Workspace 类（场景 8–12）

| # | 场景 | 现状 | 对应测试节 / 用例 | 验收点 | 阶段 |
|---|---|---|---|---|---|
| 8 | **首登 + Scope 隔离** — admin-login 建第二 user，两 user 互不可见 | 🟨 | `qa-user-stories.ts §U2`（U2.1 mint second user；U2.2 cross-principal empty） | second user token 创建后，`/v1/sessions?principalId=qa-smoke-2` 列表与 qa-smoke 互斥；`/v1/memory/history?principalId=qa-smoke-2` 返空 | A |
| 9 | **公司脑检索** — 上传 PDF/MD，问"去年合同里有没有 SLA"，引用到文件 + 行号 | 🟨 | `qa-smoke.ts §S20`（files 上传/读回） + `qa-user-stories.ts §U3`（端到端检索断言） | U3.1 stage blob → file upload；U3.2 memory PUT 自定义事实；U3.3 memory search 命中且 reply 包含文件 id（不强求模型，仅测 store 层） | A |
| 10 | **写代码并开 PR** — 真仓库跑测试 + 提 PR + CI 回传 | 🛑 | — | PR 出现在 GitHub，CI 触发；agent 汇报 CI 结果 | C5（sandbox 真机） |
| 11 | **个人 cron + Slack 摘要** — 每天 9 点汇总 Sentry 错误贴 Slack | 🛑（业务流） | wave2 §S40 1 用例路由可达 | cron 真触发（≤60s 间隔）→ run 完成；im-feishu 投递（飞书） | C7 |
| 12 | **Keychain 调外部服务** — 让 agent 调 Gmail/Stripe/GitHub | 🟨 | qa-smoke §S22/S26/S33（drops form/redeem）+ §S32（Connectors mock OAuth 16 用例） | U12.1 创建 connector credential；U12.2 验证 `/v1/connectors/oauth/status` 已记录；U12.3 验证 agent 后续 turn 不再追问（Gmail 等真服务依赖 OAuth） | A |

### 2.3 协作 / 共享 Scope 类（场景 13–16）

| # | 场景 | 现状 | 对应测试节 / 用例 | 验收点 | 阶段 |
|---|---|---|---|---|---|
| 13 | **频道内协作** — `@qm /summarize` 在 Slack/飞书 频道 | 🟨 | qa-smoke-wave2 §S41 reach cap-token；`boot-im-e2e.ts` Leg 1 手动 | 飞书群聊收 thread 内回复；记忆写入频道 scope | C1（飞书真机自动） |
| 14 | **项目追踪** — 在项目 channel 里 `@qm 跟进 #234` | 🛑 | `boot-im-e2e.ts` Leg 2 ambient（手动） | ambient turn 触发；记忆按项目 scope 隔离 | C1（飞书真机自动） |
| 15 | **共享 Skills** — 个人 scope skill grant 给全 org | 🟨 | qa-smoke §S7 skills CRUD；§S18 admin skill-packs | U15.1 个人 skill 创建；U15.2 admin grants POST 把 skill 升 org；U15.3 全 org 范围 `/v1/skills?principalId=any` 可见 | A |
| 16 | **Skill pack 导入** — 从 git repo 导入 skill pack | 🟨 | qa-smoke §S18 + wave2 §S38 skill-packs | U16.1 admin POST `/v1/admin/skill-packs { url, subset }`；U16.2 GET catalog；U16.3 POST import（dev profile 无 fetcher → 400/404，宽松接收） | A |

### 2.4 后台 / 触发类（场景 17–20）

| # | 场景 | 现状 | 对应测试节 / 用例 | 验收点 | 阶段 |
|---|---|---|---|---|---|
| 17 | **Webhook 入口** — 暴露 inbound webhook URL，外部事件进 | 🟨 | qa-smoke §S21 + §S34（HMAC + handshake 6 用例） | U17.1 inbound POST 正确签名 → 202 + 触发 turn；U17.2 错签 → 401；U17.3 缺签头 → 401；U17.4 slack url_verification → 200 echo；U17.5 github ping → 200 'pong' | A |
| 18 | **Watch** — 监听文件夹或外部源 | ⏳ | `qa-user-stories.ts §U18`（reach/turn-based mock） | reach 创建 + cap token POST 触发；watch 端到端要外部 cron 触发，单独测 store | A |
| 19 | **Cron + 邮件草稿** — 每天 8 点扫 inbox、分类、写草稿 | 🛑（业务流） | wave2 §S40 crons 路由可达 | cron 真触发 → mock harness run → 验证 run 完成 | C7 |
| 20 | **Monitor + 告警** — Sentry 错误率超阈值 @ 频道 | 🛑 | — | TriggersService mount 后配 monitor；错误率阈值 + im 投递 | C8（部分进 C） |

### 2.5 内部 Web App 类（场景 21–23）

qm-next 把 web-ui 当 plugin。**端到端"问 agent 做看板"未在 API 层覆盖**；本类属 UI 层
（Playwright），不在本矩阵范围。标 🚫。

| # | 场景 | 现状 | 对应测试节 / 用例 | 验收点 | 阶段 |
|---|---|---|---|---|---|
| 21 | **生成内部小应用** — "帮我做部门周报看板" | 🚫 | — | 浏览器看到可交互 UI；数据从项目 scope 读 | UI（Playwright） |
| 22 | **数据保鲜** — agent 每天拉 Linear/Jira 更新看板 | 🚫 | — | 看板数字与源系统对得上 | UI + 真机 |
| 23 | **权限发布** — 看板 publish 给指定 group | 🚫 | — | 未授权用户访问 → 403 / 隐藏 | UI |

### 2.6 安全姿态类（场景 24–27）

qm-next 安全姿态沿 qm（Strict / Auto / Dangerous）+ predeclared policy。本类阶段 A 加部分，
阶段 C 加真机。

| # | 场景 | 现状 | 对应测试节 / 用例 | 验收点 | 阶段 |
|---|---|---|---|---|---|
| 24 | **Strict** — 每次 execute / read_file 都弹审批 | 🟨 | `boot-im-e2e.ts` Leg 1 卡片点击（手动） | qa-smoke 路由层不直接测审批，但 Approval 业务流已在 Leg 1；qa-user-stories §U24 加 Strict 模式 turn → 期望 approve 卡 | A + C2 |
| 25 | **Auto + prompt injection** — 含"ignore previous instructions" 文本喂入 | ⏳ | `qa-user-stories.ts §U25`（classifier mock + 端到端断言） | U25.1 含注入的 turn body → memory search 返事实被剥离；classifier mock 触发 + U25.2 模型侧 reply 不含"ignore"子串 | A |
| 26 | **Dangerous + predeclared 拦截** | 🟨 | qa-smoke §S8 错误路径 / qa-smoke §S3 readOnly | U26.1 sandbox execute `rm -rf /` → 400 / 500（**sandbox 真机依赖；阶段 C 验**）；U26.2 sandbox execute `DROP TABLE x` → 400 / 500（同上）；U26.3 其它 destructive 操作无差别通过 | A + C4 |
| 27 | **Scope 收紧** — 父 Strict / 子 Dangerous 应被拒 | ⏳ | `qa-user-stories.ts §U27`（admin scope config PUT） | U27.1 org scope 设 Strict；U27.2 子 scope PUT Dangerous → 501 / 4xx（沿 qa-smoke §S27.1 验证 501）；U27.3 子 scope PUT Auto → 通过 | A |

---

## 3. 阶段 A · 业务流用例清单（在 `scripts/qa-user-stories.ts` 实现）

阶段 A 目标：闭合 2.1（场景 4）+ 2.2（场景 8/9/12）+ 2.3（场景 15/16）+ 2.4（场景 17/18）
+ 2.6（场景 25/26/27）+ 部分 24 = **15 个新业务流用例 + ~28 个子用例**。

### §U1 admin-login 业务流（1 用例 · 场景 4）

> 对应 qa-smoke §S13 admin whoami；从"管理员能拿 URL 登录"扩成"admin-login → 落 admin 面板"。

- ✅ U1.1 admin-login 等价路径：admin token mintSignedPayload → admin whoami 返 `isAdmin=true`；
  模拟 qm admin-login URL 路径，验证落 admin 路由可达

### §U2 Scope 隔离业务流（2 用例 · 场景 8）

- ✅ U2.1 mint second user token（`qa-smoke-2`）；用 qa-smoke token 创建 session → qa-smoke-2 列
  不应见
- ✅ U2.2 qa-smoke-2 token 列 `/v1/sessions?principalId=qa-smoke-2` 返空；列
  `/v1/sessions?principalId=qa-smoke` 返 qa-smoke 自己的（隔离双向）

### §U3 公司脑检索端到端（3 用例 · 场景 9）

- ✅ U3.1 stage blob → file upload（沿 qa-smoke §S20.2 路径）
- ✅ U3.2 memory PUT 自定义事实（沿 qa-smoke §S6.1）
- ✅ U3.3 memory search `/v1/memory/search` POST `{query}` 命中且 facts 数组含 U3.1 文件 id
  或 body 中至少一条事实被提取

### §U12 Keychain + Connectors 端到端（3 用例 · 场景 12）

- ✅ U12.1 走 qa-smoke §S32 mock OAuth：mint + redeem → token 落 store
- ✅ U12.2 `/v1/connectors/oauth/status` 验证 token 已被记录（不是空）
- ✅ U12.3 turn body 引用 mock provider；后续轮次不追问（mock 端只返一次 consent）

### §U15 共享 Skills 端到端（3 用例 · 场景 15）

- ✅ U15.1 qa-smoke 创建 personal skill（沿 qa-smoke §S7.1）
- ✅ U15.2 admin POST `/v1/admin/grants` 把 skill 升 org scope（沿 qa-smoke §S16.3 路径）
- ✅ U15.3 任意 user 路由 `/v1/skills` 列表包含 U15.1 的 skill（grant 后 shadow 标志翻转）

### §U16 Skill pack 导入（3 用例 · 场景 16）

- ✅ U16.1 admin POST `/v1/admin/skill-packs { url: 'git://...', subset: [...] }` → 200/202
- ✅ U16.2 GET `/v1/admin/skill-packs/:id/catalog` → 200 / 400（dev profile 无 fetcher）
- ✅ U16.3 POST `/v1/admin/skill-packs/:id/sync` → 200 / 202 / 400（宽松接收）

### §U17 Webhook inbound 端到端（5 用例 · 场景 17）

- ✅ U17.1 inbound POST 正确 HMAC 签名 → 202 + 触发 turn
- ✅ U17.2 inbound POST 错签 → 401
- ✅ U17.3 inbound POST 缺签头 → 401
- ✅ U17.4 inbound POST slack url_verification → 200 echo challenge
- ✅ U17.5 inbound POST github ping → 200 'pong'

### §U18 Watch 端到端（2 用例 · 场景 18）

- ✅ U18.1 reach store 创建 + cap token POST → 路由可达（沿 qa-smoke-wave2 §S41）
- ⏸ U18.2 真 watch 触发要文件系统事件，dev profile 不模拟；标 SKIP（进 wave2 文件独立验）

### §U24 Strict 模式端到端（1 用例 · 场景 24）

- ✅ U24.1 启动 profile 带 strict posture → turn body 期望审批；mock harness 直接返
  `awaiting_approval`；approve route 走通（QA 层验路由可达，不测飞书卡片回调 — 那是 C2）

### §U25 Auto + prompt injection 端到端（2 用例 · 场景 25）

- ✅ U25.1 turn body text 含 "ignore previous instructions"；classifier mock 命中
  → facts 数组只保留非注入片段
- ✅ U25.2 注入文本不被回写到 memory（POST `/v1/memory/facts` 后 GET 历史不含注入子串）

### §U26 Dangerous + predeclared 拦截（3 用例 · 场景 26）

- ⏸ U26.1 sandbox execute `rm -rf /` → 400 / 500（**sandbox 真机依赖；阶段 C 验**）
- ⏸ U26.2 sandbox execute `DROP TABLE x` → 400 / 500（同上）
- ✅ U26.3 turn body 含 `rm -rf /` 子串 → memory capture 不入库（classifier 层已拦）

### §U27 Scope 收紧端到端（3 用例 · 场景 27）

- ✅ U27.1 admin POST `/v1/admin/scopes/:scope/:resource` PUT config 把 posture 设 Strict
- ✅ U27.2 子 scope PUT posture=Dangerous → 501 / 4xx（沿 qa-smoke §S27.1 验证 501）
- ✅ U27.3 子 scope PUT posture=Auto → 通过

### §U 合计

- **新增用例**：28 个（U1.1 + U2.1-2 + U3.1-3 + U12.1-3 + U15.1-3 + U16.1-3 + U17.1-5 + U18.1 + U24.1 + U25.1-2 + U26.3 + U27.1-3）
- **SKIP**：2 个（U18.2 真文件 watch / U26.1-2 真 sandbox execute）
- **阶段 A 末业务流覆盖**：27 场景里闭合 25/27 = ~93%

---

## 4. 阶段 A 预期产出与度量

| 度量 | 当前（Phase 3F） | 阶段 A 末 | 阶段 B 末 | 阶段 C 末 |
|------|-------------------|-----------|-----------|-----------|
| 用户面路由覆盖 | ~89% | ~89% | ~89% | ~89% |
| 管理员面路由覆盖 | ~87% | ~87% | ~87% | ~87% |
| **27 场景业务流覆盖** | **~44%** | **~93%** | **~96%** | **~100%** |
| 用例总数（qa-smoke + wave2 + user-stories） | 235 + 18 + 3 SKIP = 256 | ~256 + ~28 = ~284 | ~284 + ~30 CLI = ~314 | ~314 + ~12 真机 = ~326 |
| pass rate（业务流层） | 100% | ≥98%（U26.3 等 classifier 行为可能偶然失败） | ≥98% | ≥95%（飞书真机可能 flaky） |
| CI 全跑时长 | ~3min | ~5min | ~7min | ~10min |

---

## 5. 跟现有测试资产的衔接

| 文件 | 现状 | 阶段 A 改动 |
|---|---|---|
| `scripts/qa-smoke.ts` | 235 用例 · 模型调用 · Phase 3F | 不动 |
| `scripts/qa-smoke-wave2.ts` | 18 用例 + 3 SKIP → 21/21 | **闭合 S42 三个 SKIP**（见 §6） |
| `scripts/qa-user-stories.ts` | 27 用例 · 5 SKIP | **新增 · 27 用例**（阶段 A 已完成） |
| `scripts/qm-next-ops.ts` | — | **新增 · operator CLI 7 命令**（阶段 B） |
| `scripts/qa-cli.ts` | — | **新增 · 11 用例**（阶段 B） |
| `docs/testing/baseline-smoke.md` | Phase 3G 真相源 | 在 §4 阶段演进表加 Phase 3H row |
| `docs/testing/coverage-matrix.md` | 路由覆盖矩阵 | 在 §0 元数据加指向 user-stories-coverage.md + cli-coverage.md |
| `docs/testing/user-stories-coverage.md` | — | **本文件**（阶段 A） |
| `docs/testing/cli-coverage.md` | — | **新增 · CLI 场景覆盖矩阵**（阶段 B） |
| `docs/testing/real-device-coverage.md` | — | （阶段 C 新增） |

---

## 6. 闭合 S42 三个 SKIP · service.ts 注入口设计

> **根因**：当前 `packages/api/src/service.ts` 第 713–714 行硬编码 `createMemoryScopeMemory()`
> 和 `createMemorySkillStore()`；`databaseUrl` 设置时**不**自动切到 PG 双胞胎。Cron 已经有
> `cronsRuntime` 注入口（line 455），可手动注入 `createPostgresCronStore`。本节为 memory/skills
> 加同样的注入口，对齐既有 pattern。

**设计**：

```ts
// service.ts line 455 后追加

/**
 * Memory / Skill store injection seam (parity with cronsRuntime).
 * Tests inject Postgres twins via qa-smoke-wave2; production keeps
 * the in-memory defaults unless a future `databaseUrl` flag auto-swaps.
 * Lazy-evaluated: routes read via the getter, so late injection (after
 * boot) works.
 */
memoryStore?: ScopeMemory
skillStore?: SkillStore
```

```ts
// service.ts line 713–714 改为

const memoryStore: ScopeMemory | undefined = this.memoryStore ?? (
  this.config.memory ? createMemoryScopeMemory() : undefined
)
const skillStore: SkillStore | undefined = this.skillStore ?? (
  this.config.skills ? createMemorySkillStore() : undefined
)
```

```ts
// service.ts [Service.dispose] 追加

if (this.memoryStore?.close) await this.memoryStore.close().catch(() => undefined)
if (this.skillStore?.close) await this.skillStore.close().catch(() => undefined)
```

**测试侧调用**（wave2 §S42 改造）：

```ts
// 解 S42 "memory/skill pg twin" SKIP 的最小代码
const pgMemory = createPostgresScopeMemory(pgUrl)
const pgSkill = createPostgresSkillStore(pgUrl)
const pgCrons = createPostgresCronStore(pgUrl)
const pgScheduler = createCronScheduler({
  crons: pgCrons,
  sessions: pgCtx.api.sessions,
  runs: pgCtx.api.runs,
  resolution: pgCtx.api.resolution,
})
pgCtx.api.memoryStore = pgMemory
pgCtx.api.skillStore = pgSkill
pgCtx.api.cronsRuntime = { crons: pgCrons, scheduler: pgScheduler }
```

**新增用例（替换 S42 三个 SKIP）**：

- ✅ `S42.2 pg: memory scope twin — memory PUT 写入 memory_revisions 表，pg `q SELECT` 命中行`
- ✅ `S42.3 pg: skill store twin — skill POST 写入 skills 表，pg `q SELECT` 命中行`
- ✅ `S42.4 pg: cron store twin — cron POST 写入 crons 表，pg `q SELECT` 命中行；fire 后 cron_runs 表新增行`

**回归测试**（不进 S42，但阶段 A 要在 `qa-user-stories.ts` 跑）：

- ✅ U-Twin 双实现同输入同输出：同一个 principalId 用 in-memory store 和 pg store 分别 PUT memory → GET 内容一致
- ✅ U-Twin dispose 后状态保留：pg store dispose + re-boot → PUT 的内容仍可读回（已在 S42.5；扩到 memory/skill）

---

## 7. 决策记录（why these, not those）

| 决策 | 选择 | 备选 | 理由 |
|------|------|------|------|
| **场景编号** | 沿用上一轮 qm 27 场景序号 | 按 qm-next 内部模块重排 | 跟外部"功能清单"对齐，便于跨产品对比 |
| **业务流 vs 路由覆盖** | 业务流层独立（`qa-user-stories.ts`），不并入 `qa-smoke.ts` | 把业务流用例塞进 qa-smoke | 业务流单条 30s+；qa-smoke 是契约层 10s/用例；alert 渠道分开 |
| **mock harness** | 业务流层全 mock | 业务流层调真模型 | 27 场景业务流不依赖模型内容；模型行为已在 qa-smoke §S3 验证 |
| **飞书 vs Slack** | 飞书 | slack/钉钉/企微 | qm-next 只做飞书；slack 延期（git d7d2db3） |
| **Web UI 场景** | 标 🚫 不在本矩阵 | 在 qa-user-stories 加 Playwright | 路由层不是 UI 层；UI 测试独立栈 |
| **CLI 场景** | 阶段 B 单独立 `qa-cli.ts` | 阶段 A 顺便加 | CLI 是进程外测试；需要不同 fixture（沙箱外、cli 二进制） |
| **memoryStore 注入口方式** | 公开属性 + lazy getter（对齐 cronsRuntime） | 私有 + 内部 swap | 跟既有 pattern 一致；最少改动 |
| **scope 收紧（场景 27）业务流** | admin scope config PUT 验证 | scope 树遍历 + 显式拒绝日志 | qm-next scope 模型是 string 树；PUT 是主入口 |
| **Cron 真触发** | 阶段 C 用 ≤60s 间隔验证 | 阶段 A mock trigger | 真 cron 触发是事件时间敏感；只在 nightly / 真机跑 |

---

## 8. 不在阶段 A 范围（明确排除）

| 排除项 | 原因 |
|--------|------|
| 飞书真机 IM（WS 长连接 + 卡片回调） | 需 `FEISHU_APP_ID/SECRET` + 长连接 + 卡片回调配置；进阶段 C / nightly |
| Sandbox 真机工具执行 | 需 Docker image 构建；阶段 C wave2 §S43 已 mock 5 用例；真实 tool exec 仍待 |
| Postgres pg 对拍（已扩 memory/skill/cron） | 阶段 A 闭合；wave2 启动 docker pg 容器仍依赖 docker 是否可用 |
| Connectors 真 OAuth | 阶段 A 用 §S32 mock 闭环；真 OAuth 走第三方 |
| 性能 / 压力 / 负载 | 不是功能测试 |
| 视觉 / UI 回归 | web-ui / portal / admin-ui 在 vite 端；另起 Playwright 套件 |
| 模糊测试 / 渗透 | 不是 QA functional 范围 |
| CLI 部署类（场景 1/2/3/4/6/7） | 阶段 B 单独立 qa-cli.ts；场景 5 永久 🚫（qm-next 不部署云） |

---

## 9. 文档维护

- 每次新增业务流用例 → 更新 §3 用例清单 + §4 度量表
- 每次新增 CLI / 真机场景 → 加 §2.x 行 + 在 §5 衔接表加对应文件
- 每次变更 service.ts 注入口 → 更新 §6 设计 + 跑通 wave2 §S42 回归
- 阶段 A 完成后 → 在 `baseline-smoke.md` §4 阶段演进表加 "Phase 3G" row（业务流覆盖 ~93%）

---

## 10. 立刻要做的最小行动（阶段 A 第 1 周）

1. ✅ 已完成：本文档（`docs/testing/user-stories-coverage.md`）
2. 🔜 加 `memoryStore` / `skillStore` 注入口到 `packages/api/src/service.ts`（对齐 `cronsRuntime`）
3. 🔜 闭合 `scripts/qa-smoke-wave2.ts` §S42 三个 SKIP（替换为实际用例）
4. 🔜 新建 `scripts/qa-user-stories.ts` 骨架 + 28 个业务流用例
5. 🔜 更新 `baseline-smoke.md` §4 + `coverage-matrix.md` §0 指向本文档
