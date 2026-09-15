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
3. 兜底：超时后 `SIGKILL` 安全——所有运行态在 PG，租约过期自动回收；`files/<sha256>` 内容寻址写入是先写临时文件再原子 rename。

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
  - 实例注册：`instance_heartbeats` 心跳表。
- **拆分形态**（21.0 验证项）：把 `@qm/im-bridge`/`@qm/im-feishu`（IO 密集）与 api/runner（CPU 密集）拆为两个 profile 进程，共享 `databaseUrl` 即可，无粘性路由。
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
