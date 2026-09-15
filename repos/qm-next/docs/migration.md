# qm → qm-next 数据迁移（p002 P5 19.0）

**PRD:** [todo/tasks/prd-qm-parity.md](../../../todo/tasks/prd-qm-parity.md)
**Tasks:** 19.1 schema diff（本文件 Part A）→ 19.2 迁移器（Part B）→ 19.3 演练 + runbook（Part C）
**Status:** 19.1 报告完成（2026-09-15）；19.2 迁移器完成（`scripts/migrate-qm.ts`，`pnpm migrate:qm`）；19.3 演练 PASS 44/44（`pnpm rehearsal:migrate`）+ runbook 完成；**20.0 PG-twin 接线完成（2026-09-15）**——组合根 `databaseUrl` 下全量落地 twin schema（A.2 前置清单已勾除），deliveries 改 drain-check、file_artifacts 直拷进 ENTITY_COPIES（见 A.2/C.3 更新）

---

## Part A. Schema Diff 报告（19.1）

### A.0 方法与快照

- 抽取方式：模板字面量扫描两侧 `*.ts`（排除 `*.test.ts`），捕获 `CREATE TABLE/INDEX`、`ALTER TABLE ADD COLUMN` 与动态 DurableMap 建表；DurableMap 表名从装配点（qm `src/wiring.ts` 的 `artifactMap("…")`、qm-next 各 store 构造/组合根）反查。
- qm 侧：165 条语句（26 个文件内联 DDL → 41 张实体表 + 4 张 sink 动态表 + `cron_fire_log`）+ 58 张 DurableMap JSONB 表。
- qm-next 侧：80 条语句（18 个文件 → 33 张实体表）+ DurableMap 表（`memory_scratch_logs`/`skill_bundles`/`skill_packs`/`ambient_cursors`/`admin_slack_installation`/`monitors`）+ 同族 sink 动态表。
- 快照基点：qm = canonical 只读镜像；qm-next = `feature/p5-web-depth` @ `961e8e7`。
- 迁移语义基准：**qm 是唯一事实源**（生产库），qm-next 是目标库；「兼容」= 迁移后 qm-next 消费语义等价，不要求列布局一致。

### A.1 分类词汇

| 标记 | 含义 | 迁移策略 |
|------|------|----------|
| `copy` | 两端末态 DDL 逐列一致 | `INSERT … SELECT` 直拷（显式列名） |
| `transform` | 实体表 reshape | 列映射在 Part B 逐表给出 |
| `blob-copy` | 两端同为 DurableMap 表（`id TEXT PK, json JSONB`）且表名一致 | 行级直拷，记录形状由迁移器断言 |
| `blob→cols` | qm DurableMap JSON → qm-next 实体表 | JSON 字段→列映射在 Part B |
| `export-seed` | 管理面配置类 | 迁移器导出 JSON 种子文件，切换后经 admin API 重播种 |
| `not-carried` | 有意不迁移 | 理由逐项给出 |
| `blocked-twin` | qm-next 目标 store 当前组合根只有 memory 实现 | 20.1 需先落 PG twin/接线，才能承载数据 |

### A.2 目标库承载现状（20.1 前置清单 → 20.0 已收口）

> **20.0 更新（2026-09-15）**：组合根（`packages/api/src/service.ts`）durable-by-default sweep 完成——`databaseUrl` 下 sessions/runs/directory/crons/approvals/keychain 族/model/credentials/mcp/connectors/webhooks/channel_policy/files/tasks/acl/run 观测/replay 全部选 PG twin，DurableMap 表 boot 时暖建；下表保留为决策记录。

| 域 | 19.0 现状 | 20.0 结果 |
|----|------|-----------|
| directory | `packages/directory` 已有 PG store，组合根选了 memory | ✅ 组合根按 `databaseUrl` 选 PG twin |
| crons/approvals | PG store 已导出，plugin service 默认 memory | ✅ triggers/im-bridge 按 `databaseUrl` 选 PG（含 scheduler PG leader lease） |
| keychain（creds/grants/asks/secret_drops/credential_liveness） | store 接受注入 DurableMap，组合根传 `createMemoryMap()` | ✅ creds/grants/asks 接 `createPostgresMap`（qm 同名表）；secret_drops/credential_liveness 无组合消费点，随 export-seed |
| deliveries | 仅 memory 队列（`createMemoryDeliveryQueue`） | ✅ `createPostgresDeliveryQueue`（im-core）落地，bridge 按 `databaseUrl` 注入；数据不迁——切换 runbook 先 drain（`DRAINED` drain-check） |
| surface-cache（channel_messages/state/files）+ channel_policy(+history) | memory | ✅ channel_policy(+history) 落 PG（qm 同列 DDL，copy）；cache 类 not-carried 维持 |
| webhooks/files(blobs+file_artifacts)/environments/projects/runtime-config/deployments/deployment-layer/context-queue | memory | ✅ webhooks 落 PG（`webhooks` 表；数据 export-seed，形状不同）；files 落 PG（`file_artifacts` qm 同列 DDL copy + `filesDir` 字节搬运）；其余 export-seed（拍板记录 operations.md §8） |
| ratelimit（budget_spend/rate_limit_windows） | 未移植 | 窗口计数自过期，not-carried（维持） |

### A.3 逐域 diff

#### 1) sessions/runs（核心回路，`@qm/store` schema）

| qm 表 | qm-next 表 | 分类 | 要点 |
|--------|------------|------|------|
| `sessions` | `sessions` | `transform` | 见 S-1 |
| `session_entries` | `session_entries` | `copy` | 列一致；qm 多 `search_tsv` 生成列 + GIN（见 S-2） |
| `participants` | `participants` | `transform` | 见 S-1 |
| `session_leases` | `session_leases` | `copy` | qm 经 ALTER 补 `holder/acquired_at`，末态一致；迁移时清空（lease 不跨切换） |
| `session_tape` | `session_tape` | `transform` | 见 S-3 |
| `session_llm_requests` + `llm_prompt_envelopes` | `llm_requests` | `transform` | 见 S-4 |
| `runs` | `runs` | `copy` | qm 末态（ALTER 后）= qm-next 内联 DDL；`seq BIGSERIAL` 值需显式保留 |
| `tool_calls` | —（无表无消费者） | `not-carried` | qm-next v1 无读取方；记录偏差即可 |
| `run_activity` | `run_activity` | `copy` | 一致 |
| `run_signals` | `run_signals` | `copy` | 一致（qm `payload` 经 ALTER，末态一致） |
| `instance_heartbeats` | `instance_heartbeats` | `copy` | 一致；迁移时清空（实例注册表重启自愈） |

**S-1 sessions/participants 列级**

- qm `sessions` 独有：`messages INT`、`turns INT`、`forked_from_session_id`、`forked_from_title`、`fork_boundary_seq` → qm-next 无列。
  - `messages/turns` 是可重导出的展示计数 → `not-carried`（web-ui 首屏后重算或显示为空）。
  - fork 三列：qm-next v1 无 fork UI 消费 → `not-carried`（记 parity 偏差）。
- qm-next `sessions` 独有：`archived/pinned/color`（qm 把这三个放在 `participants` 上，per-participant 视图状态）。
  - 迁移：从 owner participant（`valid_to IS NULL` 中最早 `valid_from`，无则任一）取 `title/archived/pinned/color` 折叠到 session 行；`title` 优先 qm `sessions.title`，空则取 participant `title`。
- qm `participants.title/archived/pinned/color` 不迁移（目标表无列）。

**S-2 搜索**

qm `session_entries.search_tsv`（`to_tsvector('simple', …)` GENERATED + GIN，`entry_search_text(payload)`）；qm-next `searchEntries` 用 `LOWER(payload) LIKE %q%`（`packages/store/src/postgres-session-store.ts:431`）。迁移不带列；**搜索语义偏差**（词法匹配 → 子串匹配）记 parity 偏差，20.1 可选补 GIN 列。

**S-3 session_tape 列映射**

qm 平铺列 → qm-next `meta` JSON（锚点：`@qm/types TapeMeta`，session-store.ts:28）：

| qm 列 | qm-next |
|--------|---------|
| `bare_text` | `meta->>'bareText'` |
| `ts` / `change_time` | `meta->>'ts'` / `meta->>'changeTime'` |
| `hidden` / `overheard` | `meta->'hidden'` / `meta->'overheard'`（boolean） |
| `author` | `meta->>'author'` |
| `payload TEXT NOT NULL` | `payload TEXT`（可空；迁移保留原文） |

公共列（session_id/seq/kind/scope_label/harness/entry_seq/covers_entry_seq/created_at）直拷。

**S-4 LLM 请求记录**

- `session_llm_requests` → `llm_requests`（改名）：公共列 id/session_id/turn_seq/step/model/scope_label/created_at 直拷；`request` 允许 NULL（qm 早期行 NOT NULL，兼容）。
- `ttft_ms/duration_ms/step_gap_ms`：`INT → BIGINT`，直拷。
- 尾缀剥名：`tool_wall_json→tool_wall_ms`、`usage_json→usage`、`transport_json→transport`、`gap_phases_json→gap_phases`（内容同为 JSON 文本）。
- `llm_prompt_envelopes(hash PK)` → `prompt_envelope` 列：`LEFT JOIN … ON prompt_hash` 折叠进行；`prompt_hash` 保留。
- `llm_prompt_envelopes` 表本身 `not-carried`（去重信封库，目标为内联列）。

#### 2) directory（Slack 形状 → provider 中性）

| qm 表 | qm-next 表 | 分类 | 映射 |
|--------|------------|------|------|
| `directory_members` | `directory_people` | `transform` | `(org_id, principal_id, display_name, display_name_lc, type, slack_id)` → `(provider=$SRC, provider_user_id=principal_id, display_name, email=NULL, type, timezone=NULL)`；`display_name_lc/org_id/slack_id` 不带（qm-next 查询侧处理小写） |
| `directory_channels` | `directory_spaces` | `transform` | → `(provider=$SRC, space_id=channel_id, name, kind='channel', is_private, is_external)`；`name_lc/roster_known` 不带，`roster_known=TRUE` 时写 `directory_rosters` |
| `directory_channel_members` | `directory_space_members` | `transform` | `(org_id, channel_id, principal_id)` → `(provider=$SRC, space_id, provider_user_id)` |
| `directory_groups` + `directory_group_members` | `directory_spaces(kind='group')` + `directory_space_members` | `transform` | group 提升为 space；`roster_known` 同上 |
| `directory_sync` | `directory_sync_state` | `transform` | hash/synced 列 → `(provider=$SRC, section, synced_at)` 行集：`members/channels/groups/channel_members` 四 section，`synced_at` 取各列（NULL→0 表示未同步） |
| `directory_meta` | — | `not-carried` | `workspace_url` 展示信息，v1 无消费 |

`$SRC` 为迁移器参数 `--source-provider`（默认 `slack`）。qm 单 `org_id` 维度在 qm-next 由 provider 键承担（多 org 不在 v1 范围）。

#### 3) memory

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| `memory_revisions` | `memory_revisions` | `copy` | DDL 一致 |
| `WorkspaceStore`（FS，`createLocalWorkspaceStore`） | `memory_scratch_logs`（DurableMap） | `not-carried` | scratch 为工作记忆，切换后从 revisions 重放即可；如需保留由迁移器 `--with-scratch` 做 文件→行 |

#### 4) skills

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| DurableMap `skills` | `skills` 实体表 | `blob→cols` | qm Skill json 字段与列同名直映（`required_capabilities/granted_capabilities/approvals/files/pack` 为 JSONB；`status/version/last_used_at/signature` 有缺省）；形状断言在迁移器 |
| DurableMap `skill_bundles` | DurableMap `skill_bundles` | `blob-copy` | 同名同形状 |
| DurableMap `skill_packs` | DurableMap `skill_packs` | `blob-copy` | 同名同形状 |

#### 5) approvals

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| DurableMap `approvals`（PendingApprovalRecord 含 TurnRequest） | `approvals` 实体表（run 中心形状，无 request 载荷列） | `not-carried`（drain） | qm 靠存 TurnRequest 重放，qm-next 靠 run resume——形状不可翻译；待审记录是瞬态，切换前 approve/deny 清零（迁移器强制校验并告警） |
| DurableMap `approval_grants` / `approval_grant_modes` / `approved_harness_configs` | runtime-config 族（memory） | `blocked-twin`→`export-seed` | 见 A.2；迁移器导出 JSON 种子 |
| DurableMap `keychain_asks` | keychain 注入 map | `blocked-twin`→`blob-copy` | 20.1 接线后同名表直拷（短 TTL，通常可弃） |

#### 6) cron / triggers

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| DurableMap `crons`（Cron json，`fireLog` 内嵌） | `crons` 实体表 | `blob→cols` | 字段同名直映（`schedule` 对象→JSONB、`destination`→TEXT canonical JSON、`recipient_consent`→JSONB）；内嵌 `fireLog` 不带（qm-next 只读 `cron_fire_log`） |
| `cron_fire_log`（PG，默认名一致） | `cron_fire_log` | `copy` | 行形状一致 `(cron_id, fire_key, fired_at, json)`；FK 指向 `crons(id)`，迁移顺序 crons → fire_log |

#### 7) delivery

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| `deliveries` | `deliveries`（`createPostgresDeliveryQueue`，20.0 落地） | `drain-check`（原 `blocked-twin`） | qm 行形状（destination/text）不翻译为 qm-next 操作队列；切换前强制 drain（迁移器 >0 行告警），无行携带 |

#### 8) audit / metrics（观测面）

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| `audit_log` | `audit_log` | `copy` | 一致（qm `idempotency_key` 经 ALTER，末态一致） |
| `turn_metrics` | `turn_metrics` | `copy` | 动态列族两侧同构（12.0 忠实平移）；迁移带基列+动态列并集 |
| `error_events` / `credential_usage` / `egress_events` | 同名 | `copy` | scoped-event-sink 同族，表名/形状一致 |
| DurableMap `ambient_cursors` | DurableMap `ambient_cursors` | `blob-copy` | 同名 |
| `ambient_judgments` | `ambient_judgments` | `copy` | 一致（qm `asked_by` 经 ALTER） |
| `ack_emoji_picks` | `ack_emoji_picks` | `copy` | 一致 |
| `channel_policy` / `channel_policy_history` | `channel_policy(+_history)`（20.0 落 PG，qm 同列 DDL） | `copy` | 管理面配置已可直拷；org 维度用迁移器 `--org-fallback` 对齐 |
| `channel_messages` / `channel_state` / `channel_files` | memory | `not-carried` | provider 侧缓存，重同步可重建（ambient judge 从游标续跑） |
| DurableMap `ack_emoji` | — | `not-carried` | qm 兼容旧字段；qmn 有 `ack_emoji_picks` 实体表 |

#### 9) 凭据 / 模型

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| DurableMap `keychain_credentials` / `keychain_grants` / `secret_drops` / `credential_liveness` | keychain 注入 map | `blocked-twin`→`blob-copy` | 20.1 接线 PG map（沿用 qm 表名）后直拷；记录形状 P1 忠实平移 |
| DurableMap `model_credentials` / `custom_model_providers` | model store 注入 map | `blocked-twin`→`blob-copy` | 同上（P1 2.3/2.5 平移） |
| DurableMap `device_flow_cutover` / `device_flow_cutover_resets` | credentials 注入 map | `blocked-twin`→`blob-copy` | 同上 |
| DurableMap `slack_installation` | DurableMap `admin_slack_installation` | `blob-copy`（改名） | 记录形状核对后在迁移器做表名映射 |

#### 10) 其余（长尾/平台）

| qm | qm-next | 分类 | 要点 |
|----|---------|------|------|
| `acl_grants` / `acl_grants_version` | 同名 | `copy` | 一致 |
| `admin_grants` | `admin_grants` | `copy` | 一致 |
| `source_auth_replay` | `source_auth_replay` | `copy` | 短 TTL；可选 |
| `tasks` / `task_events` | 同名 | `copy` | 一致 |
| `process_sessions` | `process_sessions` | `copy` | 一致 |
| `environments` / `environment_attachments` | memory | `blocked-twin`→`export-seed` | 量小，重播种 |
| `file_artifacts` | `file_artifacts`（20.0 落 PG，qm 同列 DDL + `filesDir` 字节存储） | `copy` | 已入迁移器 ENTITY_COPIES 直拷；blob 字节按 `files/<sha256>` 目录搬运后还原 |
| `budget_spend` / `rate_limit_windows` | 未移植 | `not-carried` | 窗口计数自过期 |
| `instance_heartbeats` | 同名 | `copy`（清空） | 见域 1 |
| DurableMap `webhooks` | `webhooks`（20.0 落 PG DurableMap；记录形状与 qm 不同） | `export-seed` | 表已可承载，但形状不同不做行级拷贝；条目少，切换后经 admin API 重播种 |
| DurableMap `monitors` | DurableMap `monitors` | `blob-copy` | 同名同形状 |
| DurableMap `mcp_servers` | mcp-server-store 注入 map | `blocked-twin`→`blob-copy` | 20.1 接线同名表 |
| DurableMap `connector_status` / `connector_clients` / `oauth_flows` / `consent_links` / `browser_sessions` | connectors 注入 map | `blocked-twin`→`blob-copy` | 20.1 接线；短 TTL 类可弃 |
| DurableMap `idempotency` | —（仅 `runs.idempotency_key`） | `not-carried` | 短 TTL 去重；run 级幂等已随 `runs` 迁移 |
| DurableMap `context_requests` | memory 队列 | `not-carried` | 在飞队列，切换前 drain |
| DurableMap `insight_cursors` | notifier 注入 map | `blob-copy`（缺省重置为 now） | 低价值，可重置 |
| DurableMap `deactivated_principals` / `external_members` | —（无 identity 服务） | `blocked-twin` | 20.1 拍板：补 identity 面或 v1 不带停用名单 |
| DurableMap `deployments` / `deploy_git_repos` / `aws_deploy_bodies` / `aws_sandbox_bodies` / `porter_deploy_bodies` / `deployment_layer` / `sandbox_routing` | memory deploy 族 | `export-seed` | deploy 目标配置重播种；历史部署记录不迁移 |
| DurableMap `web_ui_state` / `soul_configs` / `soul_history` / `branding_configs` / `security_postures` / `*_flag` / `*_configs`（runtime-config 族） | memory runtime-config | `export-seed` | 管理面配置，切换后经 admin API/console 重播种 |
| DurableMap `projects` / `people_directory_urls` | memory | `export-seed` | 同上 |
| `durable_map_versions` | `durable_map_versions` | `copy`（blob 表子集） | 只迁 blob-copy 类表的版本行 |

### A.4 汇总

| 分类 | 表数（实体+blob） |
|------|------------------|
| `copy` | 20 |
| `transform` | 9 |
| `blob-copy`（含改名 1 张） | 8 |
| `blob→cols` | 2（crons、skills） |
| `blocked-twin`（含其 export-seed 变体） | 24 |
| `not-carried` | 13（含 approvals drain） |

结论：核心回路（sessions/runs/memory/audit/metrics/tasks/acl/cron 火日志）与 qm-next 端 DDL 末态一致或映射明确，可机械迁移；**真正的工作量在两处**——(1) 5 张 `blob→cols`/`transform` 大表（sessions折叠、tape meta、llm 信封折叠、directory reshape、crons/skills/approvals blob 拆列），(2) `blocked-twin` 清单就是 20.1 的 PG 接线 backlog，迁移器按 A.2 顺序实现，twin 就位一个接一个。

---

## Part B. 迁移器 + 校验 + 回滚（19.2）

实现：`scripts/migrate-qm.ts`（pnpm script `migrate:qm`），tsx 运行，只依赖 `@qm/store` 的 pg-pool。

### B.0 CLI 形状

```
node --import tsx/esm scripts/migrate-qm.ts \
  --source $QM_PG_URL --target $NEXT_PG_URL \
  [--source-provider slack] [--commit] [--verify-only] [--rollback] \
  [--tables sessions,crons,...] [--export-seed docs/migration-seed.json] \
  [--batch 200] [--org-fallback org:default] [--force]
```

- 默认 **dry run**：全部写入发生在目标库单个事务里，结束时 ROLLBACK 并打印迁移报告表。
- `--commit`：COMMIT，并把每步写入 `qm_migration_journal(run_id, step, table_name, mode, src, dst, at)`。
- `--rollback`：读 journal 最近一次 run，按逆序 DELETE 各表，清 journal（回滚演练实证可回到全空）。
- `--verify-only`：只报目标库各表行数与缺失表清单（PG-twin gap 盘点）。
- `--tables`：子集迁移（按域关键词 sessions/directory/crons/skills 过滤 transform，按表名过滤 copy/blob）。
- `--export-seed`：把 config 族 DurableMap/实体表导出为 JSON 种子（切换后经 admin API 重播种）。

### B.1 写入与校验

- 目标 schema 不由迁移器创建：**先以 qm-next 构造/启动目标库**（durable-by-default：schema 属于各 store）。迁移器 preflight 校验目标表存在性；缺失表 → 记 note 跳过（PG-twin gap），不猜测 DDL（无漂移）。
- `copy` 类：列集 = 源/目标 `information_schema` 运行时交集（兼容 qm 的 ALTER 演进末态），批量参数化 `INSERT … ON CONFLICT DO NOTHING`（幂等重跑）。
- `transform` 类：拉取源行 → JS 内变换（形状断言内建）→ 批量写入；`sessions` 折叠 owner-participant 视图态、`session_tape` 平铺列→`TapeMeta` JSON、`llm_requests` 信封折叠、directory reshape（`--source-provider`，默认 slack）、`crons`/`skills` blob→列。
- 行数校验：每步记录 src/dst；完成后对每个目标表重计数并与期望比对，不一致 → 报 MISMATCH 并以非零退出（事务回滚）。设计内跳过（残缺 blob、ON CONFLICT 冲突行）在报告中标注。
- 短时/瞬态数据处理：`session_leases`、`instance_heartbeats` 清空不迁；qm 待审 approvals > 0 时强制告警（切换前必须 drain）。

### B.2 回滚路径

| 阶段 | 手段 |
|------|------|
| commit 前 | dry run 默认即全量回滚；`--commit` 之外的任何失败（含行数 MISMATCH）自动 ROLLBACK |
| commit 后 | `--rollback` 按 journal 逆序 DELETE 全部迁移表（runbook 先停写再执行），journal 行一并清除 |
| 双跑期 | qm 保留只读可随时重迁；目标库可反复 `--rollback` + 重跑 `--commit`，直到验收通过 |

---

## Part C. 演练 runbook（19.3）

### C.1 演练（一键，docker）

```
cd repos/qm-next && pnpm rehearsal:migrate
```

一次性 PG16 容器（`scripts/run-migration-rehearsal.sh`）起 `qm`（源）与 `qmnext`（目标）两库 → 演练驱动（`scripts/migration-rehearsal.ts`）：

1. 用 schema owner 自身的语句数组（store/triggers/approvals/directory/skills/memory 的 SCHEMA_STATEMENTS）+ `createPostgresMap` 暖建 blob 目标表，建出目标 schema；
2. 播种 qm 形状源数据集（覆盖全部迁移类别，含残缺 skill、待审 approval、内嵌 fireLog、owner 视图态、信封引用）；
3. 迁移器 dry run（回滚）→ `--commit` → 逐表行数断言 + 9 项语义抽查（折叠/meta/信封/reshape/列落地）→ `--rollback` → 目标库清空断言。

2026-09-15 演练结果：**PASS，44/44 检查全绿**（13 copy/transform 目标表 + 6 blob 表计数、9 项语义抽查、journal 单 run、回滚后目标库全空）。构造器专属 schema（tasks/acl/admin sinks/runs activity-signals/instance registry）在演练中按设计缺席，触发了 PG-twin gap note 路径——这就是 20.1 的接线清单实证。

### C.2 生产切换 runbook

> 前置清单（20.0 已完成，2026-09-15）：☑ deliveries PG twin（drain-check 语义） ☑ keychain/model/mcp/connector 族组合根接 PG map ☑ directory/crons/approvals 组合根按 `databaseUrl` 选 PG twin ☑ runtime-config 族确认 export-seed 路径 ☑ webhooks/files 落 PG

1. **冻结源**：qm 停写（维护页/API 只读），drain 队列（deliveries、context_requests）；处理全部 pending approvals（迁移器此时校验为 0）。
2. **备份**：`pg_dump` qm 生产库（回滚底线）。
3. **建目标**：qm-next 以 `databaseUrl` 指向新库启动一次（schema 全量落地），停。多实例并发启动安全：eager DDL 与 DurableMap 暖建共用 `qm-next:schema-init` advisory lock 串行。
4. **演练值预检**：`--verify-only` 核对缺失表清单 = 预期（无意外 twin gap）。
5. **dry run**：全量跑一遍看报告表，确认 src/dst 与 twin-gap note 符合预期。
6. **提交**：`--commit`（记录 journal）；行数校验不过则自动回滚，修正后重跑。
7. **重播种**：`--export-seed` 产出的种子经 admin API/console 灌入管理面配置。
8. **验收**：qm-next 起服务，抽查会话/记忆/cron/技能/审计；`/admin/ui` 观测视图对数。
9. **放流**：切 DNS/入口到 qm-next；qm 库保留只读 ≥ 2 周。
10. **回滚**：任何阶段失败——切回 qm 入口（数据未损）；已 commit 的目标库 `--rollback` 后可重跑迁移。

### C.3 演练遗留 → 20.0 收口记录

- **已收口（2026-09-15，组合根 durable sweep）**：tasks/task_events（`createPostgresTaskStore`）、acl×2（`createPostgresGrantStore`）、run_activity/run_signals（`@qm/runs` PG 构造器）、audit_log/turn_metrics/error_events/credential_usage/egress_events/admin_grants（admin sink 常开化：`databaseUrl` 下不再依赖 admin flag）、source_auth_replay（`createPostgresReplayDedupe` 随 `databaseUrl`）、ambient_judgments/ack_emoji_picks（14.0 已接）、deliveries/channel_policy(+history)/webhooks/file_artifacts（20.0 新 twin，本文件 A.2）——组合根 boot 即落地 schema，`--verify-only` 不再报告这些表。
- **设计内缺席（非缺口）**：runtime-config 族/environments/projects/deploy 族=export-seed；surface-cache 缓存类/ratelimit=not-carried；identity 面（`deactivated_principals`/`external_members`）v1 不带；`instance_heartbeats`=TRUNCATE_ONLY（21.0 已接线：组合根随 drain 扫描心跳建表，迁移时清空语义不变）。
- qm 特有不迁清单见 Part A `not-carried`（tool_calls、fork 列、messages/turns 计数、channel 缓存、idempotency、ratelimit 窗口等），已记 `parity-deviations.md` §P5 19.0。
