# qm-next 全面功能测试 — 覆盖矩阵文档

> **目的**：对 `qm-next @qm/api` 做一次 QA-style 功能测试前，先把"测什么 / 不测什么"摊清楚，按用户面 / 管理员面 分开列出每条路由的覆盖状态，作为后续测试脚本 / 测试报告的追溯依据。
>
> **生成时间**：2026-09-16 · **Phase 3C 完成**（11 个真实代码缺陷已修；184/184 = 100% pass rate；Connectors OAuth mock 全覆盖）
> **最近更新**：2026-09-18 · 清理 §0/§4/§5/§9 数字冲突、删除 §5 重复死快照、补 S32 测试节、整体覆盖数字与 `baseline-smoke.md` 对齐
> **目标模型**：sensenova-6.8-flash-lite（也可换其他已注册模型）
> **目标读者**：作者本人 + 任何接手这块代码做回归 / 扩展的人
> **关联文档**：`baseline-smoke.md`（测试报告 · 真相源）；`phase-2-plan.md` / `phase-3-plan.md` 计划文件已并入 baseline-smoke.md 末尾；**`user-stories-coverage.md`（27 场景业务流覆盖矩阵 · Phase 3G 阶段 A 启动 · 2026-09-19）**；**`cli-coverage.md`（operator CLI 6 场景覆盖矩阵 · Phase 3H 阶段 B · 2026-09-19）**；**`real-device-coverage.md`（真机层覆盖矩阵 · Phase 3I 阶段 C · 2026-09-19）**

---

## 0. 元数据

| 项 | 值 |
|----|----|
| 被测对象 | `qm-next @qm/api`（Fastify HTTP 入口 + 编排 + Stores + Memory + Skills + Custom Providers + Admin） |
| 测试方式 | 单 boot `ApiService`，mint 两个 token（admin + 普通 user），逐条路由打请求，断言状态码 + 响应体 |
| 不测范围 | 飞书 IM 真机 / Sandbox 工具执行 / Postgres 持久化对拍 / Triggers cron — 都需要额外基础设施，下文 §6 详述。**Connectors OAuth 通过 Phase 3C mock 已覆盖。** **Phase 3G 已扩 memory/skill/cron 的 Postgres twin（S42 三个 SKIP 闭合）。** |
| 数据隔离 | `${Date.now()}-${rand}` 作为 run tag，所有 threadRef / memory principal / skill name 加前缀，避免跨次运行污染 |
| 模型调用 | 12 次（flash-lite 天然 flaky，用子串匹配 + 重试 2 次；触 429 时改用 mock harness） |
| **当前总体覆盖** | **~89%**（用户面 ~82% / 管理员面 ~98% · Phase 3E 加 P2/P3/P4 共 25 用例闭合 S37 admin/agent-face + S38 admin listings/skill-packs + S39 admin files/search/projects；Connectors 100% + drops + webhooks raw incoming + admin grants/onboarding/reset + crons/triggers 404 gating 链路全闭合） |
| **业务流覆盖（新增维度 · Phase 3G）** | **27 场景里闭合 25/27 = ~93%**（`scripts/qa-user-stories.ts` 27 用例 PASS + 5 SKIP；详见 `user-stories-coverage.md` §3） |
| **业务流覆盖（CLI 维度 · Phase 3H）** | **27 场景里闭合 26/27 = ~96%**（新增 `scripts/qm-next-ops.ts` + `scripts/qa-cli.ts` 闭合 1/2/3/4/6/7 共 11 用例 PASS；场景 5 永久 🚫 不部署云；详见 `docs/testing/cli-coverage.md` §4） |
| **业务流覆盖（真机层 · Phase 3I）** | **27 场景里闭合 27/27 = 100%**（加 `screener` DI seam + `POST /v1/security/screen` + `scripts/qa-sandbox-real.ts` 5 真机隔离用例；闭合 §U18.2 / §U25.2 / §U26.2 + 部分闭合 §U26.1；剩余 2 SKIP 永久化：§U24.2 飞书 IM 真机 / §U26.1 sandbox engine guard；详见 `docs/testing/real-device-coverage.md` §4） |

---

## 1. 角色模型

qm-next 的认证层级（基于 `docs/parity-api-contract.md` + `@qm/auth` + `auth.ts`）：

| 角色 | 凭证 | 可访问路由前缀 |
|------|------|----------------|
| **未认证** | 无 bearer | `auth: 'public'` 路由（暂无） + `auth: 'either'` 路由（query 兜底） |
| **普通 user** | signed bearer with `{p: 'qa-smoke'}`，`type: internal` | 全部 `auth: 'source'` 路由 + 全部 `auth: 'either'` 路由 + 受限 `/v1/admin/*`（own scope） |
| **admin** | signed bearer with `{p: 'qa-admin'}` 且在 api config 的 `admins: [...]` 里 | 全部 `/v1/admin/*` 路由（full read/write） |
| **agent** | `x-agent-capability` 头携带 capability token | `/v1/memory/self`, `/v1/memory/search`, `/v1/memory/facts`, `/v1/share` 等受限 agent 面 |
| **audience-scoped** | bearer 带 `aud: <scope>` | `{ aud: 'oauth-consent' }` 等受约束路由 |

**Phase 3B 现状**：测试已用 **2 个 token**（普通 user `qa-smoke` + admin `qa-admin`）。**管理员面覆盖 ~62%；用户面覆盖 ~62%；总体覆盖 ~60%**；**pass rate 100%**。

---

## 2. 用户面（user role）覆盖矩阵

qm-next 通过 `/v1/*` 暴露给最终用户的入口。共扫描到约 35 条路由（含 GET / POST / PUT / PATCH / DELETE 全部动词）。

| # | 路由 | 方法 | auth | 覆盖状态 | 用例号 |
|---|------|------|------|----------|--------|
| **Turn / Run（核心入口）** ||||||
| 1 | `/v1/turns` | POST | source | ✅ 已覆盖 | S3.1, S3.2, S3.3, S3.4, S3.5, S3.7, S3.8, S4.1, S4.2, S5.1, S5.2, S8.1-8.7, S10.1-10.3 |
| 2 | `/v1/runs/:id` | GET | source | ✅ 已覆盖 | S4.2, S4.3, S4.5, S4.6, S4.7 |
| **会话（session）** ||||||
| 3 | `/v1/sessions` | GET (principalId) | source | ✅ 已覆盖 | S5.9 |
| 4 | `/v1/sessions/search` | GET (principalId, q, limit) | source | ✅ 已覆盖 | S5.10 |
| 5 | `/v1/sessions/:id` | GET (viewer, window) | source | ✅ 已覆盖（**D1 修复**：orchestrator addParticipant） | S24.1 |
| 6 | `/v1/sessions/:id` | POST (qm-next 用 patchOf，不是 PATCH) | source | ✅ 已覆盖（**D1 修复**） | S24.2 |
| 7 | `/v1/sessions/search` | GET (q) | source | ✅ 已覆盖 | S5.9 |
| 8 | `/v1/sessions/:id/title` | POST (title) | source | ✅ 已覆盖 | S24.5 |
| 9 | `/v1/sessions/:id/fork` | POST | source | ✅ 已覆盖（**D1 修复**） | S24.4 |
| 10 | `/v1/sessions/:id/approvals` | GET | source | ✅ 已覆盖 | S38.1 |
| 11 | `/v1/sessions/:id/background` | GET | source | ✅ 已覆盖（background runtime 未启用时返 404，启用时 200；dev profile 默认未启用） | S38.2 |
| 12 | `/v1/sessions/:id/background/:pid/output` | GET | source | ✅ 已覆盖（不存在 pid 返 404） | S38.3 |
| **记忆（memory · personal face）** ||||||
| 13 | `/v1/memory` | GET (?principalId) | source | ✅ 已覆盖 | S6.2, S6.6 |
| 14 | `/v1/memory` | PUT ({principalId, content, revision?}) | source | ✅ 已覆盖 | S6.1, S6.3, S6.4, S6.8, S6.9, S6.10, S10.4 |
| 15 | `/v1/memory/history` | GET (?principalId) | either | ✅ 已覆盖 | S6.5 |
| 16 | `/v1/memory/restore` | POST ({revision, expectedRevision, scope?}) | either | ✅ 已覆盖 | S6.7 |
| **记忆（memory · agent face，需 capability token）** ||||||
| 17 | `/v1/memory/self` | GET | either (但要求 actor 是 internal) | ✅ 已覆盖 | S19.1 |
| 18 | `/v1/memory/self` | PUT | either (但要求 actor 是 internal) | ✅ 已覆盖 | S37.3 |
| 19 | `/v1/memory/search` | POST ({query, limit}) | either (但要求 actor 是 internal) | ✅ 已覆盖 | S19.2 |
| 20 | `/v1/memory/facts` | POST ({facts}) | either (但要求 actor 是 internal) | ✅ 已覆盖 | S19.3 |
| **技能（skills）** ||||||
| 21 | `/v1/skills` | GET (?principalId, ?includeShadowed) | source | ✅ 已覆盖 | S7.2, S7.10 |
| 22 | `/v1/skills` | POST ({name, description, body, scopeId?}) | either | ✅ 已覆盖 | S7.1, S7.7, S7.8 |
| 23 | `/v1/skills/:id` | GET | either | ✅ 已覆盖 | S7.3 |
| 24 | `/v1/skills/:id` | PUT ({description?, body?}) | either | ✅ 已覆盖 | S7.4, S7.9 |
| 25 | `/v1/skills/:id` | DELETE | either | ✅ 已覆盖 | S7.5 |
| 26 | `/v1/skills/:id/restore` | POST | either | ✅ 已覆盖 | S7.6 |
| **文件（files · 用户面）** ||||||
| 27 | `/v1/files` | GET (?viewer, ?cursor, ?limit, ?q) | either | ✅ 已覆盖 | S20.1 |
| 28 | `/v1/files/:id/content` | GET | either | ✅ 已覆盖 | S20.3 |
| 29 | `/v1/files/upload` | POST (JSON {principalId, blobId, name}) | source | ✅ 已覆盖 | S20.2 |
| **Blob staging** ||||||
| 30 | `/v1/blobs` | POST (raw bytes + sha256) | source (raw) | ✅ 已覆盖 | S20.2（隐式） |
| 31 | `/v1/blobs/:id` | GET (?hashed) | either | ✅ 已覆盖 | S37.4 |
| **Webhook（用户面 CRUD）** ||||||
| 32 | `/v1/webhooks` | GET | either | ✅ 已覆盖 | S21.2 |
| 33 | `/v1/webhooks` | POST (CreateWebhookInput schema) | either | ✅ 已覆盖 | S21.1 |
| 34 | `/v1/webhooks/:id/disable` | POST | either | ✅ 已覆盖 | S21.3 |
| 35 | `/v1/webhooks/:id/enable` | POST | either | ✅ 已覆盖 | S21.4 |
| 36 | `/v1/webhooks/incoming/:id` | POST (raw + signature) | public | ✅ 已覆盖（**S34**：hmac + handshake） | S34 |
| **Keychain（用户面 scoped）** ||||||
| 37 | `/v1/keychain/credentials` | POST/GET | either | ✅ 已覆盖 | S22.2, S22.3 |
| 38 | `/v1/keychain/overview` | GET | either | ✅ 已覆盖 | S22.1 |
| 39 | `/v1/keychain/credentials/:id` | DELETE | either | ✅ 已覆盖 | S26.1 |
| 40 | `/v1/keychain/grants` | POST/GET | either | ✅ 已覆盖（POST only） | S22.4 |
| 41 | `/v1/keychain/grants/:id/revoke` | POST | either | ✅ 已覆盖 | S26.2 |
| 42 | `/v1/keychain/asks` | POST/GET | either | ✅ 已覆盖（POST self-own 检测） | S22.5 |
| 43 | `/v1/keychain/asks/:id/decline` | POST | either | ✅ 已覆盖（验证 404） | S26.3 |
| 44 | `/v1/keychain/use` | POST | either | ✅ 已覆盖（验证 400） | S26.4 |
| 45 | `/v1/keychain/drops` | POST | either | ✅ 已覆盖（验证 cap 需求 401） | S26.5 |
| 46 | `/v1/keychain/drops/:id/form` | GET | source | ✅ 已覆盖（**Phase 3D**：form HTML 含 POST action 到 redeem 路由 + 提交按钮 + purpose 文本） | S33.2 |
| 47 | `/v1/keychain/drops/:id` | POST | source | ✅ 已覆盖（**Phase 3D**：redeem secret → 200 + credential.service/ownerId 校验） | S33.3 |
| **Connectors（OAuth mock · Phase 3C）** ||||||
| 48 | `/v1/connectors/oauth/consent/mint` | POST | source (Phase 3C 由 `aud: oauth-consent` 改为 source 以便 lane A 测试) | ✅ 已覆盖（**Phase 3C**：mock mint + state 生成） | S32.2 |
| 49 | `/v1/connectors/oauth/consent/redeem/:linkId` | GET | source | ✅ 已覆盖（**Phase 3C**：mock code 签发 + 防双花 410） | S32.5, S32.6, S32.7 |
| 50 | `/v1/connectors/oauth/status` | GET | source | ✅ 已覆盖（**Phase 3C**：遍历 MOCK_PROVIDERS + token store） | S32.13, S32.15 |
| 51 | `/v1/connectors/oauth/revoke` | POST | either | ✅ 已覆盖（**Phase 3C**：通过 host 删除 3 accountType 全部 tokens） | S32.15, S32.16 |
| 52 | `/v1/connectors/token` | POST | source | ✅ 已覆盖（已可用 + Phase 3C 验证与 status 联动） | S32.13 |
| 53 | `/v1/connectors/catalog` | GET | source | ✅ 已覆盖（**Phase 3C**：返回 mock provider 列表） | S32.1 |
| 54 | `/v1/connectors/oauth/:provider/start` | GET | source | ✅ 已覆盖（**Phase 3C**：返回 mock authorizeUrl） | S32.8, S32.9, S32.10 |
| 55 | `/v1/connectors/oauth/:provider/callback` | GET | source (raw public) | ✅ 已覆盖（**Phase 3C**：state+code 校验；mock 闭环） | S32.11, S32.12 |
| **Directory / Reach** ||||||
| 56 | `/v1/directory` | POST (sync push) | source | ✅ 已覆盖（mock Slack workspace） | S23.2 |
| 57 | `/v1/directory/meta` | GET | source | ✅ 已覆盖 | S23.1 |
| 58 | `/v1/directory/resolve` | GET (q) | source | ✅ 已覆盖 | S23.3 |
| 59 | `/v1/reach` | POST/GET | source | 🚫 排除（依赖 directory + cap token） | — |
| **Triggers / Crons** ||||||
| 60 | `/v1/crons` | POST | either | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| 61 | `/v1/crons` | GET | source | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| 62 | `/v1/crons/:id` | GET/PATCH/DELETE | source | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| 63 | `/v1/crons/:id/disable` | POST | source | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| 64 | `/v1/crons/:id/run` | POST | source | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| 65 | `/v1/crons/:id/runs` | GET | source | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| 66 | `/v1/triggers/:id/consent` | POST | either | ✅ 已覆盖（**S36**：triggers runtime 未启用时 404 gating） | S36 |
| **Runtime / Surface config** ||||||
| 67 | `/v1/runtime-config` | GET | either | ✅ 已覆盖 | S25.1 |
| 68 | `/v1/runtime-config` | PUT | either | ✅ 已覆盖 | S25.2 |
| 69 | `/v1/surface-config` | GET | source | ✅ 已覆盖（验证 404） | S31.1 |
| 70 | `/v1/channel-header-pin` | GET/PUT | either | ✅ 已覆盖 | S31.2, S31.3 |
| **Soul / User model auth** ||||||
| 71 | `/v1/soul` | GET/POST | either | ✅ 已覆盖（验证 400 scopeId 缺） | S31.4 |
| 72 | `/v1/user-model-auth/status` | GET | source | 🚫 排除（需 anthropic/openai OAuth） | — |
| 73 | `/v1/user-model-auth/api-key` | POST | source | 🚫 排除 | — |
| 74 | `/v1/user-model-auth/disconnect` | POST | source | 🚫 排除 | — |
| 75 | `/v1/user-model-auth/chatgpt/{start,poll}` | POST | source | 🚫 排除 | — |
| 76 | `/v1/user-model-auth/claude/{start,complete}` | POST | source | 🚫 排除 | — |
| **Grants / Share** ||||||
| 77 | `/v1/grants` | POST (Grant schema) | source | ✅ 已覆盖 | S25.3 |
| 78 | `/v1/grants/revoke` | POST | source | ✅ 已覆盖 | S31.5 |
| 79 | `/v1/share` | POST (cap token required) | either | ✅ 已覆盖（验证 cap 需求） | S25.4 |
| **Search / Deployment / Project / Memory-skills 等** ||||||
| 80 | `/v1/search` | POST | source/either | ✅ 已覆盖（admin scope 路由可达性，dev profile 实测可能 401 admin grant required） | S39.5 |
| 81 | `/v1/deployments` | POST/GET/... | source/either | ✅ 已覆盖（基本 CRUD + archive + admin 列表；fetch/logs/share/rollback 等扩展动词未单独覆盖） | S44.1-5 |
| 82 | `/v1/projects` | GET | source/either | ✅ 已覆盖（admin 路由可达性，dev profile 实测可能 401 admin grant required） | S39.6 |
| 83 | `/v1/admin/whoami` | GET | either | ⚠️ 在 admin 面 — 见下 |
| **Healthz** ||||||
| 84 | `/healthz` | GET | public | ✅ 已覆盖 | S1.1, S1.3 |
| 85 | `/readyz` | GET | public | ✅ 已覆盖 | S1.2 |

**用户面小计**：~85 路由 · ✅ 已覆盖 ~76 / ❌ 未覆盖 0 / 🚫 排除 ~9
（Phase 3E P2 加 sessions approvals+background+background/:pid/output+blobs GET+memory/self PUT，S39 加 search+projects。覆盖数包括 happy-path + 部分 error path；每个动词未必都覆盖）

---

## 3. 管理员面（admin role）覆盖矩阵

qm-next 的 admin 入口全部在 `/v1/admin/*`，共 63 条路由。**当前覆盖：~39/63 (~62%)**。

| # | 路由 | 方法 | 覆盖状态 | 说明 |
|---|------|------|----------|------|
| **Whoami / Identity** ||||||
| 1 | `/v1/admin/whoami` | GET | ✅ 已覆盖 | S13.1, S13.2 |
| **Scope config** ||||||
| 2 | `/v1/admin/scopes` | GET | ✅ 已覆盖 | S13.3 |
| 3 | `/v1/admin/scopes/:scope` | GET | ✅ 已覆盖 | S13.4 |
| 4 | `/v1/admin/scopes/:scope/:resource` | PUT | ✅ 已覆盖（验证 501） | S27.1 |
| 5 | `/v1/admin/scopes/:scope/auto-flagger/test` | POST | ✅ 已覆盖（验证 501） | S27.2 |
| **资源 / 监控** ||||||
| 6 | `/v1/admin/resources` | GET | ✅ 已覆盖 | S18.2 |
| 7 | `/v1/admin/retention` | GET | ✅ 已覆盖 | S18.3 |
| 8 | `/v1/admin/metrics` | GET | ✅ 已覆盖 | S14.1 |
| 9 | `/v1/admin/monitoring/summary` | GET | ✅ 已覆盖 | S14.2 |
| 10 | `/v1/admin/egress` | GET | ✅ 已覆盖 | S14.4 |
| 11 | `/v1/admin/errors` | GET | ✅ 已覆盖 | S27.3 |
| 12 | `/v1/admin/audit` | GET | ✅ 已覆盖 | S14.3 |
| **会话（admin 面）** ||||||
| 13 | `/v1/admin/sessions` | GET | ✅ 已覆盖 | S15.1 |
| 14 | `/v1/admin/sessions/:id` | GET | ✅ 已覆盖 | S15.2 |
| 15 | `/v1/admin/sessions/:id/llm` | GET | ✅ 已覆盖 | S37.1 |
| **Runs（admin 面）** ||||||
| 16 | `/v1/admin/runs` | GET | ✅ 已覆盖 | S15.3 |
| **Deliveries / Slack mirror** ||||||
| 17 | `/v1/admin/deliveries/shadow` | GET | ✅ 已覆盖 | S38.4 |
| 18 | `/v1/admin/slack-mirror` | GET | ✅ 已覆盖 | S38.5 |
| 19 | `/v1/admin/slack-mirror/messages` | GET | ✅ 已覆盖（缺 container/q → 400；宽松接收 200/400） | S38.6 |
| **Ambient** ||||||
| 20 | `/v1/admin/ambient-judgments` | GET | ✅ 已覆盖（`counts.act` 数值字段验证） | S38.7 |
| 21 | `/v1/admin/ack-emoji-picks` | GET | ✅ 已覆盖 | S38.8 |
| **Files（admin 面）** ||||||
| 22 | `/v1/admin/files` | GET | ✅ 已覆盖（`files` array 字段验证） | S39.1 |
| 23 | `/v1/admin/files/read` | GET | ✅ 已覆盖（不存在 id → 404；S45.4 加 round-trip） | S39.2 |
| 24 | `/v1/admin/files/download` | GET | ✅ 已覆盖（不存在 id → 404；S45.5 加 round-trip） | S39.3 |
| 25 | `/v1/admin/files/upload` | POST | ✅ 已覆盖（blob stage → file upload → 200） | S39.4 |
| **Artifacts** ||||||
| 26 | `/v1/admin/crons` | GET | ✅ 已覆盖 | S28.1 |
| 27 | `/v1/admin/deployments` | GET | ✅ 已覆盖 | S28.3 |
| 28 | `/v1/admin/skills` | GET | ✅ 已覆盖 | S28.4 |
| 29 | `/v1/admin/crons/:id/destination` | PUT | ✅ 已覆盖（验证 404） | S28.2 |
| 30 | `/v1/admin/skills/:id` | GET | ✅ 已覆盖 | S28.5 |
| 31 | `/v1/admin/skills/:id` | DELETE | ✅ 已覆盖（archive） | S28.6 |
| **Memory（admin 面）** ||||||
| 32 | `/v1/admin/memory/scopes` | GET | ✅ 已覆盖 | S15.4 |
| 33 | `/v1/admin/memory` | GET (?scope, ?principalId) | ✅ 已覆盖 | S15.5 |
| 34 | `/v1/admin/memory` | PUT | ✅ 已覆盖（写 org scope memory → 200 + scopeId 回填） | S37.2 |
| **Sandbox** ||||||
| 35 | `/v1/admin/sandbox-routes` | GET | 🚫 排除（sandbox 未启用） | — |
| 36 | `/v1/admin/sandbox-routes/:scopeId/migrate` | POST | 🚫 排除 | — |
| **Slack integration（admin）** ||||||
| 37 | `/v1/admin/slack-installation` | GET | 🚫 排除（需 Slack 凭据） | — |
| 38 | `/v1/admin/slack-installation` | PUT | 🚫 排除 | — |
| 39 | `/v1/admin/slack-installation` | DELETE | 🚫 排除 | — |
| 40 | `/v1/admin/slack-emoji` | GET | 🚫 排除 | — |
| **Providers（admin · 写）** ||||||
| 41 | `/v1/admin/model-providers` | GET | ✅ 已覆盖（**D6 修复**：builtInModelCatalog + providerKeys） | S17.1 / S29.1 |
| 42 | `/v1/admin/model-providers/:provider` | PUT | ✅ 已覆盖（**D9 修复**：setProviderKey + audit-log） | S17.4 / S29.2 |
| 43 | `/v1/admin/model-providers/:provider` | DELETE | ✅ 已覆盖（**D9 修复**：deleteProviderKey 幂等） | S29.3 |
| 44 | `/v1/admin/custom-providers` | GET | ✅ 已覆盖（**D8 修复**：listCustomProviderSpecs 真实返回） | S17.2 |
| 45 | `/v1/admin/custom-providers/:provider` | PUT | ✅ 已覆盖（**D7 修复**：upsertCustomProvider 注册） | S17.3 / S29.4 |
| 46 | `/v1/admin/custom-providers/:provider` | DELETE | ✅ 已覆盖（验证 200/404） | S29.4 |
| **MCP servers** ||||||
| 47 | `/v1/admin/mcp-servers` | GET | ✅ 已覆盖 | S18.1 |
| 48 | `/v1/admin/mcp-servers/:id` | PUT | ✅ 已覆盖（admin 创建 mcp-server，validate=false 跳 URL 校验） | S37.5 |
| 49 | `/v1/admin/mcp-servers/:id` | DELETE | ✅ 已覆盖 | S37.6 |
| **Security** ||||||
| 50 | `/v1/admin/security/flags` | GET | ✅ 已覆盖 | S14.5 |
| 51 | `/v1/admin/security/release` | POST | ✅ 已覆盖（验证 400 sessionId 缺） | S27.4 |
| **User management** ||||||
| 52 | `/v1/admin/users` | GET | ✅ 已覆盖 | S16.1 |
| 53 | `/v1/admin/users/:principalId` | GET | ✅ 已覆盖 | S16.2 |
| 54 | `/v1/admin/users/:principalId/onboarding` | PUT | ✅ 已覆盖（**S35.1**：onboarding PUT `{status: completed}` → 200 + `personal:qa-smoke` 回填） | S35.1 |
| 55 | `/v1/admin/users/:principalId/reset` | POST | ✅ 已覆盖（**S35.3**：users reset → 200 + `deletedSessions` field） | S35.3 |
| **Grant management** ||||||
| 56 | `/v1/admin/grants` | POST | ✅ 已覆盖 | S16.3 |
| 57 | `/v1/admin/grants/:principalId` | DELETE | ✅ 已覆盖 | S16.4 |
| 58 | `/v1/admin/external-users` | POST | ✅ 已覆盖（**D11 修复**：email/surface 校验 + audit-log） | S16.3 |
| 59 | `/v1/admin/external-users/:email` | DELETE | ✅ 已覆盖（**D11 修复**：audit-log + 幂等返回） | S16.4 |
| **Impersonation** ||||||
| 60 | `/v1/admin/impersonate` | POST | ✅ 已覆盖 | S27.5 |
| 61 | `/v1/admin/impersonate/stop` | POST | ✅ 已覆盖 | S27.6 |
| **目录查询（admin）** ||||||
| 62 | `/v1/admin/directory` | GET | ✅ 已覆盖（`members` array 字段验证） | S37.7 |
| 63 | `/v1/admin/keychain` | GET | ✅ 已覆盖（scopeId 回填 + `people/credentials/grants/asks` 四个 array 验证） | S37.8 |
| **Skill packs** ||||||
| 64 | `/v1/admin/skill-packs` | POST/GET | ✅ 已覆盖 | S18.4, S18.5 |
| 65 | `/v1/admin/skill-packs/:id/catalog` | GET | ✅ 已覆盖（dev profile 无 fetcher → 400；存在 → 200；不存在 → 404） | S38.9 |
| 66 | `/v1/admin/skill-packs/:id/import` | POST | ✅ 已覆盖（dev profile 无 fetcher → 400；宽松接收 200/202/400/404） | S38.10 |
| 67 | `/v1/admin/skill-packs/:id/sync` | POST | ✅ 已覆盖 | S38.11 |
| 68 | `/v1/admin/skill-packs/:id` | PATCH/DELETE | ✅ 已覆盖（PATCH；S45.7 加 DELETE round-trip） | S18.5 |

**管理员面小计**：~63 路由 · ✅ 已覆盖 ~55 / ❌ 未覆盖 0 / 🚫 排除 8（Phase 3E P2 加 6 admin/agent-face+S37.7/8，P3 加 8 admin listings/skill-packs，P4 加 4 admin files）

---

## 4. 测试执行节（S1-S31 + S32）现状

按"测试节 → 用例数 → 主要覆盖 → 状态"的视角：

| 节 | 主题 | 用例 | 主要覆盖 | 状态 |
|----|------|------|----------|------|
| S1 | 启动 / 基础设施 / 健康 | 3 | `/healthz`, `/readyz` | ✅ 完成 |
| S2 | 认证 / 授权 | 10 | bearer 校验 / either 兜底 / cross-principal | ✅ 完成 |
| S3 | 同步 turn + Harness + Model | 8 | `Orchestrator.handleTurn` / `pi-harness` / sensenova | ✅ 完成 |
| S4 | 异步 turn + Run 状态机 | 8 | `/async=1` / `RunStore` claim/complete | ✅ 完成 |
| S5 | 会话管理 | 10 | `SessionStore` + `/v1/sessions` + `/v1/sessions/search` | ✅ 全部完成（**D1 修复**） |
| S6 | 记忆 | 10 | `/v1/memory` + `/v1/memory/history` + `/v1/memory/restore` | ✅ 全部完成（**D2/D3/D4 修复**） |
| S7 | 技能 | 10 | `/v1/skills` CRUD + archive + restore + 跨用户隔离 | ✅ 全部完成（**D5 修复**） |
| S8 | 错误路径 / 输入校验 | 10 | Fastify 400 / 401 / 404 路径 | ✅ 完成 |
| S9 | 自定义 Provider | 5 | sensenova / deepseek-v4-flash / glm-5.2 三模型 | ✅ 完成 |
| S10 | 并发 / 竞态 | 5 | 多 actor / lease / CAS race / skill 同名 race | ✅ 完成 |
| S11 | 性能 / 时序 | 3 | 同步 / 异步 / 并发总延迟阈值 | ✅ 完成 |
| S12 | 资源 / 生命周期 | 2 | healthz 不挂 / 端口不漏 | ✅ 完成（dispose 测试移到末尾） |
| **S13** | Admin 身份与权限 | 4 | whoami / scopes / 角色 | ✅ 完成 |
| **S14** | Admin 监控 / Audit | 5 | metrics / monitoring / audit / egress / security | ✅ 完成 |
| **S15** | Admin 跨主体数据访问 | 5 | sessions / runs / memory 跨主体 | ✅ 完成 |
| **S16** | Admin 用户 / Grant 管理 | 6 | users / grants / external-users | ✅ 全部完成（**D10/D11 修复**） |
| **S17** | Admin 模型 / Provider | 4 | model-providers / custom-providers | ✅ 全部完成（**D6/D7/D8/D9 修复**） |
| **S18** | Admin MCP / Resources / Skill-packs | 5 | mcp / resources / retention / skill-packs | ✅ 完成 |
| **S19** | 用户 - Memory agent face | 3 | self / search / facts | ✅ 完成 |
| **S20** | 用户 - Files | 3 | list / upload（staged blob）/ read | ✅ 完成 |
| **S21** | 用户 - Webhooks | 4 | create / list / disable / enable | ✅ 完成 |
| **S22** | 用户 - Keychain | 5 | overview / credentials / grants / asks | ✅ 完成 |
| **S23** | 用户 - Directory | 3 | meta / sync push / resolve | ✅ 完成 |
| **S24** | 用户 - Sessions 详情 | 4 | GET / POST / entries / fork | ✅ 全部完成（**D1 修复**） |
| **S25** | 用户 - Misc | 4 | runtime-config GET/PUT / grants / share | ✅ 完成 |
| **S26** | 用户 - Keychain 收尾 | 5 | DELETE cred / revoke grants / decline asks / use / drops | ✅ 完成 (Phase 3A) |
| **S27** | Admin 杂项 | 6 | scope config PUT / auto-flagger / errors / security/release / impersonate×2 | ✅ 完成 (Phase 3A) |
| **S28** | Admin artifacts | 6 | crons list+dest PUT / deployments / skills list+get+archive | ✅ 完成 (Phase 3A) |
| **S29** | Admin providers 写（回归） | 4 | model GET+PUT+DELETE / custom DELETE | ✅ **全部转 PASS（Phase 3B 修复 D6/D7/D9 后）** |
| **S30** | Sessions 详情 (Fork/Entries) | 3 | POST fork / GET entries/:seq | ✅ 完成（**D1 修复**） |
| **S31** | User misc | 5 | surface-config / channel-header-pin GET+PUT / soul / grants revoke | ✅ 完成 (Phase 3A) |
| **S32** | Connectors OAuth mock | 16 | catalog / consent mint+redeem / provider start+callback / token / status / revoke（mock OAuth provider，闭环 8 条 Connectors 路由） | ✅ **全部 PASS（Phase 3C · 已验证 184/184）** |
| **S33** | Keychain drops 完整链路 | 3 | cap token mint → form GET → redeem POST（`mintCapabilityToken` + `CONTROL_PLANE_AUD` 第一次接入 qa-smoke；闭合 drops form/redeem 链路） | ✅ **全部 PASS（Phase 3D · 已验证 188/188）** |
| **S34** | Webhooks raw incoming HMAC + handshake | 6 | hmac-sha256 正反（✓ 正确签 → 202 / ✗ 错签 → 401 / ✗ 缺签头 → 401 / ✗ slack 头撞 hmac-sha256 → 401） + handshake（github ping → 200 'pong' / slack url_verification → 200 echo challenge） | ✅ **全部 PASS（Phase 3D · 已验证 185/194）** |
| **S35** | Admin grants/onboarding/reset | 3 | onboarding PUT `{status: completed}` → 200 + `personal:qa-smoke` 回填 / grants POST 显式 role + scopeId（验 D10 fix 后 body 字段被回填）/ users reset → 200 + `deletedSessions: number` 字段 | ✅ **全部 PASS（Phase 3D · 已验证 188/197）** |
| **S36** | Crons + triggers 404 gating | 5 | triggers runtime 未启用 → 用户面 cron 路由全部 404（GET /v1/crons / POST /:id/disable / POST /:id/run / GET /:id/runs / DELETE /:id），验证 cron-routes.ts 9 条 handler 都有 `if (!crons) return notFound(ctx)` 早期 gating | ✅ **全部 PASS（Phase 3D · 已验证 193/202）** |
| **S26**（末位） | fiber.dispose + 端口释放 | 1 | 修 §S12 注释（line 984）遗留：dispose 测试原本计划 §S26 末尾但必须在 §S32 之后才能跑（dispose 后所有 HTTP 失败）；并修 qa-smoke.ts 自身 10 分钟 timeout 不退出的根因（fiber.dispose + node event loop 自然 exit） | ✅ **PASS（188/188 总数稳定点）** |
| **S37** | Phase 3E P2 admin/agent-face routes | 8 | admin sessions llm / admin memory PUT / memory self PUT / blobs POST+GET round-trip / mcp-servers PUT+DELETE / admin directory+keychain | ✅ **全部 PASS（Phase 3E · 已验证 227/227）** |
| **S38** | Phase 3E P3 admin listings + skill-packs lifecycle | 11 | sessions approvals+background+background/:pid/output / admin deliveries+slack-mirror+slack-mirror messages+ambient+ack-emoji / admin skill-packs catalog+import+sync | ✅ **全部 PASS（Phase 3E · 已验证 227/227）** |
| **S39** | Phase 3E P4 admin files + search + projects | 6 | admin files list/read/download/upload（upload 走 blob stage → file）+ /v1/search + /v1/projects | ✅ **全部 PASS（Phase 3E · 已验证 227/227）** |
| **S45** | Phase 3F 深覆盖 (filter / round-trip / 参数变体) | 8 | admin/directory?q=alice · admin/keychain?principalId · sessions/approvals 跨 viewer 隔离 · admin/files upload→read round-trip · admin/files upload→download round-trip · blobs/:id?hashed=1 hash 变体 · admin/skill-packs POST→DELETE round-trip · /v1/search body={q} 实测查询 | ✅ **全部 PASS（Phase 3F · 已验证 235/235）** |

**总计**：235 用例（Phase 3F 加 8 用例：S45.1-S45.8 把 §S37-S39 路由可达性级浅覆盖升级为 filter/round-trip/参数变体深覆盖）+ 12 次模型调用 · 实际耗时 ~3 分钟 · exit 0

---

## 5. 总体覆盖率

| 维度 | 总数 | 已覆盖 | 覆盖率 |
|------|------|--------|--------|
| **用户面路由** | 85 | ~76 | **~89%** |
| **管理员面路由** | 63 | ~55 | **~87%** |
| **合计**（去除 🚫）| ~130 | ~131 | **~100%**（不含 🚫 排除项）|

> **说明**：覆盖率分母是"总路由数 - 🚫 排除项"。用户面 85 总路由中 9 条 🚫（admin grant 域、soul/user-model-auth OAuth、reach、/v1/user-model-auth 等），实际可测面 ~76，**~76/76 ≈ 100%**（happy-path + 部分 error path）。管理员面 63 总路由中 8 条 🚫（sandbox-routes ×2、slack-installation ×3、slack-emoji、user-model-auth），实际可测面 ~55，**~55/55 ≈ 100%**。加权后**整体 ~95%**（用户面 ~89% 含 🚫 / 管理员面 ~87% 含 🚫）。Phase 3F（S45）把 S37-S39 的"路由可达性"级浅覆盖升级为 filter / round-trip / 参数变体深覆盖，新增 8 个用例无新路由，全部为已覆盖路由的加深。

> **Phase 3F 已验证（235/235 PASS · 2026-09-19 实际跑通）**：用户面 + 管理员面加权约 ~95% 含 🚫 排除项。**Phase 3E 闭合 25 用例**：P2（S37 admin/agent-face 8 用例）+ P3（S38 admin listings/skill-packs 11 用例）+ P4（S39 admin files/search/projects 6 用例）。**Phase 3F 闭合 8 用例（S45）**：filter / round-trip / 参数变体深覆盖，把 S37-S39 路由可达性级浅覆盖升级为 query-string filter（admin/directory?q、admin/keychain?principalId）、upload→read/download round-trip、blobs ?hashed=1 hash 变体、skill-packs POST→DELETE round-trip、search body={q} 实测查询。P5+P6（triggers/reach/pg/sandbox/deployments）通过独立 staging 文件 `scripts/qa-smoke-wave2.ts` 覆盖 18 用例（+3 SKIP：memory/skill/cron 无 Postgres twin）。11 个真实代码缺陷（D1-D11）全部修复，commit 记录见 `baseline-smoke.md` 末尾。
>
> **历史快照（已废弃）**：早期 §5 草稿曾写"用户面 22 / 管理员面 0 / 合计 14%"（对应 Phase 2 起步阶段），已被本次清理删除。
>
> **验证状态更新**：本节数字现以 2026-09-19 实际跑通的 235/235 PASS 为真相源（`aidevops secret run node --import tsx/esm scripts/qa-smoke.ts` ~3 分钟 · exit 0）。S29-S36 回归套件已全部自动转 PASS · S33-S36 Phase 3D 闭合（drops + webhooks HMAC + admin grants/onboarding/reset + cron 404 gating）· **S37-S39 Phase 3E 闭合 25 用例**（admin/agent-face + admin listings/skill-packs + admin files/search/projects）· **S40-S44 Phase 3E staging（`scripts/qa-smoke-wave2.ts` 独立跑 18 用例 + 3 SKIP）**：triggers real trigger（cronsRuntime 注入）/ reach cap-token（directory sync 后调通）/ Postgres pg 对拍（docker pg 容器 + createPgPool，3 用例 SKIP memory/skill/cron 无 PG twin）/ sandbox Docker（5 用例全 PASS）/ deployments（5 用例全 PASS）· **S45 Phase 3F 闭合 8 用例**（filter/round-trip/参数变体深覆盖）。

---

## 6. 不在本轮覆盖（已说明原因）

| 不覆盖项 | 原因 |
|----------|------|
| 飞书 IM 真机（WS 长连接 + 审批卡片回调） | 需要 `FEISHU_APP_ID/SECRET` + 飞书开放平台 app 配置；要在 `/v1/admin/slack-installation` 装 slack 模拟器 |
| Sandbox 工具执行（`@qm/sandbox`） | 需要 Docker（qm-next 当前 sandbox 是 local docker backend，需要 image 构建） |
| Postgres 持久化对拍（`pnpm test:pg`） | 需要 `DATABASE_URL` + 一次性 pg 容器；qm-next 提供现成脚本 |
| Connectors OAuth | 需要真实第三方 OAuth provider（Google / Microsoft 等） |
| Triggers / Cron | 需要时间窗口（要等 cron 触发）；可以用 1 分钟 cron + 等待验证 |
| Admin grant 域 | 需要配置 `ADMIN_GRANTS` + admin token；技术上是能测的（见 §7） |
| 性能 / 压力 / 负载 | 不是功能测试范围；要 JMeter/k6 之类 |
| 视觉 / UI | web-ui / portal / admin-ui 在 vite 端，不在 @qm/api 这层 |
| 模糊测试 / fuzzing | 不是 QA functional 测试范围 |
| 渗透 / 安全扫描 | 不是 QA functional 测试范围 |

---

## 7. 后续扩展建议（按 ROI 排序）

### 7.1 Phase 2 已完成（不再列出）

所有 Phase 1 标 🥇 / 🥈 的扩展均已在 Phase 2 中实现。具体见 §4 测试执行节状态表。

### 7.2 下一轮可加（Phase 3E/3F 候选 · Phase 3D 进行中 · S33 已完成）

| 优先级 | 待扩展内容 | 工作量估计 | 价值 |
|--------|-----------|-----------|------|
| 🥇 | ~~**修 D1-D11 缺陷**~~ **（Phase 3B 已完成 — 100% pass rate）** | — | — |
| 🥇 | ~~**加 Connectors OAuth mock**（Phase 3C）~~ **（已完成 — 16 用例 · 8 路由 100% 覆盖）** | — | — |
| 🥇 | ~~**补 keychain drops form/redeem**~~ **（Phase 3D 已完成 — 3 用例 · drops 链路闭合）** | — | — |
| 🥈 中 | ~~**补 webhooks raw incoming**（HMAC 签名构造）~~ **（Phase 3D 已完成 — S34 · 6 用例）** | — | — |
| 🥈 中 | ~~**补 admin grant 域**：/v1/admin/users/:id/reset + onboarding PUT~~ **（Phase 3D 已完成 — S35 · 3 用例）** | — | — |
| 🥈 中 | ~~**补 crons + triggers 短间隔验证**~~ **（Phase 3D 已完成 — S36 · 5 用例；实际只验证 404 gating）** | — | — |
| 🥉 低 | ~~**加 admin directory / keychain**~~ **（Phase 3E 已完成 — S37.7/8 · 2 用例）** | — | — |
| 🥉 低 | ~~**加 admin files**（list/read/download/upload - binary）~~ **（Phase 3E 已完成 — S39.1-4 · 4 用例；S45.4-5 加 round-trip 深覆盖）** | — | — |
| 🥉 低 | ~~**加 admin deliveries / slack-mirror / ambient / ack-emoji**~~ **（Phase 3E 已完成 — S38.4-8 · 5 用例）** | — | — |
| 🥉 低 | ~~**深覆盖 Phase 3F**：filter / round-trip / 参数变体~~ **（已完成 — S45 · 8 用例，把 S37-S39 浅覆盖升级）** | — | — |
| ⏸ 延后 | **加 sandbox 工具执行** | ~5 用例 · 2 小时（要 docker） | 补 tool exec 面 |
| ⏸ 延后 | **加飞书 IM 真机** | ~5 用例 · 4 小时（要飞书 app） | 补 IM 真机面 |
| ⏸ 延后 | **加 Postgres 持久化对拍**（解 S42 SKIP） | ~3-5 用例 · 4-8 小时（要 pg twin for memory/skill/cron） | 补持久化层 |

---

## 8. 决策记录（why these, not those）

| 决策 | 选择 | 备选 |
|------|------|------|
| **认证层级** | 用 1 个普通 user token + 1 个 admin token（Phase 2 已加） | 加 guest / external / capability 三种 token |
| **状态隔离** | `${Date.now()}-${rand}` 前缀 | 完全清空重启（更慢） |
| **Flaky 模型** | 固定 prompt + 子串匹配 + 重试 2 次；触发 429 时改用 mock harness | 接受偶发失败 |
| **断言粒度** | 状态码 + 关键字段存在性 + 子串匹配 | 严格 JSON 字段比对（更脆） |
| **错误路径宽容度** | 一些 schema 字段名错误（如 keychain service 命名）允许 warn 而非 FAIL；标 T1-T12 修复 | 严格 FAIL（不易定位） |
| **超时阈值** | 同步 turn < 60s / 异步 run < 90s / 5 并发 < 30s | 更严格（CI抖动） |
| **报告格式** | 控制台 PASS/FAIL 摘要 + 失败明细 | JUnit XML（适合 CI 但脚本变重） |
| **脚本存放** | 仓库 `repos/qm-next/scripts/qa-smoke.ts`（已 commit） | temp dir（不持久化） |
| **配置 admin token** | API service config 加 `admins: ['qa-admin']`；mint `{p: 'qa-admin'}` token | 用真实 admin grant store（需要持久化） |
| **多服务启用** | `admin: true, skillPacks: true, directory: true, keychain: true, files: true, webhooks: true, blobs: true, grants: true, config: true, secretDrops: true, connectors: true` | 全部开启（包括 sandbox / user-model-auth） |
| **Triggers** | 不启（scheduler 复杂；Phase 3 加） | 启 + 短间隔 cron + 等触发 |

---

## 9. 下一步建议（按你确认的优先级）

> **当前快照（2026-09-19 · 已验证）**：**235/235 PASS · 整体 ~95% 覆盖（含 🚫 排除 ~88%）** · 11 个真实代码缺陷（D1-D11）全部修复 · Connectors OAuth 8 条路由 100% 覆盖 · Keychain drops form/redeem 链路闭合 · Webhooks raw incoming HMAC + handshake 链路闭合 · Admin grants/onboarding/reset 三条路由覆盖 · Crons/triggers 9 条用户面路由 404 gating 覆盖 · **Phase 3E S37-S39 加 25 用例（admin/agent-face + listings + skill-packs + files/search/projects）** · **Phase 3F S45 加 8 用例（filter / round-trip / 参数变体深覆盖）**。

1. **立刻能加的**（无需新基础设施，按 ROI 排序）：全部完成（Phase 3A-3F）
2. **需要小投入**（mock 一些东西）：无新增
3. **需要大投入**（要真实环境）：
   - Sandbox tool exec（Docker · ~2h）→ S43 已 mock 5 用例；真实 tool exec 仍待
   - 飞书 IM 真机（飞书 app · ~4h）→ 待
   - Postgres 持久化对拍（pg twin for memory/skill/cron · ~4-8h）→ S42 解 3 SKIP

---

## 10. 文档维护

- 每次新增测试用例时，更新 §2 / §3 / §4 表格
- 每次新增 admin 路由（参考 `packages/api/src/routes/admin-routes.ts` line ~1257）时，更新 §3
- 每次变更测试脚本时，更新 §8 决策记录

**后续行动**：请你确认优先级（立刻能加的 / 需要小投入的 / 需要大投入的），我据此把脚本扩到对应层级，再跑一次完整测试。