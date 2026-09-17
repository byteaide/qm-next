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
  ui.en.ts        # 界面词表英文(en 原文即 key)。必须存在:作为单一事实源,
                  # 模板里的 key 必须在此登记,parity 测试才有意义
  ui.zh.ts        # 界面词表中文,按页面 namespace 分组(chats/composer/sessions/...)
  errors.zh.ts    # 错误码 → 中文(61 码;查不到的码回退后端原文)
```

- `t(key, params?)`:`{name}` 占位符插值,覆盖 `"Open the ${o.crumb} project"`
  类模板(`session-scope.ts:104`);提供极简 `tPlural(count, one, other)` 处理英文复数
- 词表为 TS 对象,`satisfies Record<string, string>` 类型约束;类型层面由
  `ui.zh.ts satisfies Record<keyof typeof uiEn, string>` 强制 zh 覆盖全部 en key,
  另有 node:test 对齐测试双保险(P4)
- 依赖方向:`i18n/` 不导入 `core-bridge.ts` 等上层模块(词表是叶子模块);
  `core-bridge.ts` 可以导入 `i18n/`
- 重渲染机制(P1 实现修正):本 app 是 lit-html 命令式 `render()`,**无
  LitElement 类**,ReactiveController 方案不适用。改为 `onLocaleChange(fn)`
  订阅 + `main.ts` 注册全量重绘(chrome/会话列表/打开的会话/`refreshActiveView`
  /`syncDocumentTitle`);文本一律渲染时经 `t()` 求值,重绘即生效
- 持久化完全照抄 theme.ts:localStorage `qm.locale`;首次默认
  `navigator.language` 以 `zh*` 开头 → `zh`,否则 `en`;切换时同步
  `document.documentElement.lang`;`index.html` 加预绘制内联脚本(对齐 theme 的
  预绘制注释约定)
- 切换入口:sidebar footer,紧邻 theme toggle(实测点;原拟 composer 会话菜单,
  实现取 theme toggle 同排更显眼);`document-title.ts` 的 `VIEW_TITLES`
  改为渲染时 t() 求值

### 4.2 错误消息映射(前端拦截,后端零改动)

- `core-bridge.ts` `api()`(唯一改动点):构造 `ApiError` 时新增
  `displayMessage = errors[body.error] ?? message`;原始 message 保留
- `errMessage(e)`(chassis/errors.ts):返回值优先取错误对象上的
  `displayMessage` 属性(**结构性检查**,不 import ApiError 类型——chassis 是被
  core-bridge 依赖的底层模块,反向导入会成环);原始英文 message 转
  `console.debug` 供调试。改动 ~4 行;chassis 源自 qm 上游 vendored
  (plugins/chassis,原逐字节相同),此处为记录在案的有意分叉
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

- SPA 切换语言时写 cookie `qm.locale`(portal 与 SPA 同源,均注册在同一
  Fastify app 上,cookie 直接可读;portal 已有 `cookieDomain` 机制可复用)
- portal-routes.ts 模板按 cookie 取词表,缺省回退 `Accept-Language`,再回退 en
- ~15 条文案,独立小词表模块放 portal 包内;页面 `<html lang>`
  (portal-routes.ts:221)按所选 locale 输出
- 约束:portal 登录页 CSP 按 sha256 校验内联脚本(admin-login.test.ts:60),
  i18n 只改文本节点,**不得改动内联脚本**,否则要重算 hash

### 4.5 已知不可译范围(明示)

- `@earendil-works/pi-web-ui`(npm 依赖,0.75.3)组件内部自带的英文文案
  不在本方案范围内——外部包内部不可注入词表;本方案只负责我们自己渲染的文本。
  实际影响面小(设计系统组件多为结构元素),若发现用户可见的英文残留再单独评估
- LLM/agent 输出内容(见 §1 非目标)

### 4.6 日期/数字

`cron-format.ts:87,97` 现用 `toLocaleDateString([])`(空数组 = 浏览器默认
locale)——日期已部分跟随环境,但与应用内切换器不一致。P3 统一改为传入
已解析的应用 locale;随清扫顺带处理,不单独立项。

### 4.7 前端 UI 影响评估(逐项实测)

| 检查项 | 实测结果 | 结论 |
|---|---|---|
| 字体栈 | index.html `14.5px/1.6 ui-sans-serif, system-ui, …`,无显式 CJK 字体 | `system-ui` 自动回退系统中文字体(macOS PingFang SC / Windows 微软雅黑 / Linux Noto CJK);line-height 1.6 对 CJK 足够。**不改字体栈**,P1 演示确认粗体/中英混排渲染 |
| 文本溢出 | chat/shell/sessions/contexts/deploys 五个最大文件 **0 处** `nowrap/ellipsis/text-transform`(grep 验证;chat.ts 的 "truncated" 命中均为 JS 变量名非 CSS) | 布局全弹性、无硬截断装饰;中英互切宽度变化由 flex 吸收,**低风险** |
| 中文输入(IME) | `composer.ts:1223` 已正确处理组合键(`isComposing \|\| keyCode===229` 不发送) | 现有中文输入路径完好且已被考虑过(Safari 特例有注释),i18n 改造不触碰输入逻辑 |
| 无障碍 | ~145 处 aria-label/title/placeholder 与可见文案同源翻译;`<html lang>` 随 locale 切换 | 屏幕阅读器发音随 lang 正确;翻译与视觉文案同批进行,无额外风险 |
| 混排(UI 中文 + agent 英文输出) | agent 输出语言独立于 UI locale(§1 非目标) | 预期行为,不做混排排版优化 |
| 主题 | 词表为纯文案,不涉 CSS 变量;预绘制脚本同时处理 theme+locale | 深/浅主题 × 中/英四组合纳入演示矩阵 |

## 5. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 基建 | i18n/ 目录、t()、onLocaleChange 重绘、qm.locale 持久化、预绘制脚本、sidebar 切换器 | `pnpm --filter @qm/web-ui typecheck:app` 绿;浏览器实测:切换即时生效并持久化、`<html lang>` 跟随、刷新后保持(P1 已完成,见 §7) |
| P2 错误通道 | errors 词表(61 码)、api() displayMessage、errMessage 改造(~4 行,结构性检查)、turn_failure/type 映射 | 浏览器验证 401/404/bad_request/业务专属码错误横幅全中文;英文原文仅 console.debug |
| P3 静态文案清扫 | document-title → 按文件从大到小:chat(86)、contexts(52)、composer(45)、sessions(43)、deploys(41)、crons(35)、skills(33)、connectors(28)、其余;含 aria/placeholder 与日期 locale | `rg '>[A-Z][a-z]+ [a-z]+'` 与 `"(title\|aria-label\|placeholder)="\[A-Z\]` 命中人工核对后无真实文案残留(扫描有误报,如代码示例文本);每文件提交粒度 |
| P4 Portal + 防漂移 | portal cookie/词表(不动内联脚本);en/zh key 对齐测试;残留英文扫描 | portal 页面跟随语言;`pnpm test` 全绿(含新增 i18n 对齐测试) |
| P5(备选) | Admin 控制台(index.html 14.9k 行) | 另立方案,不复用本文件范围 |

估算:P1+P2 合计约 1~1.5 天;P3 为体力清扫,约 2~3 天(AI 可批量执行,
每文件提交粒度,便于 review 与回滚);P4 约 0.5 天。

## 5.1 测试与质量门(影响范围评估结论)

- **现有测试全部不受影响**:后端各包与 portal 的测试(node:test,
  `packages/*/tests/*.test.ts`)断言的是状态码/响应头/cookie/数据形状,
  不断言英文文案;后端代码零改动。portal 登录页测试校验 CSP hash——P4 不动
  内联脚本即不受影响
- **前端现状零测试**:app/ 无测试目录,仓库无 Lit 组件测试基建。本方案**不引入**
  组件测试框架(避免新增重依赖);防漂移靠:类型约束(zh 覆盖全部 en key)+
  新增 `packages/web-ui/tests/i18n.test.ts`(node:test,校验词表对齐与 t() 形状,
  node 可直接 import TS 词表)+ P3 扫描
- **质量门**:`typecheck:app`(tsc -p tsconfig.app.json --noEmit,已存在的
  script)每阶段必跑;`pnpm test` 在 P4 后全量跑;`vite build` 确认产物正常
- **文档**:本文件随评审修订;P3 收尾时在项目 AGENTS.md 补一条约定
  "新增 UI 文案必须走 t(),不得在模板里裸写英文"(后续项,不阻塞)

## 5.2 评审规范(每阶段强制)

**自检清单(每个提交批次,提交前逐项勾)**

1. 模板内无新增裸英文:改动文件的 html`` 模板经 `rg '>[A-Z][a-z]+ [a-z]+'`
   与 `"(title|aria-label|placeholder)="\[A-Z\]` 复扫,命中逐条核对
2. 每个新 key 同时登记于 `ui.en.ts` 与 `ui.zh.ts`(类型约束兜底,但人工确认
   中文是翻译不是复制);插值 key 与模板调用处参数一一对应
3. `pnpm --filter @qm/web-ui typecheck:app` 绿
4. 改动不触碰:后端包、`vite.config.ts`、`index.html` 预绘制脚本语义
   (只允许追加 locale 分支)、portal 内联脚本

**独立评审(P2 必须,P3 抽查)**

- P2 改 `chassis/errors.ts` + `core-bridge.ts`(行为变更、68 个调用点波及),
  按仓库规范**不得自审**:须派未参与实现的独立 review agent 审 diff,
  重点:结构性检查不破坏非 ApiError 错误路径、console.debug 不泄敏感信息、
  词表查不到码时的回退正确
- P3 机械清扫按文件批次抽查 ≥20%(review agent 或人工),核对:key 语义、
  插值完整性、误翻译(如把代码/命令文本当文案)

**UI 演示证据(每阶段,参照上游"Demo every front-end change"规范)**

- 演示矩阵:中/英 × 浅/深主题,关键视图 = chat(含转录)、composer、
  sessions 列表、设置菜单(切换器)、P2 另加错误横幅(401/404/业务码)
- 证据形式:vite dev 实操说明 + 截图(最长边 ≤1568px);截图先经文件名
  清洗(macOS U+202F 问题)
- 验收分工:UI 呈现由用户拍板;代码正确性由独立评审把关;两关都过才算阶段完成

## 6. 风险与后续

- **通用码泛化**:见 §4.2 权衡;观察实际使用反馈,必要时推动后端细化高频码
- **词表漂移**:key 对齐测试 + P3 验收扫描双保险;新文案评审时要求走 t()
- **@lit/localize 迁移**:本方案 msgid 模型与之一致,若未来需要多语言/翻译
  供应商,迁移为机械替换(t() → msg())
- **agent 输出语言**:与本方案解耦;若需要"agent 跟随界面语言",在 orchestrator
  的 turn 请求附语言提示,另立任务

## 7. 实施记录

### P1 基建(已完成)

改动:`app/src/i18n/`(index.ts / ui.en.ts / ui.zh.ts)、`app/index.html`
(locale 预绘制脚本)、`shell.ts`(sidebar 切换器 + 导出 refreshActiveView)、
`main.ts`(applyLocale + onLocaleChange 全量重绘)、`document-title.ts`
(VIEW_TITLES 渲染时 t())。

验证(浏览器实测,scripts/dev-web-ui.ts 本地栈,portal 前门加载 SPA):

- 切换即时生效:标题双向翻转("聊天 · QM · Web" ⇄ "Chats · QM · Web"),
  切换器 title/glyph 同步(切换到英文 ⇄ Switch to Chinese,中 ⇄ EN)
- `<html lang>` 跟随:`zh-CN` ⇄ `en`
- 持久化:localStorage `qm.locale` 写入正确;刷新后 locale/lang 保持
  (预绘制脚本生效)
- `typecheck:app` 绿;`vite build` 通过;浏览器 console 0 error
- 首访无 localStorage 时按 `navigator.language` 检测(zh 浏览器直接得中文界面)

### P2 错误通道(已完成)

改动:新增 `app/src/i18n/errors.ts`(82 码错误词表 + `localizeTurnError`)、
`tests/i18n.test.ts`(词表对齐 + 行为测试);`core-bridge.ts`(`ApiError`
增加 `errorCode` 与 `displayMessage` getter,`api()` 挂码)、
`chassis/src/errors.ts`(`errMessage` 结构性读取 `displayMessage`,~6 行,
记录在案分叉)、`chat.ts`(3 个渲染点接 `localizeTurnError`)、
`model-connect.ts`(`friendly()` 三条文案走 t())。

验证:

- `typecheck:app` 绿;i18n 测试 5/5;既有 web-ui 测试 15/15 无回归
- 浏览器实测(portal 前门):拦截 `/api/crons` 返回 404 `not_found` 后,
  zh 界面错误横幅显示"资源不存在"(无英文泄漏),console.debug 记录原始
  消息;切 en 显示原始码;**不刷新**来回切换 locale,横幅即时重绘
- turn_failure/provider type 映射由单元测试覆盖(rate_limit_error、
  insufficient_quota、未知 type 透传)

独立评审(fresh-context,§5.2 P2 强制项):**APPROVE**,4 条发现已全部修复
——chat.ts 两处 `err.message` 改走 `errMessage`(approval/reconnect 错误
接入本地化)、console.debug 加 zh 条件、补 reach 包 7 个码
(not_a_member/ambiguous_recipient/channel_not_found/ambiguous_channel/
group_too_large/group_not_found/group_open_failed)、收紧 provider type
auth 正则(避免 authorization_pending 误判)。

已知限制:catch 时即烘进 state 的错误字符串(如 composer 报错)在 locale
切换后保持原语言,下次同类错误生效;错误对象经 `displayMessage` getter
的路径不受影响。

### P3 静态文案清扫(进行中——sessions.ts 试点完成)

第一批改:`packages/web-ui/app/src/sessions.ts`(57 行命中估算中
~30 实际翻译文本,涵盖分组标题/操作菜单/空态/搜索/状态指示/重命名/
批量操作/颜色/多选;共新增 30 个 ui key,登记于 `ui.en.ts` + `ui.zh.ts`,
`{name}` / `{n}` / `{c}` 占位走 `t()` 插值,`s.pinned ? t("Unpin") : t("Pin")`
等三元全部改为 t() 形式)。其余文件(contexts/composer/chat/deploys/
crons/skills/connectors 等)按相同流程,每文件一提交。

验证:

- `typecheck:app` 绿;`vite build` 通过;i18n 测试 5/5;web-ui 既有测试
  15/15 全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:52242,dev 栈):
  - zh 状态:`region "Personal 项目"` / `button "Personal 的操作"` /
    `button "在 Personal 中发起新聊天"` / `暂无会话。`
  - 切 en(无需刷新):`region "Personal project"` / `button "Options for Personal"` /
    `button "New chat in Personal"` / `No conversations yet.`
  - 截图:`i18n-p3-sessions-zh.png` / `i18n-p3-sessions-en.png`
- main.ts onLocaleChange 已挂监听(renderList + conv.redraw +
  refreshActiveView),新文案由 t() 在 render 时解析,自动响应 locale 切换,
  sessions.ts 内部无需独立挂监听(本文件 import 已精简为 `t` 单导出)
