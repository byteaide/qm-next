# qm-next operator CLI (qm-next-ops) — 测试覆盖

> **目的**：把"qm 27 场景"中 CLI / 部署类（场景 1/2/3/5/6/7）映射到 qm-next **真实存在**的
> operator 表面（`scripts/qm-next-ops.ts` + 既有的 `scripts/{check-im-isolation,rescope-check,
> local-sandbox-build}.sh`）。
>
> **生成时间**：2026-09-19 · **阶段 B 启动**（在 Phase 3G 27/27 + 5 SKIP 业务流基础上，加 6 个
> 场景覆盖）
> **关联文档**：
> - `user-stories-coverage.md`（27 场景业务流覆盖矩阵 · 阶段 A 已完成 · 业务流 25/27 ≈ 93%）
> - `baseline-smoke.md`（路由 + happy-path 真相源 · Phase 3G 283 用例 100% PASS）
> - `coverage-matrix.md`（路由覆盖矩阵）
> - `scripts/qm-next-ops.ts`（operator CLI 实现）
> - `scripts/qa-cli.ts`（本文件的执行；11 用例全 PASS）

---

## 0. 关键 finding：qm-next 没有 `qm` CLI

**qm-next 没有**继承上游 `qm` CLI 二进制。qm 上游的 `qm init / check / doctor / plan / up /
admin-login / outputs / rollback / sandbox build+publish` 9 个命令在 qm-next 里是这样分布的：

| qm 命令       | qm-next 实际表面                                              | 闭合状态 |
|---------------|--------------------------------------------------------------|----------|
| `qm init`     | 无对应代码（qm-next 用 cordis-boot 直接读 `profiles/*.yml`） | 🚫 N/A   |
| `qm check`    | `scripts/check-im-isolation.sh` + `scripts/rescope-check.sh` + **新增** `qm-next-ops check <profile>` | ✅ 闭合 |
| `qm doctor`   | `qm-next-ops doctor <profile>`（boot + /healthz 探活）        | ✅ 闭合 |
| `qm up`       | `qm-next-ops up <profile>`（`bootProfile` + /healthz）         | ✅ 闭合 |
| `qm admin-login` | `qm-next-ops admin-link <email>`（基于 `@qm/portal` 的 `seal()`/admin-login claim） | ✅ 闭合 |
| `qm plan` / `qm infra render` | **新增** `qm-next-ops plan <profile>`（dry-run，不真 boot） | ✅ 闭合 |
| `qm outputs`  | 无对应代码（qm-next 没有 structured-output 概念）             | 🚫 N/A   |
| `qm rollback` | **新增** `qm-next-ops rollback <profile> --to <sha>`（git checkout + 重启 + 验证，**无**真 AWS RDS snapshot） | 🟨 轻量 |
| `qm sandbox build+publish`  | 已有 `scripts/local-sandbox-build.sh`；**新增** `qm-next-ops fingerprint`（digest 抽取，无 docker / 无网络） | 🟨 轻量（docker build 那一步仍是脚本） |
| `qm check --live` (Fly/AWS) | 无对应代码（qm-next 不部署到云，只跑本地 + 出 binary） | 🚫 N/A |

**结论**：qm-next 是 **API + 编排层**，**不是**部署自动化平台。所以"CLI 场景 1/5/7"的真
云部分不在 qm-next 范围内；阶段 B 把"local 闭合的部分"测了，剩下标 🚫。

---

## 1. 测试约定

`scripts/qa-cli.ts` 用 `child_process.spawn` 把 `qm-next-ops` 当作 child process 跑，捕
获 stdout JSON envelope + 退出码。每次跑一个新 run tag，避免跨次污染。

每个 fixture 用 `Date.now()-rand` 命名，结束后清理（`rm -rf`）。

不依赖网络 / 模型 / 数据库。

---

## 2. CLI 场景 → 用例映射矩阵

| CLI 命令              | 上游场景        | 闭合状态 | 对应用例  | 验收点                                                                  |
|-----------------------|----------------|----------|----------|-------------------------------------------------------------------------|
| `qm-next-ops up`      | 1（qm up）       | ✅       | B1       | boot 成功；/healthz=200；mounted 包含 `api`；返回端口                          |
| `qm-next-ops check`   | 2（qm check）    | ✅       | B2 / B2.b / B2.c | 好 profile → exit 0 + entries 列表；坏 profile → exit 1 + 行号；duplicate id → exit 1 + "duplicate id" |
| `qm-next-ops plan`    | 3（qm plan）     | ✅       | B3       | exit 0；dryRun=true；wouldBoot 列出 entries + configKeys                   |
| `qm-next-ops doctor`  | 1（qm doctor）   | ✅       | B4       | boot 成功 + /healthz=200（exit 0 才通过）                                       |
| `qm-next-ops admin-link` | 4（admin-login）| ✅       | B5 / B5.b | seal 出含 `k='admin-login'`、`sub=<email>` 的 claim；坏 email → exit 1 + "usage" |
| `qm-next-ops rollback` | 6（qm rollback）| 🟨       | B6       | git checkout 旧版 + boot + /healthz=200 + 文件字节级还原 + .bak 清理         |
| `qm-next-ops fingerprint` | 7（sandbox build+publish）| 🟨 | B7 / B7.b | 从仓库内容派生 64-hex digest；不依赖 docker / 网络                          |
| `qm check --live`     | 5（Fly/AWS 部署）| 🚫       | —        | qm-next 不部署云；N/A                                                       |

**合计**：6 场景里闭合 6 个（其中 4 全 + 2 轻量 + 1 🚫），11 个 operator CLI 用例全 PASS。

---

## 3. 用例清单（在 `scripts/qa-cli.ts` 实现）

### §B1 `up` (1 用例 · 场景 1)
- ✅ B1.1 `up profiles/cordis.yml` → boot 成功 + /healthz=200 + mounted 包含 api

### §B2 `check` (3 用例 · 场景 2)
- ✅ B2.1 好 profile → exit 0 + entries 列表全有 id/name
- ✅ B2.2 坏 profile（list-item 第一个字段不是 id/name）→ exit 1 + line number
- ✅ B2.3 duplicate id → exit 1 + "duplicate id" 错误

### §B3 `plan` (1 用例 · 场景 3)
- ✅ B3.1 `plan profiles/cordis.yml` → dryRun=true + wouldBoot 列出 entries + configKeys

### §B4 `doctor` (1 用例 · 场景 1)
- ✅ B4.1 `doctor profiles/cordis.yml` → /healthz=200 才会 exit 0

### §B5 `admin-link` (2 用例 · 场景 4)
- ✅ B5.1 `admin-link ada@example.test` → seal 出合法 claim + 完整 link
- ✅ B5.2 `admin-link not-an-email` → exit 1 + "usage"

### §B6 `rollback` (1 用例 · 场景 6)
- ✅ B6.1 `rollback profiles/cordis.yml --to <prev-sha>` → boot 旧版成功 + /healthz=200 + 文件字节级还原 + .bak 清理

### §B7 `fingerprint` (2 用例 · 场景 7)
- ✅ B7.1 `fingerprint` → 64-hex digest（来自 `computeSandboxImageFingerprint`）
- ✅ B7.2 docker 可用性探测（不强制 — `qm sandbox build+publish` 第二步是 docker push，本机 docker 状态不阻塞）

### §B 合计
- **新增用例**：11 个
- **SKIP**：0 个
- **闭合场景**：6 个（场景 1/2/3/4/6/7）+ 🚫（场景 5）

---

## 4. 度量（阶段 B 末 vs 阶段 A 末）

| 度量                                          | 阶段 A 末（Phase 3G）  | 阶段 B 末（Phase 3H）       |
|-----------------------------------------------|------------------------|-----------------------------|
| CLI 类场景覆盖（1/2/3/4/5/6/7）              | 0/7                    | 6/7 (1/2/3/4/6/7 ✅ + 5 🚫) |
| 总业务流覆盖（27 场景）                        | 25/27 ≈ 93%            | 26/27 ≈ 96% (新闭合 6/4/3/1) |
| 用例总数（qa-smoke + wave2 + user-stories + cli） | 235 + 21 + 27 + 0 = 283 | 235 + 21 + 27 + 11 = 294    |
| CLI 命令数                                    | 0                       | 7（up/check/doctor/plan/admin-link/rollback/fingerprint）|
| pass rate（业务流层 + CLI 层）                 | 100%                    | 100%                         |
| CI 全跑时长（预估）                            | ~5min                  | ~6min                         |

---

## 5. 设计要点

| 决策 | 选择 | 理由 |
|------|------|------|
| **CLI 风格** | 单二进制 + 子命令（`qm-next-ops <verb> [args]`）| 对齐上游 `qm` 表面；现有 `scripts/*.sh` 各自为战不易统一 |
| **输出格式** | JSON envelope `{ok, command, data?, reason?}` | 机器可读；错误情况有结构化 reason；`--quiet` 留给未来 |
| **exit code** | 0 ok / 1 failed / 2 usage / 3 not-implemented | bash / CI 友好；与 qm 上游约定近似 |
| **YAML 解析** | 自写 tiny parser（结构仅 `id`/`name`/`config:`） | 不引入 js-yaml 依赖（root 没装，pnpm 只在 vendor 子树）；profile 文件结构均匀，不需要 js-yaml 全功能 |
| **profile 校验** | 浅校验（id 存在、name 存在、id 唯一）| 深度校验交给 `bootProfile`；避免在 CLI 里重建整套 schema |
| **rollback 语义** | 非破坏性（boot 旧版 → 验证 → 还原当前版）| 测试 + 预演用途；真部署场景仍走 `git revert` + `qm up` |
| **fingerprint 不真 build** | 只调 `computeSandboxImageFingerprint`；docker build 留给 `local-sandbox-build.sh` | CI 无 docker 时不阻塞；qa-cli.ts 跑通率 100% |
| **admin-link 默认 secret** | `dev-m1-secret`（跟 portal SSO 一致）| 测试场景不需要换 secret；`--secret` 留给生产 |
| **profile 路径** | 既支持相对（cwd）也支持绝对路径 | `--dir` 默认 cwd；`--to <sha>` 时必须从 cwd 找 `.git` |

---

## 6. 决策记录

| 决策 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 闭合哪个 CLI 场景 | 6/7（场景 1/2/3/4/6/7）| 0/7（全部 🚫）| qm-next 真的有 boot + profile + admin-link + sandbox 表面，封装一下就能测 |
| 场景 5 怎么处理 | 🚫 + 文档说明 | 测 boot-on-cloud 假动作 | 装假动作会误导：qm-next 没有 cloud deploy 代码 |
| CLI 命名 | `qm-next-ops` | `qm`（与上游冲突）| 不要污染 PATH；明确归属 qm-next |
| 测试脚本 | `qa-cli.ts`（独立，spawn child process） | `qa-smoke.ts` 加用例 | qa-smoke 是 API 层；qa-cli 是 process 边界层；alert 渠道分开 |
| 跑时依赖 | node + tsx/esm + bash + git | 加 docker | docker 是 fingerprint 子步骤的依赖，**不**在 qa-cli 强制 |
| fixture 清理 | 每个 run tag 一目录 + 跑完 `rm -rf` | 写进 repo | fixture 是临时性质；gitignored / 跑完删 |

---

## 7. 不在阶段 B 范围（明确排除）

| 排除项 | 原因 |
|--------|------|
| `qm init` (新部署目录脚手架) | qm-next 用 cordis-boot，profile 文件手写即可 |
| `qm outputs` (结构化输出捕获) | qm-next 没有 outputs 概念；纯 API 模型 |
| `qm check --live` Fly/AWS | qm-next 不部署云 |
| `qm rollback` 的 AWS RDS snapshot | qm-next 不操作云 RDS |
| `qm sandbox build+publish` 的真 docker push | docker push 由发布流程做（CI/CD step），不进 qa-cli |

---

## 8. 关联文件

| 文件 | 角色 |
|------|------|
| `scripts/qm-next-ops.ts` | operator CLI 实现（up/check/doctor/plan/admin-link/rollback/fingerprint） |
| `scripts/qa-cli.ts` | 11 个测试用例（spawm CLI → assert exit + JSON） |
| `scripts/check-im-isolation.sh` | 既有的核心层 IM-platform-symbol 门禁；qa-cli 不直接调用，留给 CI |
| `scripts/rescope-check.sh` | 既有的 vendor `@deepseek-ai` 检查；qa-cli 不直接调用 |
| `scripts/local-sandbox-build.sh` | 既有的 sandbox image build 脚本；fingerprint 抽 digest 后，operator 可选调用 |
| `packages/boot/src/index.ts` | `bootProfile()`（CLI 的 boot 实现） |
| `packages/portal/src/admin-login.ts` | `openAdminLogin`（CLI 的 claim 校验，qa-cli 不直接用 — 只 decode base64） |
| `packages/portal/src/session.ts` | `seal` / `deriveKey` / `randomToken`（CLI 的 admin-link 实现） |
| `packages/sandbox/src/local-sandbox.ts` | `computeSandboxImageFingerprint`（CLI 的 fingerprint 实现） |

---

## 9. 阶段 B 末立刻要做的最小行动

1. ✅ 已完成：本文档 + `scripts/qm-next-ops.ts` + `scripts/qa-cli.ts`
2. ✅ 闭合场景 1/2/3/4/6/7（11 用例 100% PASS）
3. 🔜 阶段 C：跑真飞书 + 真 sandbox + 真 cron 自动触发，把 SKIP 用例闭合（user-stories §U18.2 / §U24.2 / §U25.2 / §U26.1-2）
4. 🔜 在 `baseline-smoke.md` §4 阶段演进表加 Phase 3H row