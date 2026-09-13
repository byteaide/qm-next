# API 契约冻结 — qm-next vs qm（P3 任务 10.0）

对照基准：qm `src/api/routes/`（27 模块 / ~242 路由，2026-09-14 实测）。
原则（PLANS.md）：**以路由形状兼容为准** —— 迁移期 qm 侧 CLI/自动化不破坏；
不逐行照抄实现。形状一律从 handler 提取。

兼容级别：

- **兼容**：method/path/auth 与请求/响应形状保持一致（响应字段可少不可变形）。
- **子集**：同路径同方法，响应/请求为 qm 的严格子集（去掉可选扩展），旧客户端不破坏。
- **重设计**：路径或形状有意不同 —— 必须附迁移说明。

## 全局约定

- 响应统一 `sendJson(res, status, body)`；错误体 `{ error: string, message?: string, ...extra }`。
  常见码：`bad_request`(400)、`forbidden`(403)、`not_found`(404)、`rate_limited`(429)、`not_configured`(501)。
- auth 级别（`RouteAuth`）：
  - `public`：无鉴权；
  - `source`：源签名鉴权（plugin signer 的 SourceAuth）；
  - `either`：source 鉴权或 agent capability token（`ctx.capability`）二选一；
  - `{ aud }`：须携带指定 audience 的 capability token。
- handler 侧身份：`ctx.capability`（内部 agent 调用）、`ctx.actor`（portal 身份）、
  `x-admin-actor` 头（管理面兜底）；管理面统一走 `authorizeAdmin`（admin grant 校验）。
- 通用错误守卫：依赖未接线 → `404 { error: "not_found" }`；capability 要求但缺失 →
  `403 { error: "forbidden", message: "… requires an agent capability token" }`。

## turns（12 条，auth 全 `source`）

内部运行时 lane（worker/harness 调用），qm-next packages/runs 已实现 signal 部分。

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/turns` | `TurnRequest`（必填 `text:string`、`actor{}`、`conversation{}`；可选 `async`、`origin{}`、`triggered`、`securityScreenData`；服务端剥离 `ownerKeychainUnion/spawned/unattendedGrants`） | `200` turn 结果 / `202` `{status:"queued",…}` / `403` refused / `400` bad_request | 兼容 |
| POST `/v1/turns/:runId/metrics` | `{ deliverMs?^number≥0, slackInflightMs?^number≥0 }` 至少一项 | `200 {ok:true}`（metrics 未接线静默成功） | 兼容 |
| GET `/v1/approvals/pending?threadRef=` | — | `200 {pending: Approval|null}`；缺 threadRef `400` | 兼容 |
| GET `/v1/approvals/:id` | — | `200 Approval` / `404`（id 含 `/` → 404） | 兼容 |
| POST `/v1/runs/:id/delivery-state` | `{ editRef:string }` | `200 {ok:true}` / `400` / `404` | 兼容 |
| POST `/v1/runs/:id/signal` | `{ kind:"abort"\|"steer", text? }`（steer 缺 text → `400 {error:"bad_request", message:"text required", …outcome}`） | `200 outcome` / `400` / `404` / `409` | 兼容（契约已在 @qm/types） |
| POST `/v1/runs/:id/withdraw` | — | `200 {withdrawn:true,…}` / `404` / `409` | 兼容 |
| GET `/v1/runs/:id` | — | `200 Run` / `404` | 兼容 |
| GET `/v1/runs?threadRef=` | — | `200 {runId:string\|null, queued?}` | 兼容 |
| GET `/v1/deliveries?type=&claimMs=` | — | `200 {deliveries:[]}` | 兼容 |
| POST `/v1/deliveries/:id/ack` | `{ recipientThreadRef?, slackApiMs?^≥0 }` | `200 {ok:true}` | 兼容 |
| POST `/v1/deliveries/ack-by-key` | `{ idempotencyKey:string }` | `200 {ok:true}` / `400` | 兼容 |

## directory（5 条）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/principals/:id/deactivate` | — | `200 {ok:true, principalId, active:false}` / `404`（identity 未接线或 id 缺失）；记审计 `principal.deactivate` | 兼容 |
| POST `/v1/principals/:id/reactivate` | — | `200 {ok:true, principalId, active:true}` / `404`；审计 `principal.reactivate` | 兼容 |
| POST `/v1/directory` | `{ members?[], channels?[], groupMembers?[], channelMembers?, channelRosterIds?, channelRevocations?, groupIds?, groupRosterIds?, workspaceUrl?, membersSyncedAt?, channelsSyncedAt?, groupsSyncedAt? }`（三个主数组至少一个；member.type ∈ PRINCIPAL_TYPES） | `200 {ok:true, members?, channels?, groupMembers?}`（计数）；`400` | 兼容 |
| GET `/v1/directory/meta` | — | `200 DirectoryMeta`（app.directoryMeta() 透传） | 兼容 |
| GET `/v1/directory/resolve?q=` | — | `200 {matches: DirectoryMember[]}`（one/ambiguous 均回数组；补 slackId 缺省：principalId 匹配 `^[UW][A-Z0-9]{8,}$` 时回填）；缺 q `400` | 兼容 |

## reach（1 条，auth `either`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/reach` | `{ text?\|message?, recipient?, channel?, participants?[], threadTs?^\d+\.\d+$, unfurlLinks?, react?{ts,emoji}, delete?{ts}, files?[](workspace 相对路径，≤MAX_OUTBOUND_FILES，禁 `..` 段) }`。约束：capability 必需（否则 403）；react/delete 互斥、不带 files/threadTs、不允许 recipient（用 channel/participants）；files 需 text post。发送端限流 `reach:<actorId>` | `200 {ok:true, deliveryId, recipient?\|channel?\|group?}`；错误透传 `app.resolveReachTarget` 的 `{error,message,candidates?}`；`429` rate_limited；`501` sandbox/blob 未接线；`400 attach_failed`（missing/empty/oversized 列表） | 兼容 |

## crons（7 + 1 match）

destination/capability 双模：capability 模走 `deps.control`（ControlService），source 模走 `app`（须 `?principalId=` 授权，`canAdministerCron`）。错误码→状态映射：`bad_request/cron_create_failed/cron_update_failed/unknown_destination/members_unavailable`→400，`forbidden/identity_unverified/not_a_member`→403，其余 404。

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/triggers/:id/consent` | `{ decision:"accept"\|"decline" }`（capability 必需；trigger = cron 或 webhook） | `200 {ok:true, consent}` / `400`（无 consent 待决）/ `403`（非收件人）/ `404` | 兼容 |
| POST `/v1/crons` | capability 模：`{ schedule{cron+timezone? \| everyMs? \| firstFireAt?}, task?\|action?, text?\|message?, title?, recipient?, channel?, participants?, scope?:"personal", destinationKey?, runAs?:owner\|scopeFloor\|scopeShared, unfurlLinks?, unattendedGrants?[] }`（timezone 缺省取 capability.timezone → DEFAULT_CRON_TIMEZONE）。source 模：完整 `CreateCronInput`（ownerScopeId/owner/createdBy 必填；`runAs:"scopeShared"` 仅 capability 模） | `200 {cron: CronNoFireLog, recipient?\|channel?\|group?}`；`400 {error:code, message, candidates?}`（ambiguous 时 candidates 按 recipient/channel 变形） | 兼容 |
| GET `/v1/crons` | capability 模或 `?viewer=` | `200 {crons[], visible[]}`（均剥 fireLog；viewer 模附 `permission:"manage"\|"read"`） | 兼容 |
| POST `/v1/crons/:id/disable` | — | `200 {ok:true}` / 错误映射 | 兼容 |
| POST `/v1/crons/:id/destination` | `{ destinationKey:string }`（capability 必需） | `200 {cron}` / `403` / `400` | 兼容 |
| POST `/v1/crons/:id/run` | — | `200 {ok:true}`；source 模：archived/paused → `400`；scheduler 未接线 → `404`（fire 为异步 void） | 兼容 |
| GET `/v1/crons/:id/runs?limit=` | — | `200 {cron, runs, total}`；limit 须正整数 | 兼容 |
| GET/PATCH/DELETE `/v1/crons/:id`（match：单段 id） | PATCH：`{ title?, task?\|action?, schedule?, enabled?, archived?, unfurlLinks?, runAs?, unattendedGrants? }`（空补丁 → `400 CRON_PATCH_NOTHING_TO_CHANGE`；source 模禁改 runAs、unattendedGrants 非空的 cron 仅 owner 活跃 turn 可改、unfurlLinks 需已有 destination） | `200 {cron}\|{ok:true}`（DELETE）/ `200 {cron:null}`（source 模 patch 未命中） | 兼容 |

## keychain（11 条，单 handler 分发；auth `either` 但 handler 强制 capability，缺失 → `401 {error:"unauthorized"}`；`KeychainError` → `{error:"keychain", message}` + 自带 status）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/keychain/credentials` | `{ service:string, secret? \| files?[{path,contentBase64}] \| fields?[{envKey,value}] 三选一（至少一项），envKey?, target?, host?, accountLabel?, origin?（缺省 `agent-session:<scopeId>`), expiresAt?（normalizeInboundExpiresAt 校验） }` | `200 {credential: meta}`；审计 `keychain.save` | 兼容 |
| GET `/v1/keychain/credentials` | — | `200 {credentials[]}`（按 owner） | 兼容 |
| GET `/v1/keychain/overview` | — | `200 {credentials, connectorCredentials, grants, asks(仅pending), usage(≤50,按ts降序,附credentialId), scopeNames{scopeId→显示名}}` | 兼容 |
| DELETE `/v1/keychain/credentials/:id` | — | `200 {ok:true}` / `404`；审计 `keychain.delete` | 兼容 |
| POST `/v1/keychain/grants` | `{ credential?\|ask?, mode:"once"\|"standing", purpose:string, expiresAt? }`（triggered turn → `403 CONSENT_ON_TRIGGERED_TURN`；credential 非 owner → `403`） | `200 {grant, ask?}(ask 模) / {grant, use:{command,note}\|{note:作用域提示}}`（use 仅当 grant.audienceScopeId === 当前 scope）；审计 `keychain.grant.once/standing` | 兼容 |
| GET `/v1/keychain/grants` | — | `200 {grants[]}`（owner∪当前 scope audience，按 id 去重） | 兼容 |
| POST `/v1/keychain/grants/:id/revoke` | — | `200 {ok:true}` / `404`；审计 `keychain.revoke` | 兼容 |
| POST `/v1/keychain/asks` | `{ credential:string, purpose:string, requestedMode?:"once"\|"standing", expiresAt? }`（triggered → 403；仅 channel scope（403）；credential 须存在（404）、owner 须为频道已验证成员（403）；成功则向 owner enqueue 通知，幂等键 `ask:<id>:notice`） | `200 {ask, existing:boolean}`；审计 `keychain.ask`（新建时） | 兼容 |
| GET `/v1/keychain/asks` | — | `200 {asks[]}`（requester/owner/scope 三见过滤） | 兼容 |
| POST `/v1/keychain/asks/:id/decline` | `{ note? }`（triggered → 403） | `200 {ask}`；审计 `keychain.ask.decline`；异步 fireAskResolution | 兼容 |
| POST `/v1/keychain/use` | `{ grant }\|{ credential }`（own 模须 `capability.liveActor===true`，否则 403 引导用 grant） | `200 text/plain`（renderUseScript 脚本，非 JSON）；记 credentialUsage + 审计 `keychain.use` | 兼容 |

## search（1 条，auth `either` 但 handler 强制 capability → `401 {error:"capability_required"}`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/search` | `{ query:string（trim 非空）, limit?:number }`；channel/group scope 须带 `capability.members` 完整成员集（缺失 → `409 {error:"principal_set_unavailable"}`），并自动并入 actor | `200 SearchResult`（`{hits:[{backend,…}], failedBackends}` 透传 app.search）；审计 `search.query`（含 principals/hitCount/backends/failedBackends 明细） | 兼容 |

## context（4 条；surface-context 拉取协议）

同步等待 fulfillment：context 轮询 25s（poll 100ms）、file 120s；超时 `504 {error:"surface_timeout"}`、失败 `502 {error:"surface_error"}`。

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/surface-context` | `{ channel?（`\#name` 或 C/G id）, count?（1..200，缺省100）, before?, match?（≤200字符） }`（capability 必需 → 401；channel 不可见 → `403 {error:"not_visible"\|"identity_unverified"}`；无 channel 且 destination 非 slack → `400 {error:"no_conversation"}`） | `200 {channel?: "#name", …SurfaceContextResult}`（messages/hasMore/nextBefore/note/file/group） | 兼容 |
| POST `/v1/surface-file` | `{ ts:string, threadTs?, name?, channel? }`（缺 ts → 400） | `200 {file:{name,sizeBytes,mimetype?,author?}, download:{path:"/v1/blobs/:id", header, token(5min TTL blob-read capability), expiresInSeconds}, note}` / `502`（surface 无法取文件） | 兼容 |
| GET `/v1/surface-context/pending?source=&waitMs=` | — | `200 {requests:[{id, query}]}`（长轮询 ≤20s，poll 100ms；source 缺省 "slack"） | 兼容 |
| POST `/v1/surface-context/:id/result` | `{ error?} \| { messages?[], hasMore?, nextBefore?, note?, file?{blobId,name,sizeBytes,mimetype?,author?}, group?{groupId} }` | `200 {ok:true}` / `404`（过期或已答） | 兼容 |

## context-policy（2 条，auth `source`）

scope 仅限 channel/group（否则 400）；`?principalId=` 须为该 scope 成员（listContexts 校验，否则 403）。

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/contexts/policy?principalId=&scope=` | — | `200 {policy:{orders, bots{}, ambientEnabled:boolean\|null, updatedAt}}`；channelPolicy 未接线 → `404` | 兼容 |
| PUT `/v1/contexts/policy` | `{ principalId, scope, orders:string（≤20000字符）, bots?, ambientEnabled?:boolean\|null, baseUpdatedAt?（乐观锁，不匹配 → 409 conflict） }` | `200 {policy:{…}}`；审计 `surface.policy.set` | 兼容 |

## surface（47 + 2 match —— 最大模块；web-ui 后端）

`viewer`/`principalId` 查询参数是本模块的主授权轴：`?viewer=` 必填的端点缺参 → 400。
transcript 窗口参数：`tailTurns`(≥1) / `sinceSeq`(≥0) / `beforeSeq`(≥1) 互斥组合；非法 → 400。

### sessions（web 管理面，auth 全 `source`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/session-cap` | —（须 portal actor → 401 unauthorized） | `200 {token}`（personal scope capability，TTL CAPABILITY_TTL_MS；secret 未设 → 503） | 兼容 |
| GET `/v1/sessions?principalId=` | — | `200 {sessions[]}` | 兼容 |
| GET `/v1/sessions/search?principalId=&q=&limit=` | — | `200 {hits[]}` | 兼容 |
| GET `/v1/sessions/:id?viewer=&tailTurns=\|sinceSeq=\|beforeSeq=` | — | `200 session+transcript 窗口` / `404` | 兼容 |
| GET `/v1/sessions/:id/entries/:seq?viewer=` | — | `200 entry` / `404` / `400`（seq 非法） | 兼容 |
| POST `/v1/sessions/:id` | `{ principalId, title?^(string\|null, trim≤200), archived?, pinned?, color?^'#rrggbb'\|null }` 至少一项 | `200 {session}` / `404` | 兼容 |
| POST `/v1/sessions/:id/title` | `{ principalId }` | `200 regenerated title` / `404` | 兼容 |
| POST `/v1/sessions/:id/fork` | `{ principalId, upToSeq?^≥0 int }` | `200 fork 结果` / `404` | 兼容 |
| GET `/v1/sessions/:id/approvals?viewer=` | — | `200 {approvals[]}` | 兼容 |
| GET `/v1/sessions/:id/background?viewer=` | — | `200 background view` / `404` | 兼容 |
| GET `/v1/sessions/:id/background/:pid/output?viewer=&sinceCursor=` | — | `200 output read` / `404` | 兼容 |

### conversations（agent self-API，auth `either`，强制 capability → 401 capability_required）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/conversations` | — | `200 {conversations:[{id,scopeId,surface,title,archived,pinned,createdAt,lastActivityAt}]}` | 兼容 |
| GET `/v1/conversations/:id?tailTurns=\|beforeSeq=`（禁 sinceSeq → 400；缺省 tailTurns=20） | — | `200 session+窗口` / `404` | 兼容 |
| POST `/v1/conversations/:id` | `{ archived?, pinned?, title?, color? }` 同 patchSession 校验 | `200 {conversation:{id,title,archived,pinned,color}}`；审计 `conversation.update` | 兼容 |
| POST `/v1/conversations` | `{ text:string（首条消息）, title? }`；须 livePersonCapability（cron/trigger → `403 {error:"human_attended_only"}`）；seed turn refused → 回滚 discardSession + `409 {error:"seed_turn_refused"}` | `202 {session, turn:{status, runId?}}` / `404`（scope 不能起会话） | 兼容 |
| POST `/v1/conversations/:id/fork` | `{ upToSeq? }` | `200 fork 结果` / `404` | 兼容 |

### files

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/files?limit=&cursor=&scope=`（auth either；viewer=capability.actorId\|actor.p → 缺失 401） | — | `200 分页 page`（listFilesForViewer 透传） | 兼容 |
| GET `/v1/files/:id/content`（auth either） | — | `200 二进制流`（content-type+length+inline disposition）/ `404` / `401` | 兼容 |
| POST `/v1/files/upload`（auth source） | `{ principalId, blobId（staged）, name, mimetype?, scopeId? }`；blobTransfer 未接线 → `501`；上传他人 context → `403`；超限 → `413 payload_too_large`；用后删除 staged blob | `200 {file}` / `404`（staged 不存在） | 兼容 |

### memory（个人 self + agent 双面）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/memory?principalId=`（auth source） | — | `200 head（content+revision）`；memory 未接线 404；审计 `memory.self.read` | 兼容 |
| PUT `/v1/memory`（auth source） | `{ principalId, content:string, revision? }`（revision 非空走 replaceIfRevision；不匹配 → `409 {error:"conflict", …head}`） | `200 {ok:true, …head}`；审计 `memory.self.update` | 兼容 |
| GET `/v1/memory/history`（auth either） | capability 模可带 `?scope=org`（其余值 400）；viewer 与 principalId 不符 → 404 | `200 {revisions[]}`（≤30；无 history 实现 → 空数组） | 兼容 |
| POST `/v1/memory/restore`（auth either） | `{ revision, expectedRevision, scope?:"org" }`（principalId 仅 source 模且须=viewer） | `200 {ok:true, …head}` / `409 conflict` / `404`；审计 `memory.self.restore` | 兼容 |
| GET `/v1/memory/self`（match，either/source 双注册） | capability：`?scope=org`（须 orgWrite）；body 带 recipient/channel/participants → 400 | `200 {scopeId, content}`；403 memory.read 未启用；审计 `memory.agent.read` | 兼容 |
| PUT `/v1/memory/self`（match） | `{ content:string, scope?:"org" }` | `200 {ok:true, scopeId}`；审计 `memory.agent.curate` | 兼容 |
| POST `/v1/memory/search`（match） | `{ query:string, limit?（1..50，缺省20） }`（capability.memory.read 为空 → 403） | `200 {results:[{scopeId, fact}]}`；审计 `memory.agent.search` | 兼容 |
| POST `/v1/memory/facts`（match） | `{ facts:string[1..20], scope?:"org" }` | `200 {ok:true, added, scopeId}`；审计 `memory.agent.capture` | 兼容 |

### skills

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/skills?principalId=&includeShadowed=`（auth source） | — | `200 {skills:[{id,name,description,scope,scopeId,shadowed,status,version,source:"pack"\|"native",pack?,assetCount,requiredCapabilities,editable}]}`（visible+可管理的 archived） | 兼容 |
| GET `/v1/skills/:id`（auth either；viewer=capability\|actor\|?principalId） | — | `200 {skill:{…,body,files:[{path,executable}],grantedCapabilities,createdAt,updatedAt,editable}}` / `404`（不可见且不可管理） | 兼容 |
| POST `/v1/skills`（auth either） | capability 模：`{ name, description, body }`（sharedSkillCreateBlock 拒绝 → 403）；source 模可传 `scopeId`（managesScope 校验，org/team scope → 403） | `201 {skill}` / `409 {error:"exists"}` | 兼容 |
| PUT `/v1/skills/:id`（auth either） | `{ description?, body? }`（trigger 模改共享 skill → `403 trigger_blocked`） | `200 {skill:{id,name,description,body,status,version}}` / `404` | 兼容 |
| DELETE `/v1/skills/:id`（auth either） | — | `200 {ok:true}`；`404 missing` / `403 trigger_blocked\|非本人` | 兼容 |
| POST `/v1/skills/:id/restore`（auth either） | — | `200 {ok:true}` / `404` | 兼容 |

### grants / share / config / soul

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/grants`（auth source） | Grant 对象（isGrant 校验） | `200 {ok:true}` / `400 grant_failed` | 兼容 |
| POST `/v1/grants/revoke`（auth source） | `{ ownerScopeId, ref, granteeScopeId, revokedBy }` | `200 {ok:true}` / `400 revoke_failed` | 兼容 |
| POST `/v1/share`（auth either，capability 必需 → 403） | `{ type∈ARTIFACT_TYPES, id, toScope（"org"\|scope id\|人名）, permission?:"read"\|"write", move? }` | `200 {ok, verb, type, id, target, permission}`；错误映射 400/403/404/409 + candidates | 兼容 |
| GET `/v1/surface-config`（auth source） | — | `200 {webuiModels[], baseModel, harnessId, modelProviderConfigured?, externalSlackParticipants, branding?}`；config 未接线 404 | 兼容 |
| GET `/v1/runtime-config`（auth either） | `?principalId=&scope=` | `200 runtimeConfigBody`（harness/model/effort/fastMode 选择态 + catalog） | 兼容 |
| PUT `/v1/runtime-config`（auth either） | `{ principalId?, scope?, harnessId?, modelId?, effortLevel?（THINKING_LEVELS，缺省 auto）, fastMode?（仅 FAST_MODE_MODEL_IDS 生效） }`；未批准 harness → `400 {error:"harness_not_approved"}`；模型不支持/未启用同理 | `200 runtimeConfigBody`；审计 `runtime-config.update` | 兼容 |
| GET `/v1/channel-header-pin`（auth either） | — | `200 {scopeId, on, configured, default}` | 兼容 |
| PUT `/v1/channel-header-pin`（auth either） | `{ on:boolean\|null }`（null 回退 org 默认；capability 非 live → `403 {error:"live_actor_required"}`） | `200 {scopeId, on, configured}`；审计 | 兼容 |
| GET `/v1/soul`（auth either） | scope=capability.scopeId\|?scopeId | `200 soul` | 兼容 |
| POST `/v1/soul`（auth either） | capability：`{ content }`；source：`{ scopeId, content, actorId }`（personal scope 须 managesScope） | `200 {ok:true, version}` / `403 soul_update_denied` / `500 soul_update_failed` | 兼容 |

### 其他

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/contexts?principalId=`（auth source） | — | `200 {contexts[]}` | 兼容 |
| GET `/v1/scope-resources?principalId=&scope=`（auth source） | — | `200 {files, crons, webhooks(脱敏), deployments, skills, manageable}` / `404` | 兼容 |
| GET `/v1/ui-state?principalId=&key=`（auth source；key 须匹配 UI_STATE_KEY_PATTERN） | — | `200 {value, updatedAt}`（缺省 `{value:null, updatedAt:0}`）；uiState 未接线 404 | 兼容 |
| PUT `/v1/ui-state`（auth source） | `{ principalId, key, value（≤UI_STATE_MAX_BYTES → 413）, updatedAt?（未来偏移钳制） }` | `200 store 结果` | 兼容 |
| GET `/v1/apis`（auth either，强制 capability） | — | `200 renderAgentApis`（按 capability 能力 + isAdmin/role 渲染 self-API 清单）；审计 `apis.list` | 兼容 |

## surface-cache（3 条，auth `source`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/surface-cache/ingest` | `{ surface?（缺省"slack"）, events[]（toEvent 规整：container+ts 必填；可选 sub/authorId/authorName/text/mentions{}/self/bot/mentionsSelf/editedAt/deleted/handled/createdAt/files[{fileId,name?,mimetype?}]/members[]/containerName/kind:channel\|dm\|group）, self?{name?,mentionId?} }` | `200 {ok:true, upserted}`；审计 `surface.ingest` | 兼容 |
| GET `/v1/surface-cache/policy?container=` | — | `200 {policy}` | 兼容 |
| POST `/v1/surface-cache/policy` | `{ container, orders:string, setBy? }` | `200 {policy}` / `404`（cache 未启用）；审计 `surface.policy.set` | 兼容 |

## admin（58 条，auth `either`；handler 内统一 `requireScopedAdmin`/`authorizeAdmin` → admin grant 必需，`?scope=` 缺失 → 400；无 admin 依赖 → 404 not_found；外层 `timed()` 记 `[admin] METHOD path status ms` 日志）

响应通式：`{ scopeId: scope, … }`；主轴是 `?scope=`（org/其他 scopeId）。

### 配置与 manifest

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/whoami` | — | `200 {…adminStatus, permissions[]}`（非 admin → `{isAdmin:false, permissions:[]}`） | 兼容 |
| GET `/v1/admin/scopes` | — | `200 {scopeId, scopes[], environments}` | 兼容 |
| GET `/v1/admin/scopes/:scope` | — | `200 {scopeId, …scope 配置态}`（config 未接线 404；scope 含 `/` 404） | 兼容 |
| PUT `/v1/admin/scopes/:scope/:resource` | 按 ADMIN_RESOURCES 描述符分派（getAdminResources 校验/执行） | `200 {ok:true, scopeId, resource}` / `400 {error:code}` / `404 unknown resource` | 兼容 |
| GET `/v1/admin/resources` | — | `200 {resources: adminResourceManifest()}` | 兼容 |
| GET `/v1/admin/retention` | — | `200 {scopeId, …report}`（非 org scope → 400） | 兼容 |
| POST `/v1/admin/scopes/:scope/auto-flagger/test` | draft（AutoFlaggerDraft）| `200 result` / `400`（非 org scope/解析失败）/ `501`（未接线） | 兼容 |

### 可观测

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/metrics` | `?scope=` | `200 {scopeId, …metrics 聚合}` | 兼容 |
| GET `/v1/admin/egress` | `?scope=` | `200 {scopeId, records, total, denied, hosts, bySource}` | 兼容 |
| GET `/v1/admin/runs` | `?scope=` | `200 {scopeId, active, runs[]}` | 兼容 |
| GET `/v1/admin/errors` | `?scope=` | `200 {scopeId, errors[]}` | 兼容 |
| GET `/v1/admin/audit` | `?scope=` | `200 {scopeId, events[]}` | 兼容 |

### sessions / slack-mirror

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/sessions` | `?scope=` | `200 {scopeId, …}`（sessions.ts:180） | 兼容 |
| GET `/v1/admin/sessions/:id` | `?turnSeq=int\|"orphan"` 可选 | `200 {session, requests[]}` / `400`（turnSeq 非法） | 兼容 |
| GET `/v1/admin/sessions/:id/llm` | — | `200 {…}`（sessions.ts:346） | 兼容 |
| GET `/v1/admin/deliveries/shadow` | `?scope=` | `200 {scopeId, shadow}` | 兼容 |
| GET `/v1/admin/slack-mirror` | `?scope=` | `200 {scopeId, containers}` | 兼容 |
| GET `/v1/admin/slack-mirror/messages` | `?container=` 或 `?q=`（二选一，否则 400） | `200 {scopeId, mode:"search"\|"timeline", messages, hasMore?, limit?}` | 兼容 |
| GET `/v1/admin/ambient-judgments` | `?scope=&id?&limit?` | `200 {scopeId, judgments[], counts:{act,ignore,fastlane}}` / `404`（单查未命中）；store 未接线 → 空集 | 兼容 |
| GET `/v1/admin/ack-emoji-picks` | `?scope=&id?&limit?` | `200 {scopeId, picks[], counts:{picked,declined}, hasMore, limit}` / `404`；store 未接线 → 空集 | 兼容 |

### files（admin 视角）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/files?scope=` | — | `200 {scopeId, files[]}`（store 未接线 → 空数组） | 兼容 |
| GET `/v1/admin/files/read?id=` | — | `200 {…}`（内容）/ `404` | 兼容 |
| GET `/v1/admin/files/download?id=` | — | `200 流` / `404` | 兼容 |
| POST `/v1/admin/files/upload` | `{ blobId, … }`（staged blob） | `200 {…}`（files.ts:157）/ `400`（缺 blobId）/ `404` staged 缺失 / `413` 超限 / `501` blob store 未接线 | 兼容 |

### artifacts（crons/deployments/skills/admin 视角）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/crons\|/v1/admin/deployments\|/v1/admin/skills`（match，3 路径） | `?scope=` | `200 {scopeId, crons[]}` / `{scopeId, deployments[]}` / `{scopeId, skills[]}` | 兼容 |
| PUT `/v1/admin/crons/:id/destination` | `{ destination?… }\|{destination:null}`（缺 key → 400 提示 use null to clear） | `200 {cron: updated}` | 兼容 |
| GET `/v1/admin/skills/:id` | — | `200 {…}`（artifacts.ts:139） | 兼容 |
| DELETE `/v1/admin/skills/:id` | — | `200 {ok:true}` | 兼容 |

### memory / sandbox

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/memory/scopes` | `?scope=` | `200 {scopeId, scopes[]}` | 兼容 |
| GET `/v1/admin/memory?scope=&…` | — | `200 {scopeId, content}` | 兼容 |
| PUT `/v1/admin/memory` | `{ …, content:string }` | `200 {ok:true, scopeId}` / `400` | 兼容 |
| GET `/v1/admin/sandbox-routes` | — | `200 {…}` / `404 {error:"not_supported"}` | 兼容 |
| POST `/v1/admin/sandbox-routes/:scopeId/migrate` | — | `200 result` / `400`（scopeId 非法/迁移条件不满足）/ `404 not_supported` / `409 migration_failed` | 兼容 |

### slack-installation / model-providers / custom-providers / mcp-servers / security

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/slack-installation` | — | `200 {…stored, source:"admin", createUrl}\|{configured:true, managed:false, source:"environment", createUrl}\|{…未配置}` / `404 {error:"not_configured"}` | 兼容 |
| PUT `/v1/admin/slack-installation` | installation 载荷 | `200 {…status, source:"admin"}` / `400 {error:"invalid_slack_installation"}` | 兼容 |
| DELETE `/v1/admin/slack-installation` | — | `200 {configured:false, managed:true, source:"admin"}` | 兼容 |
| GET `/v1/admin/slack-emoji` | — | `200 {emoji{}}` / `502 {error:"slack_error"\|"slack_unreachable"}` / `404 not_configured` | 兼容 |
| GET `/v1/admin/model-providers` | — | `200 {…provider 状态}`（model-providers.ts:61） | 兼容 |
| PUT `/v1/admin/model-providers/:provider` | `{ apiKey? }`（缺 → 400；provider 拒钥 → `400 {error:"invalid_api_key"}`） | `200 {ok:true, status}` | 兼容 |
| DELETE `/v1/admin/model-providers/:provider` | — | `200 {ok:true}` | 兼容 |
| GET `/v1/admin/custom-providers` | — | `200 {providers[]}` | 兼容 |
| PUT `/v1/admin/custom-providers/:provider` | `{ name, protocol, baseUrl, … }`（缺 → 400） | `200 {ok:true, status}` / `400`（校验/探测失败） | 兼容 |
| DELETE `/v1/admin/custom-providers/:provider` | — | `200 {ok:true}` / `404` | 兼容 |
| GET `/v1/admin/mcp-servers` | — | `200 {…}`（mcp-servers.ts:38，脱敏列表） | 兼容 |
| PUT `/v1/admin/mcp-servers/:id` | `{ name?, url, auth?:none\|bearer\|…（AUTH_MODES）, bearerToken?（bearer 必需）, … }` | `200 {ok:true, server(脱敏), tools?[]}` / `400`（url/auth 校验） | 兼容 |
| DELETE `/v1/admin/mcp-servers/:id` | — | `200 {ok:true}` / `404` | 兼容 |
| GET `/v1/admin/security/flags` | — | `200 {flags}` | 兼容 |
| POST `/v1/admin/security/release` | `{ sessionId }`（缺 → 400） | `200 {released:true, sessionId}` / `404` | 兼容 |

### users / directory / keychain / grants / external-users / impersonate

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/admin/users?scope=` | — | `200 {scopeId, users, grants, externalUsers, inviteEmail}` | 兼容 |
| GET `/v1/admin/users/:principalId` | — | `200 {scopeId, people, credentials, grants, asks, enabled}`（identity 未接线 → enabled:false 空集） | 兼容 |
| PUT `/v1/admin/users/:principalId/onboarding` | onboarding 状态 | `200 {ok:true, scopeId, status}` / `400` / `404`（identity 缺） | 兼容 |
| POST `/v1/admin/users/:principalId/reset` | — | `200 {ok:true, scopeId, deletedSessions}` / `404` | 兼容 |
| POST `/v1/admin/grants` | grant 载荷 | `200 {ok:true, grant}` / `400/403/409 {error:"grant_failed"}`（AdminError 映射：已是成员 409 ALREADY_A_MEMBER、外部 org admin 403、自持 grant 409） | 兼容 |
| DELETE `/v1/admin/grants/:principalId` | 校验载荷缺失 → 400 | `200 {ok:true}` / `400 {error:"revoke_failed"}` / `200 {ok:true, removed:false}`（tombstone 未过期 forget 窗口） | 兼容 |
| POST `/v1/admin/external-users` | 邀请载荷 | users.ts:413 / AdminError 映射 | 兼容 |
| DELETE `/v1/admin/external-users/:email` | — | `200 {ok:true, removed:bool}` / `404`（不存在）/ `403`（portal-only 场景）/ `409` HOLDS_OWN_GRANT | 兼容 |
| POST `/v1/admin/impersonate` | `{ target }`（缺 → 400；=自己 → 400） | `200 {ok:true, target, displayName}` | 兼容 |
| POST `/v1/admin/impersonate/stop` | — | `200 {ok:true}` | 兼容 |
| GET `/v1/admin/directory?q=` | — | `200 {members[]}`（无 q/directory → 空数组） | 兼容 |
| GET `/v1/admin/keychain?scope=` | — | users.ts listKeychainStatus（people/credentials/grants/asks 聚合，同 user detail 形状） | 兼容 |

## deployments（13 + 3 match；管理面 + 公开代理双车道）

代理车道（`BaseCtx`，raw 路由）：`GET /d/<slug>/**`（source 鉴权；域名/路径代理，owner shell HTML、portal session 门、request-access 投递 `deploy-access-request:<slug>:<sub>:<day>` 幂等）、`/v1/admin/deployments/:id/proxy/**`（source，admin 代理）、`isDeploymentGitRoute`（public；git http backend，git token 鉴权）。契约冻结点：路径形状 + 门控状态码（302/401 `{error:"unauthorized", loginUrl}`/`503` unavailable）。

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/deployments`（auth source） | `DeployInput`（isDeployInput；`createdBy` 须=capability.actorId\|actor.p → 否则 403） | `200 {deployment}` / `400 {error:"deploy_failed"}` | 兼容 |
| GET `/v1/deployments`（auth either） | viewer=capability\|actor\|?principalId | `200 {deployments[]}`（viewer 可见集 + 每项附 `gitUrl?`） | 兼容 |
| GET `/v1/deployments/:id`（auth either） | id=uuid 或 name | `200 {deployment(+gitUrl?)}` / `404` | 兼容 |
| GET `/v1/deployments/:id/fetch?path=&maxBytes=`（auth either；viewer 必需 → 401） | path 须安全绝对路径（400）；maxBytes 1..1MiB（缺省 256KiB） | `200 {status, contentType, body(utf8\|base64+encoding), truncated}` / `404`（不可达权限）/ `502 {error:"upstream_unreachable"}` | 兼容 |
| GET `/v1/deployments/:id/logs?tailLines=`（auth either；viewer 必需 → 401） | tailLines 1..2000（缺省 200） | `200 {logs}` / `{logs:null, message}`（无日志）/ `404` | 兼容 |
| GET `/v1/deployments/:id/git-url`（auth either） | — | `200 {url}`（gitUrlBase + token） | 兼容 |
| GET `/v1/deployments/:id/owner-url`（auth source） | — | `200 {…owner url（带 owner token）}` | 兼容 |
| POST `/v1/deployments/:id/share`（auth either，capability 必需 → 403） | `{ scope?\|recipient?, access?:"view"\|"manage"\|"none"（缺省 view） }`；target 歧义 → `409 {error:"ambiguous_recipient", candidates}`；无匹配 → `404 recipient_not_found` | `200 {ok, target:{scope,label}, access, reach, grantees[]}` / `400/403/404 share_failed` | 兼容 |
| POST `/v1/deployments/:id/rollback`（auth source） | `{ version:number }`（管理权校验 → 403） | `200 {ok:true}` / `400 rollback_failed` / `404` | 兼容 |
| POST `/v1/deployments/:id/redeploy`（auth source） | `{ entrypoint:string, files:[] }` | `200 {deployment}` / `400 deploy_failed` | 兼容 |
| POST `/v1/deployments/:id/archive`（auth either） | — | `200 {ok:true}` / `403 archive 权限` / `400 archive_failed` | 兼容 |
| POST `/v1/deployments/:id/restore`（auth either） | principalId=capability\|actor\|body | `200 {deployment(+permission:"write")}` / `400 restore_failed` | 兼容 |
| POST `/v1/deployments/:id/name`（auth either） | `{ name:string }` | `200 {deployment}` / `400 rename_failed` | 兼容 |
| POST `/v1/deployments/:id/display-name`（auth either） | `{ displayName:string }` | `200 {deployment}` / `400 display_name_failed` | 兼容 |

## deployment-layer（2 条，auth `source`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/deployment-layer` | — | `200 {contract:1, version, contentHash, updatedAt?, updatedBy?, status:"applied"\|"degraded", runtimeContentHash?, source, bundle?, resolved}`（无记录 → version:0 极简态）；store 未接线 404 | 兼容 |
| PUT `/v1/deployment-layer` | `{ contract:1, tools:[], skills:[] }` | `200 {ok:true, version, contentHash, durable, resolved}` / `202 {ok:true, status:"degraded", message, …}`（持久化降级）/ `400 {error:"invalid_deployment_layer"}` | 兼容 |

## connectors（8 + 1 match；OAuth 流 + token 注册）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/connectors/oauth/:provider/callback`（match，auth public） | `?code=&state=&error?` | `200 {ok:true, provider, principalId, hosts[]}` / `400 {error:"oauth_denied"\|"oauth_callback_failed"}` / `501 not_configured` | 兼容 |
| GET `/v1/connectors/oauth/:provider/start`（match，auth source） | `?principalId=&redirectUri=`（缺 → 400） | `200 {…authorizeUrl 等}`（connectors.ts:395）/ `404 unknown provider` / `501` | 兼容 |
| GET `/v1/connectors/oauth/status?principalId=`（auth source） | — | `200 {principalId, providers{}}` / `400` | 兼容 |
| POST `/v1/connectors/oauth/revoke`（auth either） | `{ principalId, provider?\|host? }`（缺 principalId+provider/host → 400） | `200 {ok:true, principalId, provider?, hosts?}` / `404 unknown provider` | 兼容 |
| POST `/v1/connectors/oauth/consent/mint`（auth `{aud:"oauth-consent"}` capability） | `{ provider, … }` | `200 {…consent link}`（connectors.ts:340）/ `400`（provider/payload 校验）/ `404 unknown provider` / `501 oauth_not_configured` | 兼容 |
| GET `/v1/connectors/oauth/consent/redeem/:linkId`（auth source；须 portal 登录 → 401） | — | `200 {status:"expired"\|"invalid"}\|{…connected}\|{status:"authorize", authorizeUrl}` / `400` / `501` | 兼容 |
| POST `/v1/connectors/token`（auth source） | `{ host, principalId, accessToken, expiresAt?… }`（缺 → 400；expiresAt 校验） | `200 {ok:true}` | 兼容 |
| GET `/v1/connectors/catalog`（auth source） | — | `200 {catalog: entries}` | 兼容 |

## webhooks（4 + 1 raw；清单/开关脱敏：`verification.secret → "***"`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/webhooks/incoming/:id`（raw，auth public） | 任意 body（超限 → 413） | `200 text/plain`（同步结果）/ `202 {ok:true}`（异步受理）/ `401 {error:"unauthorized"}`（签名校验失败）/ `404` | 兼容 |
| POST `/v1/webhooks`（auth either） | capability 模：`{ action, verification{scheme∈WEBHOOK_SCHEMES, secret}, filters?[{path, in[]}], destinationKey? }`；source 模：完整 `CreateWebhookInput`（ownerScopeId/owner/createdBy 必填） | `200 {webhook, url:<inboundUrl>}` / `400`（错误映射 bad_request/unknown_destination/webhook_create_failed） | 兼容 |
| GET `/v1/webhooks`（auth either） | viewer=capability\|actor\|?viewer | `200 {webhooks[]}`（可见集 + 每项附 url，secret 脱敏） | 兼容 |
| POST `/v1/webhooks/:id/disable`（auth either） | — | `200 {ok:true}` / `404`（非管理者且无身份 → 404；portal 调用者 → `403 "not your webhook"`） | 兼容 |
| POST `/v1/webhooks/:id/enable`（auth either） | 同上 | 同上 | 兼容 |

## blobs（2 条，raw `BaseCtx`；鉴权双模：blob-transfer capability token 或 source 签名）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/blobs` | 原始字节流；须 `x-content-sha256`（64 hex，除非带 capability header） | `200 {blobId, sizeBytes}` / `400 {error:"hash_mismatch"}` / `413 payload_too_large` / `403`（token 无效/scope 撤销）/ `501` | 兼容 |
| GET `/v1/blobs/:id` | — | `200 application/octet-stream 流` / `404` / `403` / `501` | 兼容 |

## session-state（1 条 raw，auth `source`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/session-state/events` | —（SSE） | `200 text/event-stream`：`event: session_state` + JSON data；25s `: ping` 心跳；断开即 unsubscribe。qm-next packages/runs session-state-bus 已实现等价事件 | 兼容 |

## environments（3 条，auth `either`，强制 capability → 403）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/environments` | — | `200 {environments:[{id, name, ownerActorId, attachedScopes[]}]}` | 兼容 |
| POST `/v1/environments` | `{ name:string }` | `200 {environment:{id, name, ownerActorId}}` / `400 environment_create_failed` | 兼容 |
| POST `/v1/environments/attach` | `{ name:string }`（按名解析 → `404 {error:"environment_not_found"}`；他人拥有 → `403 {error:"owner_mediation_required", ownerActorId}`） | `200 {ok:true, environment:{id, name}}` / `400 environment_attach_failed` | 兼容 |

## projects（7 条，auth `either`；capability 模 principalId 锁定 actorId，传他人 → 404）

mutation 共用错误映射：`404 not_found` / `403 forbidden`（capability 调用者降级 404 not_found）/ `400 {error:"invalid_name"}` / `400 {error:"invalid_channel"}` / `409 {error:"channel_in_use"}` / `400 {error:"invalid_member"}`。

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/projects?principalId=` | — | `200 {projects[]}` | 兼容 |
| POST `/v1/projects` | `{ principalId, name }` | `201 {project}` / `403` / `400` | 兼容 |
| PATCH `/v1/projects/:id` | `{ principalId, name }` | `200 {project}` / 错误映射 | 兼容 |
| POST `/v1/projects/:id/members` | `{ principalId, memberId }` | `200 {project}` / 错误映射 | 兼容 |
| DELETE `/v1/projects/:id/members/:memberId` | `{ principalId }` | `200 {project}` / 错误映射 | 兼容 |
| PUT `/v1/projects/:id/slack-channel` | `{ principalId, channel }` | `200 {project}` / 错误映射 | 兼容 |
| DELETE `/v1/projects/:id/slack-channel` | `{ principalId }` | `200 {project}` / 错误映射 | 兼容 |

## skill-packs（7 条，auth `either`；handler 内 authorizeAdmin(org scope)；全部记审计 `skill_pack.*`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/admin/skill-packs` | `{ url:string, ref?, subset?:"all"\|string[], trustTier?:"internal"\|"third-party"（缺省 third-party）, config?{skillGlobs?,exclude?,fieldOverrides?}, authCredentialSlug? }`（syncMode 固定 "pinned"，targetScopeId=org） | `200 {pack}` / `400`（url/subset 校验） | 兼容 |
| GET `/v1/admin/skill-packs` | — | `200 {packs[]（附 importedCount）}`；审计 `skill_packs.read` | 兼容 |
| GET `/v1/admin/skill-packs/:id/catalog` | — | `200 catalog plan`（透传） | 兼容 |
| POST `/v1/admin/skill-packs/:id/import` | `{ selected:"all"\|string[], scopeIds?: "kind:ref"[]（去重） }` | `200 import result` / `400`（selected/scopeIds 校验） | 兼容 |
| POST `/v1/admin/skill-packs/:id/sync` | — | `200 sync result` | 兼容 |
| PATCH `/v1/admin/skill-packs/:id` | `{ ref?, url?, trustTier?, syncMode?:"pinned"\|"tracked", subset?, config? }` | `200 {pack}` / `400` | 兼容 |
| DELETE `/v1/admin/skill-packs/:id` | — | `200 remove result` | 兼容 |

## user-model-auth（7 条，auth `source`；身份 = portal actor（`ctx.actor.p`），无 → 401 unauthorized）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/v1/user-model-auth/status` | — | `200 {individualModelAuth:boolean, connections[]}`（store 缺 → connections 空数组） | 兼容 |
| POST `/v1/user-model-auth/api-key` | `{ provider:"claude"\|"chatgpt"（含别名 anthropic/openai/codex）, apiKey }`（provider 归一 anthropic\|openai；provider 拒钥 → `400 {error:"invalid_api_key"}`） | `200 {ok:true}`；审计 `user-model-auth.api-key` | 兼容 |
| POST `/v1/user-model-auth/disconnect` | `{ provider }` | `200 {ok:true}` / `400`；审计 `user-model-auth.disconnect` | 兼容 |
| POST `/v1/user-model-auth/chatgpt/start` | — | `200 device-login prompt（透传 codex device login）` / `502 {error:"oauth_start_failed"}` | 兼容 |
| POST `/v1/user-model-auth/chatgpt/poll` | `{ deviceAuthId }` | `200 {status:"pending"}\|{status:"connected"}` / `400` / `502 {error:"oauth_poll_failed"}`；成功审计 `user-model-auth.oauth` | 兼容 |
| POST `/v1/user-model-auth/claude/start` | — | `200 startClaudeLogin()（PKCE 参数透传）` | 兼容 |
| POST `/v1/user-model-auth/claude/complete` | `{ code, verifier }` | `200 {ok:true}` / `400` / `502 {error:"oauth_complete_failed"}`；审计 `user-model-auth.oauth` | 兼容 |

## credentials（1 条，auth `{aud:"credential-broker"}`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/credentials/broker` | body 透传 brokerCredentialCall | result.status + result.json 透传（serviceCreds 未接线 → 404）；记 credentialUsage + 审计 | 兼容 |

## secret-drop（3 条；凭据"投放链接"流：agent 发链接 → 人填表 → 自动入 keychain）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/keychain/drops`（auth either，强制 capability → 401；triggered → 403） | `{ title?, purpose?, fields?: SecretDropField[], grantMode:"once"\|"standing" }`（capability secret 缺失 → `500 {error:"misconfigured"}`） | `200 {dropId, formPath, url:<完整链接>}` / `400`（fields/grantMode 校验） | 兼容 |
| GET `/v1/keychain/drops/:id/form`（auth source） | — | `200 text/html`（dropFormHtml 表单）/ `404`（过期/非本 org/非本人 → 各形态 404） | 兼容 |
| POST `/v1/keychain/drops/:id`（auth source） | `{ secret }\|{ fields:{key:value,…} }`（缺值 → 400 逐字段提示） | `200 {ok:true, credential: meta}` / `404`（失效/跨 org）/ `403`（scope 未授权）/ `409`（重复使用）；KeychainError → `{error:"keychain"}` | 兼容 |

## emoji（1 条，auth `either`，强制 capability → 401）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/emoji` | `{ name:string, image:base64 PNG/GIF, workspace? }` | `200 upload result` / `422`（上传失败，透传 runEmojiUpload）/ `404 {error:"not_supported"}`（browser session store 未接线） | 兼容 |

## egress-audit（1 条，auth `source`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/egress-audit` | `{ records:[1..500]{ host, verdict, via?, peerIp?, principalId?, scopeLabel?, port?(1..65535) } }`（字段截断 512 字符；verdict==="ok" → allowed；非法记录静默拒绝） | `200 {accepted, rejected}` / `400` / `501 {error:"not_configured"}` | 兼容 |

## auth-broker（2 条，auth `source`）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| POST `/v1/auth/broker/claim` | `{ ids:string[1..64]（每项 ≤200 字符）, expiresAtMs（未来、≤24h） }` | `200 {claimed:id\|null}`（单次性 nonce 认领；replay store 非持久 → `503 {error:"not_configured"}`） | 兼容 |
| GET `/v1/auth/broker/email-allowed?email=` | — | `200 {allowed:boolean, expiresAt?}`（identity 未接线 → allowed:false） | 兼容 |

## index（单条 + 前缀车道）

| 路由 | 请求 | 响应 | 级别 |
|------|------|------|------|
| GET `/healthz`（auth public） | — | `200 {ok:true}` | 兼容 |
| `(GET\|POST) <GIT_HTTP_BROKER_PREFIX>/**`（auth `{aud:"credential-broker"}`） | git http 协议透传 brokerGitHttp | git 协议响应 | 兼容 |

## 汇总（2026-09-14）

- 已登记模块（26 文件 / 27 路由组）：turns 12、directory 5、reach 1、crons 7+1、keychain 11、
  search 1、context 4、context-policy 2、surface 47+2、surface-cache 3、admin 58、
  deployments 13+3、deployment-layer 2、connectors 8+1、webhooks 4+1、blobs 2、
  session-state 1、environments 3、projects 7、skill-packs 7、user-model-auth 7、
  credentials 1、secret-drop 3、emoji 1、egress-audit 1、auth-broker 2、index 2。计 ~242 条。
- 级别分布：全部 **兼容**（0 子集 / 0 重设计）——lane A 落地时若某路由降级为子集/重设计，
  在本文件该行改级别并记 parity-deviations.md。
- lane A（任务 11.0）落地顺序建议：按本文件模块顺序逐模块移植；优先 turns/runs（已有
  packages/runs 契约）、keychain、surface conversations/sessions（web-ui 后端化的前置）。
