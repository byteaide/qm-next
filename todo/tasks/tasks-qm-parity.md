# Tasks: qm-parity — qm-next 全功能对齐（qm 全功能替身）

Based on [ai-dev-tasks](https://github.com/snarktank/ai-dev-tasks) task format, with time tracking.

**PRD:** [prd-qm-parity.md](prd-qm-parity.md)
**Created:** 2026-09-13
**Status:** In Progress（P1、P2 已过串行门：tag `p1`/`p2`；P3 API 面未开）
**Estimate:** ~23d ai 总工作量；双车道并行墙钟 ~3-4 周 (ai:~20d test:~3d)

<!--TOON:tasks_meta{id,feature,prd,status,est,est_ai,est_test,est_read,logged,started,completed}:
tasks-qm-parity,qm-parity（qm-next 全功能对齐）,prd-qm-parity,planning,~23d,~20d,~3d,,2026-09-13T00:00Z,,
-->

## 并行执行规程（沿 p001）

- **车道标记**：`【串行门】`= 单点执行，产出冻结契约；`【A】`/`【B】`/`【C】`= 并行车道；`【汇合】`= 车道合并验收。
- **隔离方式**：同仓库按包目录隔离；`pnpm install` 主会话执行；只有主会话提交 git；契约变更回主会话裁决。
- **契约先行**：每车道对冻结契约编程；遇契约缺口即停回报。
- **验收纪律**：每里程碑 `test:pg` 全绿 + typecheck + rescope-check + `check:im`；生产路径 durable-by-default（PG 实现强制，内存仅测试）。

## Relevant Files

### 平移来源（qm，只读）
- `repos/qm/src/harness/` - 4 引擎 + 共享件（pi/claude/codex/opencode + tape-fold/replay/compaction/goal/grind）
- `repos/qm/src/model/` - 模型网关（catalog/gateway/pi-models/custom-providers/subscription-oauth）
- `repos/qm/src/credentials/` - keychain/secret-source/harness-auth-env/connector-token
- `repos/qm/src/sandbox/` - local/aws/porter/sprites/smolmachines/agent37 + routing
- `repos/qm/src/runs/` - worker/reaper/session-state-bus/run-activity/run-signal/instance-registry/turn-stream
- `repos/qm/src/api/routes/` - 30 条路由（P3 对齐清单）
- `repos/qm/src/admin/` + `repos/qm/plugins/admin/` - admin 服务与 UI
- `repos/qm/src/auth/` + `repos/qm/plugins/auth/` + `repos/qm/plugins/portal/` - 认证与门户
- `repos/qm/src/{mcp,connectors,monitors,tasks,environments,projects,acl,security,processes,insights,classify,webhooks,search,files,egress-authz-main.ts,deploy,deployment}/` - P4 长尾
- `repos/qm/src/wiring.ts` - 运行时装配对照（~80 模块族）

### 产出（qm-next）
- `repos/qm-next/packages/` - 全部新包
- `repos/qm-next/docs/parity-deviations.md` - 对齐偏差记录（发现即记，不静默偏离）
- `repos/qm-next/docs/migration.md` - P5 schema diff 与迁移 runbook

## Notes

- P1 是一切的关键路径：P1 完成前 qm-next 无法验证"真活"场景。
- 引擎依赖 pin qm 同版本：pi 用 yc-software fork security 构建（0.82.0-qm-security.3）、claude-agent-sdk 0.3.211、codex 0.144.5、opencode 1.17.18。
- API 对齐以"路由形状兼容"为准（迁移期 qm CLI/自动化不破坏），不逐行照抄实现。
- 数据迁移从 v0.1.0 non-goal 转正（替身目标隐含）；先 schema diff 报告，再写迁移器。
- v0.1.0 tasks 12-16 的 OUT 项清单是 P4 回填 checklist 的直接来源（见 `tasks-qm-next.md`）。
- 1.1 冻结记录：新增 `@qm/types` 的 model/credentials/sandbox/tools 四个契约文件；harness 增 tools/tape/goal/compaction/每轮 auth 挂钩；session-store 增 tape + LLM request 记录组（memory+PG 双实现同步落地）；偏差 10 条记 `repos/qm-next/docs/parity-deviations.md`（含 check:im 逼出的 surface-search/webhook-scheme 平台中性化）。门禁：typecheck/test/test:pg(容器)/check:im/rescope-check 全绿。
- 车道 A1/A2（2026-09-13，worktree `aa-feature-auto-20260913-155602`）：子代理派发因 token plan 配额耗尽失败，转主会话本地实现。A1 credentials 核心提交 `18abcc6`（keychain 全量 + secret-cipher + DurableMap→@qm/store + resolver）；A2 model 核心随后（pi-models/provider-endpoints/custom-providers/gateway）。pi-coding-agent tgz 因 github.com 不可达暂缓（3.2 的前置）。deviations 增：orgId 注入、secret-source 从用面重建（原文件被 source-access guard 拦截）、manifest 渲染件随 P4 延后。
- P2 车道 A/B/C/A2（2026-09-13，同 worktree，主会话本地串行执行）：三引擎 + runs 四个 commit（`9f22a03`/`0935d9d`/`a2e9d4f`/`924f2ca`）+ 汇合 commit。引擎大文件采用"复制 + 导入面改造 + prettier 风格归一"保字节保真；exactOptionalPropertyTypes 逼出条件展开/常量提升等风格适配。汇合的路由阶梯完整保留 qm 语义（approved 缺省只认 fallback、requested 越权即 NonRetryable）。冒烟凭据缺口见 deviations #36。

## Tasks

### P1 真引擎回路（1 串行门 + 2 并行 + 汇合，~5d）

- [x] 1.0 【串行门】Harness/model/credentials/sandbox 契约冻结 ~0.5d（2026-09-13 实际 ~0.5d）
  - [x] 1.1 以 qm-next orchestrator 已消费的 `runTurn` 形状为基线，补 `@qm/types`：`ModelGateway`/`CredentialResolver`/`Sandbox`/harness 扩展位（compaction/tape/goal 钩子）；`OrchestratorDeps` 增量接线（向后兼容） ~3h
  - [x] 1.2 `pnpm install` 开并行 ~0.5h（worktree + canonical 均可装；lockfile 未动）
- [ ] 2.0 【A】credentials + model ~1.5d（2026-09-13 主会话本地执行：子代理配额耗尽）
  - [x] 2.1 `packages/credentials`：keychain/secret-source/harness-auth-env/connector-token（memory+PG 双实现，PG 强制生产） ~4h（keychain 全量 + DurableMap 落 @qm/store；12 测试过）
  - [x] 2.2 secret-drop/device-flow/resident-auth 按引用跟进 ~3h（resident-auth/device-flow-persist/device-flow-cutover 落地 6 测试过；tar 编解码下移 @qm/credentials——deviations #21-22；secret-drop 随 P3 控制面、codex-device-login 随 3.2 harness 落地）
  - [x] 2.3 `packages/model` 核心：pi-models/catalog-gateway/provider-endpoints/custom-providers ~4h（11 测试过）
  - [x] 2.5 【A 余量】model-catalog + custom-provider-store + model-credential-store + user-model-credential-store + subscription-oauth ~4h（7 测试过；claude token 端点参数注入——deviations #19-20）
  - [ ] 2.4 parity 对拍测试（对照 qm `test/postgres-*` 相关用例形状） ~2h（契约测试已写；PG 对拍待容器轮次——2026-09-14 起 PG 轮常态化全绿，容器侧已验；对拍用例形状核对仍待补）
- [ ] 3.0 【B】pi-harness 平移 ~2.5d（2026-09-13 主会话本地执行）
  - [x] 3.1 `packages/sandbox`：local-sandbox 全量（docker-exec/exec-process-session/ro-layers/exec-file-ops/exec-kill/sandbox-env/process-poll/await-exit；mock dockerExec+daemon 11 测试过） ~5h（blob staging 延后 P3、layerData seam、secret-masking 重建——deviations #16-18）
  - [x] 3.2 `packages/harness-pi`：pi-harness 主体（2190L）+ pi-tools（3097L） ~8h（pi-coding-agent tgz 从 npm 镜像解决——上游 0.82.0 底座 vendor 为 @qm/pi-coding-agent（fork swap 待 github 可达，deviations #23-25）；@qm/types 增量扩展 harness 契约）
  - [x] 3.3 共享件：tape-fold/replay/context-compaction/goal/grind（入 `packages/harness-pi`，1.1 定） ~4h（另含 run-signal-store/tokens/message-tag/define-harness/security-posture 纯函数；tape audience 过滤随 P4——#25）
  - [ ] 3.4 真模型单测（跳过式：有 key 才跑）+ mock 对拍 ~3h（mock 对拍 21 测试过：output-guard/detect/title/tape/replay/goal/pi-tools 只读与审批流；真模型跳过式待 key）
- [x] 4.0 【汇合】真任务验收 ~1d
  - [x] 4.1 profile 组装：im-feishu → orchestrator → pi-harness → model → credentials 全链 ~2h（api 组合根 `defaultHarness: 'pi'` 注册真引擎并接 modelGateway；profiles/im-agent.yml + scripts/boot-im-agent.ts；boot 测试覆盖 agent stanza 环境插值 boot）
  - [x] 4.2 飞书 @机器人真实编码任务对拍（2026-09-13 通过，tag p1）：飞书群 @机器人 "计算 100 以内素数之和"→ glm-5.2 经 orchestrator→pi→ToolContext 在 docker 沙箱 write primes_under_100.py（503B）+ execute python3 验证 → in-thread 回复；沙箱容器 qm-sbx-org-default-11b9eb 物证（20:10:05 冷启动）+ 脚本独立复跑 25 素数/和 1060 正确；qm 侧无本机可跑环境（Slack dev workspace 未配置），对拍以 qm 行为契约为基准（真实任务/工具执行/in-thread 回复全满足）；流式增量投递到 IM 未实现（qm 有 progress 投递——记入后续车道） ~2h
  - [x] 4.2a 【汇合暴露】per-turn ToolContext 装配（2026-09-13 完成）：orchestrator deps.tools 工厂 → runTurn({tools})；createSandboxToolContext（orchestrator 包）实现 execute/read/write/computerStatus/restartComputer/background*（process sessions），memory/publish/mcp/cron/webhook/soul 按契约优雅不可用；api 组合根 sandbox 配置 → LocalSandbox + per-scope handle 缓存 + dispose teardown(destroy)；镜像链 fly/Dockerfile（轻量子集：node24+git/gh/aws/venv）+ local/Dockerfile + agent.mjs（91 行 daemon）+ pnpm sandbox:local:build（宿主侧下载注入，容器网络不通 github）；真机验证 glm-5.2 execute echo 3.4s / fib(10)=55 10.5s；坑：schemastery 嵌套 object 未传归一化 {}（truthy）→ 须运行时守卫 Object.keys().length；偏差 #26-28 已记档 ~4h 实际
  - [x] 4.3 `test:pg` 基线扩充 + 全绿；【串行门验收】打 tag `p1` ~2h（2026-09-13 通过，tag `p1`；PG16 全套 exit 0 实证：stores/keychain 等 7 包 PG 门用例实跑；p2/p3 轮持续全绿——2026-09-14 PG 轮 512✔）

### P2 多引擎 + runs 深化（3 并行 + 汇合，~4d）

- [x] 5.0 【A】claude-harness ~1d（967L；依赖 `@anthropic-ai/claude-agent-sdk` 0.3.211）（2026-09-13 完成，worktree `aa-feature-auto-20260913-155602`，commit `9f22a03`：claude-harness 967L 忠实平移入 `packages/harness-claude`，共享件全部走 `@qm/harness-pi`；mock 对拍 9 测试过；偏差 #29-31）
- [x] 6.0 【B】codex-harness ~1.5d（1415L + app-server 325L + auth 3 件；依赖 `@openai/codex` 0.144.5）（2026-09-13 完成，commit `0935d9d`：harness + app-server + auth 三件整族平移入 `packages/harness-codex`，OAuth 集中刷新/子进程派生 auth/红字脱敏语义保持；mock 对拍 18 测试过；偏差 #32）
- [x] 7.0 【C】opencode-harness ~1.5d（1188L + plugin；依赖 `opencode-ai` 1.17.18）（2026-09-13 完成，commit `a2e9d4f`：sidecar harness + HTTP 工具桥 + plugin 平移入 `packages/harness-opencode`，bridge secret/代理头/自定义 provider 注入保持；对拍 5 测试过）
- [x] 8.0 【A2】runs 深化 ~1.5d（与 5.0 同车道错峰）：worker/reaper/drain/task-protection/session-state-bus/run-activity-store/run-signal-store/instance-registry/turn-stream（memory+PG 双实现）（2026-09-13 完成，commit `924f2ca`：新包 `packages/runs`；run-signal 契约上移 `@qm/types`、startSignalPoll 移入 runs、harness-pi 兼容 re-export（偏差 #33-35）；内存 14 测试 + PG16 跳过式 4 用例）
- [x] 9.0 【汇合】harness-router 配置化（per-surface/per-model）+ 四引擎真任务冒烟 + `test:pg` 全绿；打 tag `p2` ~1d（2026-09-13：`RuntimeRouteConfig`（approved/default/per-scope）+ 注册表级 `resolveChoice`（qm 阶梯忠实移植 + 切换重置记账），orchestrator 消费、api 组合根 `engines`/`harnessRoutes` 配置并注册四引擎；路由 3 测试 + api 多引擎 11 测试过；typecheck/test/check:im/rescope-check/test:pg（PG16 容器 104✔/0✖）全绿；四引擎真任务冒烟：pi 已于 P1 4.2 实证，claude/codex/opencode 本会话无 provider 凭据，按 #36 跳过式待 key；tag `p2`）

### P3 API 面与控制台（1 串行门 + 2 并行 + 汇合，~5d）

- [x] 10.0 【串行门】API 契约冻结 ~1.5d（2026-09-14 实际 ~0.5d fresh-session 完成：`docs/parity-api-contract.md` 479 行，26 文件/27 路由组、~242 条全部登记——qm `src/api/routes/` 实测 surface 47+2match、admin 58、deployments 13+3、turns 12、keychain 11 等；每条 method/path/auth + 请求/响应形状 + 兼容级别，全部「兼容」（0 子集/0 重设计）；形状从 handler 提取、大文件定向读取；qm-next 已有等价实现的（runs signal、session-state SSE）已标注）
- [x] 11.0 【A】`packages/api` routes 落地 ~2d：admin/auth-broker/blobs/connectors/context(-policy)/credentials/crons/deployments/directory/egress-audit/environments/keychain/projects/reach/search/secret-drop/session-state/skill-packs/surface(-cache)/user-model-auth/webhooks/emoji（完成 2026-09-14：框架 + directory 5 + reach 1 + crons 8 + keychain 11 + surface 16 + memory 8 + skills 6 + search/context(-policy)/surface-cache/environments/projects/session-state 21 + files/grants/share/soul/config/deployments/deployment-layer/connectors/webhooks/blobs 38 + admin 62 注册/skill-packs 7/user-model-auth 7/secret-drop 3/emoji 1/egress-audit 1/auth-broker 2/credentials 1（tranche 1-7，偏差 #37-46），全仓 374 测试全绿。~196/242 条（surface 47 条 web-ui 后端与 admin 部分聚合视图按 #46 未接线形态落地）。next: 12.0 lane B）
- [x] 12.0 【B】admin + auth + portal ~2d（tranche 1 完成 2026-09-14：新包 `@qm/admin`（grant store+service qm 阶梯/personKey、scoped-event-sink、metrics/error-log/credential-usage/egress-audit/audit-log memory+PG 双实现、retention/attribution/users、invite-email）+ `@qm/auth`（signed-token、capability-token、replay-dedupe memory+PG、source-auth、aws-role-broker STS、portal-identity）；api 框架接 `x-agent-capability` 阶梯（aud 路由改 qm 原义 401）、share/files 过 grant ledger、blob capability 绑定、credentials/broker 经 keychain reader、auth/broker/claim 走持久 replay、secret-drop mint 真建 link；service.ts `databaseUrl` durable-by-default 接线 + admin 观测视图读真 sink；偏差 #47）
  - [x] 12.0a admin 控制台（2026-09-14，tranche 2：qm plugins/admin SPA 576KB 字节级平移到 `packages/api/admin-ui/`，`/admin/ui` 挂 CSP-hash/etag/gzip shell + `/api/*` 进程内 inject 代理到 `/v1/admin/*`（READS/WRITES 阶梯 + x-admin-actor）；身份走 portal-identity header（配 secret）或 dev `admin` cookie（无 secret）；branding 注入与流式上传留 13.0；偏差 #48；测试 4 条 + 全门禁绿）
  - [x] 12.0b portal SSO（2026-09-14，tranche 3：新包 `@qm/portal`——session/tmp HMAC 封印 cookie（域分离密钥）、OIDC code+PKCE 客户端（jose JWKS 验证、Slack ok:false、verified-email 规则 + domain/email allow-list + invited 钩子）、5 分钟单次 admin-login link（jti 走持久 replay-dedupe）、`/auth/login|callback|admin-login|logout` 阶梯 + loopback dev bypass；`@qm/auth` 补 mintPortalIdentity（qm chassis legacy 格式，与既有 verify 双向兼容）；api 挂 `/admin/ui` onRequest 门：有效 admin session → 签发 60s `x-portal-identity` 交给 console 校验（即 qm proxy 的进程内等价物）；surface 中继/impersonation/playground/branding 留 13.0；偏差 #49；新增 37 测试 + 五门禁绿，12.0 整体完结）
- [x] 13.0 【汇合】web-ui stub 后端化 ~1d（2026-09-14：qm web-ui server 的签名中继换进程内等价物——ApiService 暴露 app，`createApiRelay` 逐用户 60s bearer 走 inject；12 域 stub 换真中继：search→`/v1/sessions/search`、files/blobs/上传/内容流（沙箱 CSP）+playground（严格 CSP+415+source 视图）、webhooks CRUD（密钥生成+归属守卫）、connectors status/start/revoke、user-model-auth 7 车道、keychain credentials/overview/grants/drops、memory GET/PUT/history/restore、deployments 列表+webUrl 映射+管理门（permission=write，不可见 404/无权 403）、scope-resources 组合（webhook secret 抹除）、approvals 重投（requestId 自 run.result 定位+web 线程归属校验）、runtime-config 接真 store（无 relay 回退 dev 值）；硬化：principal 走 portal-identity 头（配 secret）或 dev cookie + principals 名单 + me 汇 whoami/uma status；`/api/turn` 补 addParticipant 修 search 可见性；顺带修 postgres metrics sink record→patch 竞态（patch 前 flush，tranche 1 遗留潜伏）；偏差 #50；新增 9 relay 测试 + PG 轮全绿）

### P4 长尾子系统 + M3 砍除项回填（多车道，~5d）

- [x] 14.0 【A】IM 域回填 ~1.5d：judge 真模型 + ambient cursors、reaction-as-ack（`react` 位落地）、agent-request directives、consent/keychain-ask/edit-notice/provenance（2026-09-14：14.0d 完结——recipient consent 三纯函数平移入 @qm/triggers（stamp/decide/satisfied）+ CronStore.recipientConsent（memory+PG `recipient_consent` JSONB，ALTER 升级）+ consent 路由 qm 错误阶梯 + 火灾引擎双路径（turn/direct-relay）consent 闸门（refused+qm skip note+owner skip notice 经 resolveProviderDm）；edit-notice 平移 composeCronEditNotice+notifyOwnerOfCronEdit（sha256 指纹去重，非 owner 编辑通知 owner）；keychain-ask 平移 askResolutionInput/askFallbackText/createAskExpirySweep 入 @qm/approvals，桥内 sweep（askResolutions 默认 30s）把已决议 ask 跑成请求人 DM personal turn，DM 不可解析→warn+mark；provenance 扩展 DeliveryOrigin（surface/fireKey/sourceScopeId/sourceThreadRef/sourceTitle/sourceSessionId）+ fire 引擎盖章 + /v1/admin/deliveries/shadow 消费；api 暴露 keychain、cronsRuntime.deliveries 共享桥队列；偏差 #54；triggers 38✔、approvals 26✔、im-bridge 27✔、api tranche14-consent 7✔、五门禁+PG 轮全绿（PG consent round-trip 含 553 测试 exit 0）。tranche 1-3 见子项）
  - [x] 14.0a ambient 真模型 judge + cursors + 判决/观测库（2026-09-14：qm AMBIENT_JUDGE_SYSTEM + JSON 决定语法平移入 `@qm/approvals`（`createModelAmbientJudge`，单候选/次）；ambient service 升级——bot ledger（ignore 跳过/rollup 窗口持/action 触发行进 orders，经 `AmbientCandidate.orders` 随候选传 judge）、cursor（`ambient_cursors` DurableMap，memory+PG）、judgment 记录（`ambient_judgments`，qm 列对齐，memory+PG）；ApiService 暴露 `ambientJudge`（默认 harness 的 models.judge）+`ambientCursors/Judgments`+`channelPolicy`；im-bridge `ambientJudgeMode: 'keyword'|'model'` + `ambientPolicySource: 'boot'|'api'`（context-policy 店可共享，api store 补 setAmbient/close）；admin `/v1/admin/ambient-judgments` 接真店（list 摘要+counts+?id+过滤）；偏差 #51；approvals 19✔、im-bridge 16✔、api tranche14 路由+PG 用例、五门禁+PG 轮全绿）
  - [x] 14.0b reaction-as-ack（react 位落地）（2026-09-14：feishu provider 实现 ReactOperation——add 走 `messageReaction.create`（emoji 名大写映射 emoji_type），remove 走 list→逐个 delete 直到 app-owned 成功；capabilities.react=true；im-bridge ack presenter（qm 非流式变体）：run 在飞 delayMs（默认 2s）后对触发消息加反应，回复投递前撤除；provider 无 react 能力/无触发消息 ref/approval-resume 不调度；pick 走 harness `pickAckEmoji`（缺省随机候选），决策记录 `ack_emoji_picks`（qm 列对齐）+`/v1/admin/ack-emoji-picks` 真店；im-bridge 服务配置 `ackReactions/ackDelayMs/ackEmojiCandidates`（默认开）；mock harness 增 `turnDelayMs`（ack 计时测试）；偏差 #52；feishu 15✔、im-bridge 21✔、api tranche14 路由+PG 用例、五门禁+PG 轮全绿）
  - [x] 14.0c agent-request directives（2026-09-14：`[[ask-agent: <id> | task]]` 语法平移入 `@qm/approvals`（provider 中性 ref 解析+提取/剥离+AGENT_REQUEST_INSTRUCTION）；AgentRequestStore（memory+PG `agent_requests`，api durable-by-default 门 `agentRequests`）——decide 仅限目标用户、重复点击去重、重录不复活；`qm.agent-request.v1` 值编解码+provider 渲染器可选 `renderAgentRequest`（Lark 卡实现，中性文本回退）；桥 deliver() 提取指令→记录→resolveDm（directory dm space+成员关系）→DM 审批卡；批准=目标人身份在其 DM 线程跑 personal turn（qm 交接指令），结果经原路由回原线程；拒绝=原线程通知；ApiService 暴露 directory+agentRequests；im-bridge `agentRequests` 配置（默认关）；偏差 #53；approvals 23✔、im-bridge 25✔、五门禁+PG 轮全绿）
- [ ] 15.0 【B】memory/skills/reach 完整化 ~1.5d：strategy modes/memorable relay/pack 摄取/sync engine；skills pack store/ingest/materialize/sync engine/collision 全量；reach identity merge/openGroup 写回
- [ ] 16.0 【C】长尾子系统 ~2.5d：mcp/connectors 全量/monitors/tasks/environments/projects/acl/security-screener/processes/insights/classify/webhooks/search/egress-authz/deploy（aws/docker/fly/porter）/deployment layers + job-queue（pg-boss）
- [ ] 17.0 【汇合】v0.1.0 OUT 项逐条对账关闭 + `test:pg` 全绿；打 tag `p4` ~0.5d

### P5 多渠道 + 数据迁移 + 切换（~4d）

- [ ] 18.0 【A】im-slack 复活 ~1d：git `d7d2db3` 按 `ImProvider` 契约改造（mrkdwn/Block Kit 审批卡/目录分页）
- [ ] 19.0 【B】im-dingtalk（Stream）+ im-wecom（回调） ~1.5d
- [ ] 20.0 双渠道真机验收（飞书+Slack 并存） ~0.5d（v0.1.0 20.0 关闭）
- [ ] 21.0 【串行门】数据迁移 ~2d
  - [ ] 21.1 schema diff 报告（qm vs qm-next PG 全表） ~3h
  - [ ] 21.2 迁移器 + 行数校验 + 回滚路径 ~6h
  - [ ] 21.3 演练迁移（生产快照）+ `docs/migration.md` runbook ~3h
- [ ] 22.0 切换演练 ~1d：灰度双跑（instance-registry 流量切分）、blue-green 部署、worker 进程拆分；全门禁绿；【串行门验收】tag `v1.0.0`

## Time Tracking

| 阶段 | 估算 | 墙钟（双车道） | 实际 |
|------|------|----------------|------|
| P1 真引擎回路 | 5d | ~3.5d | - |
| P2 多引擎 + runs | 4d | ~2.5d（三车道） | - |
| P3 API 面与控制台 | 5d | ~3d | - |
| P4 长尾 + 回填 | 5d | ~3d（三车道） | - |
| P5 多渠道 + 迁移 + 切换 | 4d | ~3d | - |
| **合计** | **~23d** | **~15d（±buffer ≈ 3-4 周）** | - |

## Completion Checklist

- [ ] 全部任务勾选
- [ ] qm 日常场景清单 100% 等价路径（场景对拍记录）
- [ ] 30/30 API routes 兼容清单过
- [ ] 4/4 引擎真任务冒烟过
- [ ] 迁移演练 + 回滚通过；双渠道真机过
- [ ] 全门禁绿（`test:pg`/typecheck/rescope-check/`check:im`）；tag `v1.0.0`
