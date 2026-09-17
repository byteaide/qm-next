# i18n 方案:中英文切换(全前端词表)

Status: PROPOSED — 基于 2026-09-17 对消息流的实测盘点(本文所有数字均来自
当日 `rg` 扫描,可复现)。目标拍板:所有 i18n 放前端,后端契约零改动。

## 1. 目标与非目标

**目标**

- 主 Web UI(`packages/web-ui/app`)支持中文/英文切换,设置项持久化,切换即时生效
- 后端返回的错误消息在前端按机器码翻译,后端不改一行
- Portal 服务端页面(`packages/portal`)跟随语言
- 无障碍属性(aria-label/title/placeholder)一并翻译

**非目标(明确不做)**

- Agent/LLM 输出内容的语言(属 agent persona/语言策略,另立任务)
- IM 面(feishu)消息文案
- Admin 控制台(`packages/api/admin-ui/index.html`,单文件 14.9k 行、~228 处英文)
  ——列为本方案 Phase 5 备选,不阻塞主线
- LLM 供应商透传错误正文的翻译(原文保留,见 §4.3 兜底)

## 2. 现状盘点(证据)

UI 面三块:

| UI 面 | 位置 | 技术 | 英文规模 |
|---|---|---|---|
| 主 Chat SPA | `packages/web-ui/app/src`(~65 文件) | Lit 3 + Vite | ~145 属性文案 + ~263 内联文本 + ~150 状态字符串,估 500~700 条 |
| Portal 登录/管理页 | `packages/portal/src/portal-routes.ts` | Fastify 服务端 HTML | ~15 条 |
| Admin 控制台 | `packages/api/admin-ui/index.html` | 单文件 SPA(Phase 5) | ~228 处 |

**消息流(错误路径,实测)**:

```
后端  packages/api/src/routes/framework.ts:53   badRequest → { error:'<code>', message:'<英文>' }
拦截  packages/web-ui/app/src/core-bridge.ts:508  ApiError(message, status, body) — body 已完整携带
展示  packages/web-ui/chassis/src/errors.ts:1     errMessage(e, fallback) 优先返回 e.message
```

**后端消息全量盘点结论**:

- api 包 **226 个 4xx/5xx 响应,100% 携带机器码**,共 **61 个不同 code**
  (通用码 ~196 处/87%:`bad_request` 64、`not_found` 54、`forbidden` 36、
  `unauthorized` 21、`capability_required` 11、`not_configured` 10…;
  业务专属码 ~60 处:`deploy_failed`、`oauth_denied`、`pack_collision`、
  `model_not_supported`、`harness_not_approved`、`rate_limited`…)
- web-ui 薄服务层(`web-ui/src/server.ts`,~30 个)与 portal(~9 个)同样 100% 带码
- 路由未使用 Fastify schema 校验,不存在 Fastify 内建错误形状混入
- 例外形状(前端按结构处理,不展示原文):`{error:'sign in', mode, reason}`
  (server.ts:223,触发重登录)、`{error:'conflict', reason}`(server.ts:406)
- 运行时 turn 失败:SSE `system` 事件 `kind:'turn_failure'` + 自由文本 message,
  来源 `packages/harness-pi/src/pi-harness.ts:808-828`(harness 模板 + LLM 供应商透传)

## 3. 方案选型

选定:**轻量自研 `t()` + Lit ReactiveController + en 原文作 key**,复刻
`packages/web-ui/app/src/theme.ts` 的既有模式(localStorage 持久化 + apply +
index.html 预绘制脚本)。

落选及理由:

- `@lit/localize`:官方方案,但 XLIFF 工作流 + 构建 codegen 对"双语言、AI 维护、
  无外部翻译团队"是重负担;本方案 msgid 模型与其一致,将来需要多语言/翻译供应商
  时可机械迁移
- i18next:对 Lit 无感知,双语言场景功能过剩
- 后端按 locale 出翻译:违背"i18n 全前端"目标,且 api 消费方不止 web-ui,
  英文 message 兼作调试契约,不动

## 4. 设计

### 4.1 前端基建(新增 `packages/web-ui/app/src/i18n/`)

```
i18n/
  index.ts        # Locale 类型、当前 locale 状态、t()、LocaleController、切换事件
  ui.en.ts        # 界面词表英文(en 原文即 key,无需英文文件时可省——直接以 key 为文案)
  ui.zh.ts        # 界面词表中文,按页面 namespace 分组(chats/composer/sessions/...)
  errors.en.ts    # 错误码 → 英文(可选,默认回退响应原文)
  errors.zh.ts    # 61 个错误码 → 中文
```

- `t(key, params?)`:`{name}` 占位符插值,覆盖 `"Open the ${o.crumb} project"`
  类模板(`session-scope.ts:104`);提供极简 `tPlural(count, one, other)` 处理英文复数
- 词表为 TS 对象,`satisfies Record<string, string>` 类型约束;CI 测试校验
  en/zh key 全对齐(防漂移)
- `LocaleController(host)`:~30 行 ReactiveController,订阅 locale 变更事件触发
  `host.requestUpdate()` —— Lit 切语言即时重渲染的标准做法
- 持久化完全照抄 theme.ts:localStorage `qm.locale`;首次默认
  `navigator.language` 以 `zh*` 开头 → `zh`,否则 `en`;切换时同步
  `document.documentElement.lang`;`index.html` 加预绘制内联脚本(对齐 theme 的
  预绘制注释约定)
- 切换入口:composer 会话设置菜单,紧邻 theme toggle(`shell.ts:472`);
  `document-title.ts` 的 `VIEW_TITLES`(10 条)改为 t() 求值并监听 locale 变更刷新

### 4.2 错误消息映射(前端拦截,后端零改动)

- `core-bridge.ts` `api()`(唯一改动点):构造 `ApiError` 时新增
  `displayMessage = errors[body.error] ?? message`;原始 message 保留
- `errMessage(e)`(chassis/errors.ts):`ApiError` 分支返回 `displayMessage`;
  原始英文 message 转 `console.debug` 供调试
- 词表策略:
  - 专属码(~60 个)→ 精确中文文案(deploy_failed → "部署失败"等)
  - 通用码(~10 个)→ 泛化文案(bad_request → "请求无效",not_found → "资源不存在");
    64 条 bad_request 下的具体参数细节属开发者向信息,原文进 console.debug
  - web-ui 薄服务层与 portal 的码并入同一张表(形状一致)
- 已知权衡:87% 响应为通用码,映射后文案泛化。UX 关键业务错误恰好都有专属码,
  实际体验影响集中在参数校验类提示;后续可选(不阻塞):后端把高频 bad_request
  场景细化出新码,前端词表跟随

### 4.3 turn_failure(运行时失败)

message 两类来源(pi-harness.ts:808-828):

- harness 模板("Pi agent stopped with an error")→ 前端精确匹配映射
- 供应商透传 `Model provider API error (<type>): <text>` → 解析出 type,
  常见 type(quota/rate_limit/content_filter/overloaded)映射中文模板;
  无法识别的 type 与透传正文保留原文次级展示(timeline 错误行的详情/折叠区),
  console.debug 全文

### 4.4 Portal(服务端 HTML)

- SPA 切换语言时写 cookie `qm.locale`(portal 与 SPA 同域)
- portal-routes.ts 模板按 cookie 取词表,缺省回退 `Accept-Language`,再回退 en
- ~15 条文案,独立小词表模块放 portal 包内;页面 `<html lang>` 同步

### 4.5 日期/数字

`cron-format.ts`、`toLocaleString` 调用点传入已解析 locale;随 Phase 3 各文件
清扫顺带处理,不单独立项。

## 5. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 基建 | i18n/ 目录、t()、LocaleController、qm.locale 持久化、预绘制脚本、设置菜单切换器 | 切换语言即时生效并持久化;`<html lang>` 跟随;刷新后保持 |
| P2 错误通道 | errors 词表(61 码)、api() displayMessage、errMessage 改造、turn_failure/type 映射 | 401/404/bad_request/业务专属码错误横幅全中文;英文原文仅 console |
| P3 静态文案清扫 | document-title → 按文件从大到小:chat(86)、contexts(52)、composer(45)、sessions(43)、deploys(41)、crons(35)、skills(33)、connectors(28)、其余;含 aria/placeholder 与日期 locale | 模板内 `rg '>[A-Z][a-z]+ [a-z]+'` 与 `"(title\|aria-label\|placeholder)="\[A-Z\]` 命中 ≈ 0(注释除外) |
| P4 Portal + 防漂移 | portal cookie/词表;en/zh key 对齐测试;残留英文扫描脚本进 CI | portal 页面跟随语言;词表对齐测试绿 |
| P5(备选) | Admin 控制台(index.html 14.9k 行) | 另立方案,不复用本文件范围 |

估算:P1+P2 合计约 1~1.5 天;P3 为体力清扫,约 2~3 天(AI 可批量执行,
每文件提交粒度,便于 review 与回滚)。

## 6. 风险与后续

- **通用码泛化**:见 §4.2 权衡;观察实际使用反馈,必要时推动后端细化高频码
- **词表漂移**:key 对齐测试 + P3 验收扫描双保险;新文案评审时要求走 t()
- **@lit/localize 迁移**:本方案 msgid 模型与之一致,若未来需要多语言/翻译
  供应商,迁移为机械替换(t() → msg())
- **agent 输出语言**:与本方案解耦;若需要"agent 跟随界面语言",在 orchestrator
  的 turn 请求附语言提示,另立任务
