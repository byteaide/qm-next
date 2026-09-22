# qm vs qm-next 差异对比（重对版）

**日期**：2026-09-22
**基线**：qm @ `95b5a6a`（2026-09-05 之后无新提交，基线静止）vs qm-next @ `8419a05`（main，含 tag `soul`）
**上一份报告**：`qm-next-parity-clearance-2026-09-21.md`（54 项偏差 + qm-soul #55 后续补录）
**方法**：`aa` 仓库 2026-09-21 以来的 git 增量逐条核对 + 对 `repos/qm-next/packages/` 定向 rg 验证 + `parity-deviations.md`（现 1155 行，含 qm-soul 节）现读。

---

## 1. 自上一份清障报告以来的落地（2026-09-21 批次）

### 1.1 集群 1 — 部署运行时（已关闭，剩未来 PRD）

| 条目 | 状态 | 证据 |
|---|---|---|
| Docker provider + `/d/<slug>` 部署代理 | ✅ | `ea6303f` |
| git smart-HTTP 后端（capability 绑定） | ✅ | `c739c8c`（`deployment-git-routes.ts`）；`404fab5` 修复 `refs/heads/current` 使普通 `git clone` 可用 |
| Fly / AWS provider | ❌ 未来 PRD | `rg "FlyDeploy\|AwsDeploy" packages` 零命中 |

### 1.2 集群 2 — 生产化（4/5 关闭，剩凭据受限项）

| 条目 | 状态 | 证据 |
|---|---|---|
| S3 字节后端 | ✅ | `store/src/s3-byte-store.ts`；`S3_BUCKET` 选择逻辑 `service.ts:941-953` |
| pg-boss 任务队列 | ✅ | `createPgBossSink`（`@qm/triggers`，可选启用） |
| MonitorPoller | ✅ | `9df3898`（arm→poll→fire→advance→sweep）；`6faf912` 后台启动进注册表；`service.ts:811` 接线 |
| emoji-upload | ✅ | `connectors/src/emoji-upload-service.ts`（`6d58dca`） |
| codex-device-login | ❌ 仍 502 | `user-model-auth-routes.ts:55` 返回 `oauth_start_failed`（"binary is not available in this deployment"）——**依赖 ChatGPT 凭据** |

### 1.3 集群 3 — 小尾巴（6/6 全部关闭）

| 条目 | 状态 | 证据 |
|---|---|---|
| #47a secret-drop `requiresToken` fail-closed | ✅ | `2fefa54`；`parity-lanes-routes.ts:77-94,206-247`；测试 `tranche7-routes.test.ts:352` |
| #47b portal 身份强制（admin 门） | ✅ | `8fd6141`（签名 `x-portal-identity` ↔ `x-admin-actor` 校验） |
| #47d 吊销范围 403 + capability 用时绑定 | ✅ | `8fd6141`（deployment-git 用时重验 aud + grant + `ownerScopeId`） |
| #47e runs 聚合按范围过滤 | ✅ | `127d56f`（`sessionsByThreadRefs`，memory + PG `ANY($1)`） |
| #28 每轮工具台账 + `once()` 重放 | ✅ | `3443671`（`RunStore.ledger` memory + PG `tool_calls`） |
| #27 沙箱基础镜像 digest 固定 | ✅ | cluster 3 简报（2026-09-21） |

### 1.4 qm-soul 灵魂层（本轮最大差异收口，M-Soul-0..5 已完成，tag `soul`）

qm 的产品灵魂层 = **16 段顺序组装管线 + 三模式协议帧 + soul 联邦**（qm `src/core/orchestrator.ts:857-963`）。此前 qm-next 只有零件（`devResolution` 一行占位 `'You are qm-next.'`）；本批次完成组装：

| 条目 | 状态 | 证据 |
|---|---|---|
| ADR-0018（灵魂层=组合协议帧，orchestrator 持有） | ✅ | `docs/adr/0018-soul-layer-is-composed-protocol-frames.md`（accepted） |
| 协议模板栈：fail-loud 渲染器 + 四模板移植 | ✅ | `packages/orchestrator/src/protocols/`；`{{#if slack}}`→`{{#if imChannel}}`、平台名→`{{imLabel}}`（偏差 #55），其余 byte-identical |
| golden 字节对拍 | ✅ 12/12 | `packages/orchestrator/tests/golden/`；模板级 + composer 级双对拍；渲染期 `imLabel='Slack'` 时输出与 qm 完全一致 |
| frame composer（段序 ①-⑥+⑧+⑨+⑬） | ✅ | `frame-composer.ts`：`selectFrameMode`/`deriveSurfaceTools`（qm orchestrator:857-862 语义）、`renderGatewayBlock`、`renderComputerBlock`、`currentTimeBlock`；`stableSystemBytes` 划界（⑬⑭在边界后） |
| 真 ResolutionService 替换 `devResolution` 占位 | ✅ | `api/src/service.ts`：SoulStore.effectiveSoul（段②，org 权威+下级守卫与 qm 逐字）+ `renderSecurityPolicyPrompt`（段④，`securityPosture` 默认 auto）+ branding；占位串全仓清零 |
| SoulStore PG twin | ✅ | `soul_configs`/`soul_history`（沿用 qm 表名，`withSchemaLock` 暖建，`ready()` 按 version 重放水合）；`createPostgresSoulStore` |
| guidance 工具激活（此前死工具） | ✅ | `tool-context.ts:260-262` soulRead/soulWrite 接 SoulStore；org 写拒绝 `soul_update_denied` 阶梯对齐 qm |
| 模式选择激活 | ✅ | ambient/自动化带目的地→autonomous（沉默默认）；非自动化 dm/web→conversation；否则 fallback；行为测试覆盖（捕获式 harness） |
| im-bridge 品牌传递 | ✅ | `botHandle`/`surfaceLabels`/`displayLabel` 经部署配置供值——core 源码零平台词（`check:im` 继续覆盖 `protocols/`） |
| 新门禁 `pnpm check:soul` | ✅ | `scripts/check-soul-placeholder.sh`（占位 prompt 恒零，防回流） |

**qm-soul 登记的偏差与二期（详见 `parity-deviations.md` qm-soul 节）**：

- **#55（源码词汇层）**：模板源码平台词 neutralized；渲染输出在 provider label 等于 qm 字面量时保持字节一致——偏差仅存在于源码词汇层。
- **#55b（有意行为差异）**：qm 只要有 surface 名就渲染 gateway 行；qm-next 改为**仅在 IM envelope 实际提供事实（`TurnInput.gatewayContext`）时渲染段⑨**，避免与模式帧的 surface 措辞重复。
- **段⑩⑪ 有意偏差（2026-09-22 拍板：slack delivery 不移植）**：home channel（⑩）与 cron 多目的地交付菜单（⑪）依赖 qm 的 delivery-candidates+signing+apiBaseUrl（`slack/delivery.ts`）——用户决定不移植 slack delivery 栈，两段随 Q0 一并登记为有意偏差。composer 段位槽位仍按 ADR-0018 预留。
- **段⑮ 已收口（2026-09-22，Q4）**：onboarding 检测按 qm `onboarding.ts` 75 行字节级移植（`packages/orchestrator/src/onboarding.ts`）——记忆标记语法（completed/dismissed/pending v2）、DM + onboarding skill 双门、fail-open；段位在 memoryBlock（⑭）之后、缓存边界外（qm orchestrator.ts:1650 顺序）；`PROACTIVE_OPENER_PROMPT` 接管空文本 proactive opener 的 harness 输入（qm 2253）。台账见 `onboarding.test.ts`（22 测试）+ orchestrator 段⑮/边界用例。
- **段⑫ 已收口（2026-09-22）**：共享文件 ACL（`grantedHandles`）走 lane-A grant ledger + 文件存储——composer 段⑫清单渲染进缓存边界内，ToolContext `read(shared/<name>)` 按 qm 阶梯解析（文本内联 / 二进制物化 / 歧义报错）；授权句柄与工具读取共用同一推导，prompt 不承诺取不到的文件。
- **5.2 飞书 e2e 静默腿待真机**：ambient 群聊未寻址消息→断言零投递（需 FEISHU 凭据 + 人工发消息）。

---

## 2. 全景对比（qm 有 → qm-next 现状）

| 子系统 | qm-next 现状 | 判定 |
|---|---|---|
| 灵魂层（协议帧+soul 联邦） | 段①-⑥+⑧+⑨+⑬⑭⑮已组装，12/12 golden 对拍；⑩⑪登记有意偏差（slack delivery 不移植，2026-09-22） | 🟢 核心已对齐（登记 #55/#55b） |
| 模式选择（autonomous/conversation/fallback） | 已激活，行为测试覆盖 | 🟢 |
| P1 契约（tools 可选/安全回调/模型工具/SessionStore/goal hooks） | 类型冻结，双实现 | 🟢（`HarnessSecurityScreenInput` 冻结仍建议抽查） |
| 存储族（DurableMap/keychain/model/tasks/soul） | `@qm/store`/`@qm/model`/`@qm/tasks` + 新增 soul PG twin | 🟢 |
| 12.0 控制面（capability/share/blobs/secret-drop/admin UI） | 全部落地，#47a/b/d/e 已关闭 | 🟢 |
| Admin 控制台 | 字节级移植 + `/admin/ui` | 🟢 |
| 部署运行时 | Docker + `/d/<slug>` + git HTTP；Fly/AWS 无（2026-09-22 拍板暂缓） | 🟡 剩未来 PRD |
| 监控/队列/字节存储 | MonitorPoller + pg-boss + S3 全落地 | 🟢 |
| 运行可观测（runs 台账/聚合/重放） | #28/#47e 落地 | 🟢 |
| IM 域（飞书） | 14.0b 表情确认、agent-request 卡片、ambient judge（默认 `keyword`，`model` 显式启用） | 🟢（webhook 同意/投递重定向按决策放弃） |
| 用户模型登录 | codex-device-login 与订阅 OAuth 均 502 桩 | 🔴 依赖 ChatGPT 凭据 |
| Connectors 核心 | 后台执行/oauth-flow/consent-link/browser-session/secret-envelope/emoji-upload 已上线；**`connectors/oauth.ts`（PROVIDERS+well-known+PKCE+refresh，qm 626 行）仍未移植** | 🟡 |
| ToolContext 控制面 | background 已真实（进程注册表）；soul 已接线；**cron×9/webhook×3/MCP/shareArtifact 已接控制面**（cron 走 @qm/triggers store+scheduler 的 qm control-service 阶梯，MCP 走 @qm/mcp tool service，share 走 grant ledger；组合时身份绑定，未接线仍诚实不可用） | 🟢 |
| ToolContext publish/playground | T5 评估已出（`t5-publish-playground-evaluation-2026-09-22.md`）：publish 维持诚实不可用→有意偏差（resident-auth 捕获、公网 URL 面缺口，触发条件=Fly/AWS PRD）；createPlayground 存储侧已收口（2026-09-22：`PlaygroundControlSurface` + `uploadForViewer` 直写，qm 标题/校验字节级对齐，Files 可见可分享），剩余 turn-attachment 投递小项（im-bridge 附件面） | 🟡 publish=有意偏差；playground=存储侧🟢，投递余 |
| Context-policy 成员检查 | 目录成员校验已接：directory 在线时 GET/PUT 越权 403（qm `memberScope` 阶梯），离线保持 lane-A 开放 | 🟢 |
| soul 共享 scope 写校验 | `managesScope` 已接目录（qm `createCanManageScope` 语义：personal=本人、group=成员、channel=私有成员）；未接目录时维持拒绝 | 🟢 |
| Portal | 包已就绪 + SSO；**impersonation 路由未移植**；playground 匿名会话随 13.0 | 🟡 |
| Command policy 模拟 | X3b 完整版扫描器已落地（2026-09-22，4a）：`scannableCommand` 全量移植（`packages/sandbox/src/scannable-command.ts`——heredoc/引号剥离、裸词去引号、`sh -c`/eval/`env -S`/sudo/nice/timeout/xargs/coproc 载荷、管道到 shell/SQL 客户端的 stdin 生产者、herestring、简单变量间接、SQL 客户端载荷，深度帽 8），求值器改为对 scannable 文本匹配（qm firstMatch 语义：无效存量规则跳过不锁域、`matched` 返回命中子串、verdict 加 `matched`）；qm 506 行语料移植 24 项全绿；simulate 响应改 `matched`（子串）+ 新增 `ruleId`（模式）。剩余：每作用域存储/CRUD + 分层（4b）、G6 收敛决策 + G8 审批联动（4c） | 🟡 扫描器🟢，存储/分层余 |
| environments/projects 存储 | 刻意每进程（`@qm/api/src/services/`，见 #816 评论） | 🟡 有意为之 |
| 多实例心跳 | `instance_heartbeats` 表在；`TRUNCATE_ONLY` 仅 notes——非真正多实例交接 | 🟡 |

---

## 3. 仍然存在的差异清单（全部有归属）

1. **依赖受限（凭据）**：codex-device-login（502 `oauth_start_failed`）、订阅 OAuth（502 `oauth_complete_failed`）——2026-09-22 拍板：无 ChatGPT 真实凭证，模型面走国产 LLM；两项登记为有意偏差，不再以"等凭据"挂起（代码保持就绪）。
2. **未移植模块**：`connectors/oauth.ts`（IM provider OAuth 栈，注释称"待 P5 18.0 IM providers 落地"）、portal impersonation 路由、Fly/AWS 部署 provider（2026-09-22 拍板暂缓；publish 随之登记有意偏差）。
3. **功能桩**：`command-policy-simulate` 已收口（2026-09-22 X3b-min 起步、同日 4a 补齐 scannableCommand 扫描器，模拟保真=生产保真）；createPlayground 存储侧已收口（2026-09-22：文件库直写 + Files 可见可分享；turn-attachment 投递为剩余小项）；ToolContext 的 publish 诚实不可用（有意偏差，见 T5 评估）（cron/webhook/MCP/shareArtifact 已于 2026-09-22 接控制面收口）。
4. **lane-A 刻意简化**：environments/projects 每进程存储（context-policy 成员检查 #44 与 soul `managesScope` 已于 2026-09-22 接目录收口）。
5. **qm-soul 二期**：段⑮ onboarding 已于 2026-09-22 收口（Q4）；段⑩⑪ 随 slack delivery 不移植登记有意偏差；段⑫ grantedHandles 已于 2026-09-22 收口（composer 段位 + 授权句柄 read 阶梯）；登记偏差 #55（源码词汇）、#55b（gateway 块 envelope 门控，有意行为差异）；5.2 飞书真机静默腿。

---

## 4. qm-next 独有（qm 不具备）

- **平台中立架构**：Cordis 全插件化 + `check:im`/`rescope-check`/`check:soul` 三道隔离门禁；core 源码零平台词，渠道词经部署配置注入。
- **飞书一等渠道**（v1 唯一渠道，2026-09-13 拍板）：WS 长连接、线程回复/编辑/撤回、审批卡片。
- **capability 令牌控制面**：用时绑定（aud+grant+`ownerScopeId`）、fail-closed drop-token 校验、portal 身份签名互检——qm 无此控制面。
- **生产化底座**：S3 字节后端、pg-boss 队列、MonitorPoller、PG 孪生族（含新增 `soul_configs`/`soul_history`）、迁移演练 44/44。
- **部署面**：Docker provider + `/d/<slug>` 代理 + git smart-HTTP（capability 绑定）。
- **运行可观测**：每轮工具台账 + `once()` 重放、runs 聚合按范围过滤。

---

## 5. 结论

自 2026-09-15 偏差台账开立以来：**12.0 控制面、16.0 长尾、19.0 迁移、20.0 生产化、部署运行时、全部小尾巴（#27/#28/#47a-e）以及灵魂层核心（M-Soul-0..5）均已关闭**。当前 qm 与 qm-next 的全部剩余差异可归为三类：

1. **凭据受限 → 转有意偏差**（2026-09-22：无 ChatGPT 真实凭证，模型面走国产 LLM；codex-device-login + 订阅 OAuth 代码就绪但不再等凭据）；
2. **明确挂起**（connectors/oauth.ts、impersonation、Fly/AWS PRD（2026-09-22 拍板暂缓）、5.2 真机 e2e）——均有登记与触发条件；
3. **有意偏差**（#55 源码词汇、#55b gateway 门控、lane-A 简化、每进程存储、段⑩⑪ slack delivery 不移植、publish 维持诚实不可用）——已自文档化，属架构决策而非缺口。

基线侧 qm 自 2026-09-05 起无移动，不产生新差异。第三批（2026-09-22）已收口：X3b 最小版 + createPlayground 存储侧 + X2 核心审计语义。第四批 a 段（2026-09-22）已收口：X3b 完整版 scannableCommand 扫描器（qm 语料 24 项移植全绿，沙箱门闭合 `sh -c`/eval/管道等绕过面）。剩余实现类工作 = createPlayground 投递小项（im-bridge 附件面）+ X2 portal 密封流（ImpersonationClaims 机制已备）+ 每作用域策略存储/CRUD + 分层（4b）+ G6 双引擎收敛决策 + G8 审批联动（4c）+ Q2（依赖 Q0，随偏差挂起）+ 集群 M 多实例。X3a 审计（2026-09-22）已完成。

---

## 附录：本轮运行的验证命令

```
# 登录链路 502 桩（仍开）
rg -n "oauth_start_failed|oauth_complete_failed" repos/qm-next/packages
# → user-model-auth-routes.ts:55,83

# connectors/oauth.ts 是否落地（仍未）
ls repos/qm-next/packages/connectors/src/
# → 无 oauth.ts；有 oauth-flow-service/secret-envelope/emoji-upload 等

# Fly/AWS 部署 provider（无）
rg -ln "FlyDeploy|AwsDeploy" repos/qm-next/packages

# command-policy-simulate（仍 501）
sed -n '234,248p' repos/qm-next/packages/api/src/routes/admin-routes.ts

# ToolContext 控制面现状
rg -n "CONTROL_UNAVAILABLE|unavailable" repos/qm-next/packages/orchestrator/src/tool-context.ts
# → publish/playground/MCP/shareArtifact/cron*/webhook* 不可用；soul 已接线；background 真实

# soul managesScope（仍自文档化）
sed -n '1,8p' repos/qm-next/packages/api/src/routes/soul-routes.ts

# context-policy 成员检查（仍 lane-A）
sed -n '1,8p' repos/qm-next/packages/api/src/routes/context-policy-routes.ts

# qm 侧基线是否移动（未动）
git -C repos/qm log -1 --pretty='%h %ad %s'   # 95b5a6a 2026-09-05

# 本轮批次增量
git log --since=2026-09-21 -- repos/qm-next/packages repos/qm-next/scripts
```
