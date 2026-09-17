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

第二批改:`packages/web-ui/app/src/contexts.ts`(原估 52,实 60+ 处命中,
含上下文元信息/过滤菜单/项目列表/项目详情/项目成员/Slack 链接/
资源分组/创建项目弹窗/错误提示等;共新增 36 个 ui key,登记于
`ui.en.ts` + `ui.zh.ts`,复用 P3 sessions 已加的 `Personal` / `Channel` /
`Group DM` / `New chat` / `Projects` / `Files` / `Skills` / `Crons` /
`Webhooks` / `Apps` / `Slack` / `Show` / `Search` / `Close` / `Cancel` /
`Disable` / `Enable` / `New project` / `Owner` / `Read-only` 等 key;
占位串 `{title}` / `{label}` / `{channel}` / `{q}` 走 `t()` 插值;
`c.enabled ? t("Disable") : t("Enable")` 三元改为 t() 形式;复用 P1
view title `Projects` 不重复登记)。

验证:

- `typecheck:app` 绿;`vite build` 通过;i18n 测试 5/5;web-ui 既有测试
  15/15 全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:52583,dev 栈 `/contexts` 路由):
  - zh:`项目` 标题、`刷新项目` / `新建项目` 按钮、`搜索项目` searchbox、
    `显示` 标签、上下文行 `个人`
  - en(不刷新):`Projects` / `Refresh projects` / `New project` /
    `Search projects` / `Show` / `Personal`
  - 截图:`i18n-p3-contexts-zh.png` / `i18n-p3-contexts-en.png`

第三批改:`packages/web-ui/app/src/composer.ts`(原估 45,实 52 命中;
含 Fast mode / placeholder / Settings 面板 / Make default / Upgrade /
粘贴文本弹窗 / Send / Stop / Queue / 排队列表 / 审批面板 / slash 菜单
/ 错误文案 等;共新增 60 个 ui key,登记于 `ui.en.ts` + `ui.zh.ts`,
复用 P3 已加的 `Files` / `Skills` / `Model`(shell 区域仍 zhs="模型"/
"Harness"="代理" / "Effort"="投入度") / `Close` / `Remove` /
`New chat` 等;占位串 `{summary}` / `{model}` 走 `t()` 插值,`{summary}`
例:`Session settings — Opus 5 · Low` zh=`会话设置——Opus 5 · Low` 实测生效)。

验证:

- `typecheck:app` 绿;`vite build` 通过;i18n 测试 5/5;web-ui 既有测试
  15/15 全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:52899,主 chat 视图 composer):
  - zh:placeholder `随便问点啥`、按钮 `附加文件`、`会话设置——Opus 5 · Low`、
    `发送`
  - en(不刷新):`Ask anything` / `Attach files` /
    `Session settings — Opus 5 · Low` / `Send`
  - 截图:`i18n-p3-composer-zh.png` / `i18n-p3-composer-en.png`

第四批改:`packages/web-ui/app/src/deploys.ts` + `deploy-view.ts`
(原估 41,实 59 命中;含 Yours/Shared/Archived tabs、Deploying、permission
badge、版本标签、Owner 标签、App view/actions、Copy app URL、Restore/
Edit display name/Change URL slug/Archive 菜单、Sort、Search apps、空态、
Deploy with Agent、Edit live/Copy URL、Overview/Status/Live version/
Latest version/Access、Ownership and access、Settings、Display name/URL
slug/Change、Git remote、Clone 描述、Restore/Archive deployment、Version
history/Live/Latest、Archive 对话框、Archiving/Restoring deployment、
Undo/Dismiss、Could not load/save/archive/restore/open live editing、
Failed to load apps;新增 70 个 ui key,登记于两表;占位串 `{title}` /
`{when}` / `{name}` / `{current}` / `{applied}` / `{creator}` 走 `t()` 插值)。
helper(`versionLabel` / `deployedLabel` / `ownerLabel` / `statusLabel` /
`permissionBadge` / `deploymentTabEmptyMessage`)内部全用 `t()`,在
zh 模式下返回中文,en 模式返回原 key/字符串。

验证:

- `typecheck:app` 绿;`vite build` 通过;i18n 测试 5/5;web-ui 既有测试
  15/15 全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:53248,`/deploys` 路由):
  - zh:标题 `应用`、`排序` / `应用排序` / `最新/名称/状态` 排序选项、
    `搜索应用` searchbox、`你还没创建过应用。` 空态、`让 Agent 部署` 按钮
  - en(不刷新):`Apps` / `Sort` / `Sort apps` / `Newest/Name/Status` /
    `Search apps` / `No apps of your own yet.` / `Deploy with Agent`
  - 截图:`i18n-p3-deploys-zh.png` / `i18n-p3-deploys-en.png`
- 已知:侧栏的 "Apps" 链接仍写死英文(在 shell.ts),P1 留的"占位英文",
  下个文件 shell.ts 一起处理。

第五批改:`packages/web-ui/app/src/crons.ts` + `list-page.ts`(共享
Refresh 按钮;影响 deploys/crons/skills/webhooks/files/memory 等所有
list-page)
(估 35 命中,实际 ~50+;含 tabs (Yours/Shared/Archived)/New cron/Search
crons/Cron view & actions aria/Enable/Disable/Unarchive/Edit/Archive 按钮
title + aria-label/Run now/Cancel/Save/Edit/Delete/Context/Title/Task/
Message/Schedule/Owner/Scope/Status/Destination/Next run/Last fired/
Recent runs/Worklog/Loading/Never/Refresh/无 crons 状态、crons yet
in this context、active、shared、archived、No runs yet、enabled/disabled/
completed/Couldn't load run history/Run started.../That cron wasn't
found.../Failed to load crons/run failed/edit failed/archive failed/
unarchive failed/enable failed/disable failed/delete failed/Cron updated
/共享项 Shared from {scope} — you can view it, but not change it./
Delete {title}?/Delete permanently/This permanently removes the schedule
and its retained run history.../Edit behavior with agent/Title and
task are required/Title is required/To change {the schedule|the
message}, ... use the agent so it can validate the resulting behavior
and permissions./Edit cron/Edit/New cron/Crons 回链/Describe the cron
you want/Describe what you want scheduled... (含 example1/example2
占位)/Every weekday at 9am.../Ask the agent to set it up/
未命名 (untitled cron) /a Slack channel/org-wide/group;新增 78 个 ui
key,登记于两表;占位串 `{title}` / `{scope}` / `{example1}` / `{example2}`
全部走 `t()` 插值)。
helper(`suggestedCronTitle` / `cronScopeLabel` / `cronStatusText`)内部
全部 `t()`,zh 模式返回中文。
`list-page.ts` 的共享 Refresh 按钮 title/aria-label 改用 `t("Refresh")`,
影响所有 list-page 调用方(deploys/crons/skills/webhooks/files/memory
等)。这是 P3 deploys/commit 漏掉的边角清理,顺手补上。

验证:

- `typecheck:app` 绿;`vite build` 通过;i18n 测试 5/5;web-ui 既有测试
  15/15 全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:53733,`/crons` 路由):
  - zh:标题 `定时任务`、`按上下文筛选:全部上下文` 按钮、`刷新` 按钮、
    `新建定时任务` 按钮、`搜索定时任务` searchbox、`暂无定时任务。`
    空态
  - en(不刷新):`Crons` / `Refresh` / `New cron` / `Search crons` /
    `No crons yet.`
  - 截图:`i18n-p3-crons-zh.png` / `i18n-p3-crons-en.png`
- Dev 栈资产机制说明:`dev-web-ui.ts` 从 `dist-web/assets/` 服务 prebuilt
  bundle,**不是** 实时编译 TS;改源后必须 `pnpm --filter @qm/web-ui
  build` 后浏览器拉取新 hash 才能看到改动;`@qm/web-ui typecheck:app` 与
  `vite build` 是浏览器验收前的硬前置。

第六批改:`packages/web-ui/app/src/skills.ts`
(估 33 命中,实际 ~60;含 New skill/Search skills/Back to skills/状态
筛选 aria + 三个 tab(Active/Archived/All)/Scope + Source 下拉(范围/
来源 + All scopes/sources + Personal/Channel/Project group/Team/Org/
Created here/Skill packs/Overrides)/Description/Instructions/Name/Available
to/Editing/New 徽章/Active/Scope variant/Working…/Saving…/Archiving…/
Restore/Archive/Cancel/Save/Edit/Clear filters/Loading skills…/Details/
Capabilities/Scope/None required/Loading skill instructions…/Loading
instructions…/Instructions unavailable./Failed to load skill details/
save/create/restore/archive skill/load skills/未 skills in this context/未
skills available yet/未 skills match these filters/Name, description,
and instructions are all required./Edit /{name} 与 Edit /{name}? 与
Edit /skill/Create skill/Publish skill/Publish change/Review again/Publish
/{name} to {scope}?/Publish this change to {scope}?/Create a reusable
procedure for yourself or a shared context./Everyone in a shared context
can invoke and edit this skill./Everyone in this context can invoke and
edit these instructions./watch-pipeline/One line: what it does.../The
SKILL.md contents.../Personal — only you/only you/this context/Archive
/{name}?/Archive skill/Archiving…/This version will stop being
available to {audience}. ... /Narrower scope takes precedence where
both apply/variants/Description {state}/Instructions {state}/
unchanged/changed/skill/skills/asset/assets/variant/variants/group/groups/
source/Pack {name};新增 60 个 ui key,登记于两表;占位串 `{name}` / `{scope}` /
`{audience}` / `{state}` 全部走 `t()` 插值)。
helper(`scopeLabel` 改写为按 `scope` 值查表返回中文,`editAudience` 内部
`only you` / `this context` 走 `t()`)。

复用 key:`Skills` / `Archived` / `Archive` / `Cancel` / `Save` / `Edit` /
`Personal` / `Channel` / `Project` / `Organization` / `Name` / `Owner` /
`Restore` / `Active`(复用 P1 zh="进行中")/`Loading…` / `Loading skills…`
/ `Scope` (P3 crons)/`Source` (P3 skills)/`group` (P3 crons)/`Edit` 等。

已知:`Active` 在 crons 是"已启用"语义(用 t("Enabled")),在 skills 是
"技能启用中"语义(用 t("Active") zh="进行中")。两者不冲突,后续用户反馈
可统一。

验证:

- `typecheck:app` 绿;`vite build` 通过;i18n 测试 5/5;web-ui 既有测试
  15/15 全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:54223,`/skills` 路由):
  - zh:标题 `技能`、`刷新` 按钮、`新建技能` 按钮、`搜索技能` searchbox、
    `进行中 0` / `已归档 0` / `全部 0` 三个 tab、`按状态筛选技能` group
    aria、`范围` 标签 + combobox `按范围筛选技能`(选项:所有范围 / 个人 /
    频道 / 项目 / 群组 / 团队 / 组织)、`来源` 标签 + combobox `按来源
    筛选技能`(选项:所有来源 / Created here / 技能包 / 覆盖)、
    `0 个技能 in 0 组` 计数、`暂无可用技能。` 空态
  - en(不刷新):`Skills` / `Refresh` / `New skill` / `Search skills` /
    `Active` / `Archived` / `All` / `Filter by skill status` /
    `Filter skills by scope` / `Filter skills by source` / `All scopes` /
    `All sources` / `Personal` / `Channel` / `Project / group` / `Team` /
    `Organization` / `Created here` / `Skill packs` / `Overrides` /
    `0 skills in 0 groups` / `No skills available yet.`
  - 截图:`i18n-p3-skills-zh.png` / `i18n-p3-skills-en.png`

第七批改:`packages/web-ui/app/src/connectors.ts`
(keychain 页,估 28 命中,实际 ~85;含 Keychain hero(标题/副标题/信任
说明)/刷新 aria + title/添加凭据按钮/概览四项(已连接账号/已存凭据/
生效中的授权/需要关注)/加载中提示/两个 section(已关联账号/已存凭据
标题、副标题、空态)/凭据卡(Encrypted at rest/Expires {date}/Added
{date}/Expired/Last used {date} in {scope} · {status}/No audited use
yet/Delete/Pending requests/requested {mode} access/expires {date}/
Active access/Revoke)/连接器卡(Not connected/Reconnect needed/Refresh
failed: {error}/Reconnect/Connect account/Disconnect + 7 个 provider 的
hosts/desc 在渲染时经 t() 翻译,品牌名保留英文)/添加凭据表单(New
credential/Add a credential/长说明/Your one-time page is ready/Open it
in a new tab…/Open the one-time page/Done/Service/Environment variable
/optional/Purpose/placeholder/Cancel/Preparing…/Continue)/确认弹窗(
Check impact/Cancel)/删除凭据弹窗(单复数 grants 句/Delete {service}?/
Automations…/Delete credential)/撤销授权弹窗(Revoke access for
{scope}?/This {mode} access…/Revoke access/Access revoked ✓/Could not
revoke access.)/断开连接弹窗(单复数 credential grant 句/Disconnect
{name}?/Disconnect account)/错误与通知(Another keychain change…/Could
not delete the key./Service and purpose are required./No one-time page
URL was returned./Your one-time page is ready./Could not create the
one-time page./No authorization URL was returned./Could not start the
connector./Could not disconnect./Failed to load connectors./Failed to
load stored keys./{name}: connected./{name}: connection failed.)/
scopeName 兜底文案(a personal DM/a Slack channel ({ref})/a group DM/
a team ({ref})/the whole org)+ 新 helper modeLabel(once|standing →
one-time|standing t() 翻译);新增 ~85 个 ui key,登记于两表;`CONNECTOR_LABELS`
保持英文数据,`hosts`/`desc` 在渲染点经 `t()` 解析,locale 切换实时生效
(规避 module-level t() 锁定问题))。

复用 key:`Keychain`(P1 zh="密钥")/`Cancel` / `Done` / `Delete`(均 P1/
P2 已有)/`Refresh`(P3 crons)。

术语统一:P1 已定 `Keychain → 密钥`,本批新 key 全部跟随(刷新密钥/
密钥概览/正在加载密钥/密钥库),避免"钥匙串"混用。

验证:

- `typecheck:app` 绿(1 处重复键 `a Slack channel` 与既有条目冲突,删除
  新增重复后绿);`vite build` 通过;i18n 测试 5/5;web-ui 既有测试 15/15
  全过(共 20/20)
- 浏览器实测(portal 前门 127.0.0.1:55576,`/keychain` 路由):
  - zh:标题 `密钥`、`代理可以代表你使用的账号与凭据。`、信任说明、
    `刷新密钥` / `添加凭据` 按钮、`密钥概览` aria(已连接账号/已存凭据/
    生效中的授权/需要关注)、`已关联账号` section(`代理可以你的身份
    使用的服务商 API。`、空态 `没有可用账号` + `你的工作区尚未配置任何
    账号服务商。`)、`已存凭据` section(`你通过一次性页面添加的 API
    密钥、令牌和文件。`、空态 `暂无已存凭据` + `添加凭据,无需把密钥
    粘贴到聊天中。` + `添加凭据` 按钮);点击 `添加凭据` 后表单全 zh:
    `新凭据` / `添加凭据` / 长说明 / `服务` / `环境变量` + `可选` /
    `用途` / placeholder `代理可以用这个凭据做什么?` / `取消` / `继续`
  - en(不刷新):`Keychain` / `Accounts and credentials your agent may
    use on your behalf.` / `Refresh keychain` / `Add credential` /
    `Connected accounts` / `Stored credentials` / `Active grants` /
    `Need attention` / `Linked accounts` / `Provider APIs the agent can
    use as you.` / `No accounts available` / `Stored credentials` /
    `New credential` / `Add a credential` / `Service` / `Environment
    variable` + `optional` / `Purpose` / `What may the agent use this
    credential for?` / `Cancel` / `Continue`
  - 截图:`i18n-p3-connectors-zh.png` / `i18n-p3-connectors-en.png`

第八批改:`packages/web-ui/app/src/chat.ts`
(2377 行,P3 最大文件,估 86 命中,实际 ~90 处 + ~112 新 key;P2 已覆盖
错误通道,本批覆盖其余 UI:8 处 errMessage fallback(无法开始对话/发送
审批/接续排队/重连任务/重试消息/分叉对话/加载后台活动/加载完整输出)/
只读横幅(该对话位于 Slack 中…/在 Slack 中打开/此对话在此处只读)/
Show earlier messages 三处(含 btn.textContent 动态赋值)/空态(此对话
中没有可读的消息。)/**欢迎语整段**(你好——我是你的 AI 队友 👋…单条
key 含 \n\n,markdown 渲染)/pane 条(展开此面板/当前/等待你审批/
思考中…)/拖放覆盖层(拖放文件或文件夹以附加)/顶栏(New chat 复用/
another conversation/Read-only 复用 P1/刷新对话)/steered 标注/Retry
复用/Stopped/消息 meta(复制/复制消息/从此处分叉对话)/connector
widget(已连接 {name}/已授权…/连接 {name}/在新标签页中授权访问/你的
账号)/playground(预览操作 aria + Source/Open 复用)/Thinking 摘要与
typing 占位/后台面板(expiring/剩 {n} 分钟/剩 {h} 小时 {m} 分钟/隐藏
后台活动/工作正在代理的电脑上继续——点击查看/后台活动/这里已经没有在
运行的任务了。/已退出({code})/隐藏输出/显示实时输出/开始于 {time}/
(暂无输出)/正在加载输出…/定时任务 — {title}/计划任务/下次触发
{time}/已暂停/现在到期/{n} 分钟后/{h} 小时 {m} 分钟后/{n} 天后/匹配
/{pattern}/ 的输出/任何新输出/监视——在{what}时唤醒/布防于 {time}/
上次触发于 {time})/live work dock(收起/展开更多/思考中(已用 {n} 个
工具)/{verb}被中断——正在恢复…/已中断——正在恢复…/{label} · {secs} 秒/
工作中 · {secs} 秒/已完成工作/{n} 次工具调用/{secs} 秒后失败/失败/
{label}——已中断/{n} 次尝试)/审批卡(需要审批/原因/触发于/显示完整
命令)/TOOL_META 27 个 active/done/attempted 键(运行命令/读取文件/
写入文件/发布中/搜索记忆/使用记忆/搜索历史/管理进程 + 未知工具)在
**用点包 t()**(表格数据保持英文 msgid,locale 切换实时生效)/toolDetail
计数({n} 个结果/已保存 {n} 条)/exec 输出卡(退出码 {code}/ · 超时/
显示完整输出))。

复用 key:`New chat` / `Retry` / `Open` / `Source` / `Read-only`(P1)
/`Loading…`/`Cancel`。

实现要点:

- `TOOL_META`/`UNKNOWN_TOOL` 保持英文数据;`meta.active/done/attempted`
  在每个用点经 `t()` 解析——与 connectors 的 `CONNECTOR_LABELS` 同一模式。
- `workedLabel(prefix, secs)` 改为 `t("{label} for {secs}s", …)`——
  `{label}` 参数值本身已是 t() 结果(如 `t("Worked")`),嵌套插值正常。
- `usedToolsSuffix` 重构为 `usedToolsLabel`:整句 key
  `Thinking (used {n} tool(s))`,替代英文后缀拼接。
- 动态 `btn.textContent = t("Loading earlier messages…")` 在事件回调中
  求值,locale 实时。

验证:

- `typecheck:app` 绿(1 处 `Read-only` 与 P1 既有条目重复,删除新增后绿);
  `vite build` 通过;测试 20/20
- 浏览器实测(portal 前门 127.0.0.1:59185,`/` 聊天视图):
  - zh:欢迎语三段全部中文(你好——我是你的 AI 队友 👋 / 我在自己的
    一台电脑上运行任务… / 需要初始设置吗?…),markdown 段落结构保留
  - en(不刷新,实时切换):Hi — I'm your AI teammate 👋 / I run tasks
    on a computer of my own… / Want to get set up?…
  - 截图:`i18n-p3-chat-zh.png` / `i18n-p3-chat-en.png`

第九批改:`packages/web-ui/app/src/shell.ts`(990 行,侧栏/横幅/认证门/
共享 chrome;~48 处 + ~47 新 key,其中 9 个视图名 key 复用
document-title.ts 的 VIEW_TITLES 既有条目):

- 顶栏横幅:身份代看(正在查看助手：{user}，你是 {by}——bold 标记用
  片段 key 包夹,保持 <b> 结构)/ 退出模拟登录 / 开发模式(——未配置
  身份提供方,当前以 {user} 登录)/ 退出登录
- 认证门四态全部 t() 化:portal 待跳转(请通过门户登录 + 长文案)、
  会话已结束(你已退出登录。重新登录后将回到本页。/登录)、无权限
  (你没有访问权限 + WEB_UI_PRINCIPALS 提示改 {env} 参数插值,去
  <b>)、不可达(无法连接到助手/重试/核心服务可能已宕机)、dev 登录
  (开发模式登录/CORE_SIGNING_SECRET 改 {env} 参数/主体/登录中…/
  继续,复用 connectors 批既有 `Continue`——本批新增时撞 TS1117,删
  新留旧)/ Sign-in failed.
- 侧栏 chrome:navigation aria / 收起侧栏 / 展开侧栏 / 管理 AI 账号 /
  配色方案:浅色 / 深色 / 跟随系统 / 关闭侧栏 / 调整侧栏宽度 / 拖动
  调整宽度 · 双击重置 / 选择一个对话,或开始新聊天。
- 导航区:新聊天(复用)/ 浏览分组(收起{group}/展开{group} 参数
  插值)/ 9 个视图行复用 VIEW_TITLES key(项目/聊天/文件/定时任务/
  Webhook/密钥/应用/记忆/技能)/ 管理后台(新增 Admin)/ 会话 /
  搜索你的聊天(aria + tooltip `搜索你的聊天 · {hotkey}` 参数插值,
  hotkey 保留系统常量 SEARCH_HOTKEY_LABEL)/ 仅网页 switch(仅显示网
  页聊天 / 隐藏非网页对话)
- 共享函数:`updateSidebarToggleLabels` 收起/展开侧栏(调用时求值,
  locale 实时)/ `renderPane` 的 `Refresh {view}` → 刷新{view}(zh
  无需 lowercase,传入已译标题直接拼接)
- boot 路径:app-edit 草稿种子(帮我更新已部署的应用「{slug}」：)/
  此编辑链接缺少有效的应用名。/ 找不到该对话,或你无权访问。(toast
  + 空态两处)

实现要点:

- 9 个导航行 label 直接复用 P1 的 VIEW_TITLES key(document-title.ts
  与 sidebar 本就同源),零新增。
- navGroup 分组标题 `<span>${t(title)}</span>` + 折叠 title 用
  `t("Hide {group}", { group: t(title) })` 嵌套插值——首版漏包 span
  导致浏览器快照暴露英文 "Browse",复验时发现并修复。
- 横幅 bold 结构用片段 key(`Viewing the assistant as` / `, you are`)
  包夹 <b> 节点;env 变量名提示改用 {env} 参数插值丢弃 <b>(装饰性)。
- 顶栏横幅在 mountShell 内渲染一次,locale 切换不重绘横幅(与既有
  module-level 常量同 trade-off,重载后生效);侧栏/认证门均在调用时
  求 t(),实时生效。

验证:

- `typecheck:app` 绿(1 处 `Continue` 与 connectors 批既有条目重复,
  删除新增后绿);`vite build` 通过;i18n parity 测试随全量套件通过
- 浏览器实测(portal 前门 127.0.0.1:59774,`/` 聊天视图):
  - zh:侧栏全部中文(浏览/项目/聊天/文件/定时任务/Webhook/密钥/
    应用/记忆/技能/管理后台/会话/搜索你的聊天/仅网页/收起侧栏/
    配色方案…/退出登录/调整侧栏宽度),aria 同步翻译
  - en(不刷新,实时切换):Navigation/Browse/Projects…/Admin/
    Sessions/Web only/Sign out 全部回退,页面标题 Chats · QM · Web
  - 截图:`i18n-p3-shell-zh.png` / `i18n-p3-shell-en.png`
- 全量 `pnpm test`:671/705 通过;i18n 相关 5 用例全绿。2 个失败
  (packages/api tranche6 connectors token register、tranche7 admin
  grants)经 stash 复现验证为**预存失败**,与本会话 i18n 改动无关
  (api 包不依赖 web-ui app src)。

残留扫描(P3 验收要求的"其余"):

- `split.ts`(1282 行)仍有 ~25 处可见 pane chrome:New session/
  Tools/Split this pane with a new session/Close pane/Archive session/
  Agent is working/Waiting for your reply/分屏拖放区(Split left/right/
  up/down/Open here/Show here/Open as tab)/Restore to grid (Esc)/
  Open full screen/Your keychain 等——下一批处理。
- 其余文件(session-scope/pane-focus/tooltip 等)命中的均为技术性
  字符串或无用户可见文案。

第十批改:`packages/web-ui/app/src/split.ts`(1282 行,分屏画布;
~30 处 + 41 新 key,其中 6 个 PANE_TOOLS 视图名复用 VIEW_TITLES 既有
key——Crons/Files/Apps/Skills/Memory 直接命中,Your keychain 新增):

- 分栏基础:tab/面板标题(New session/Conversation)、空会话兜底
  New chat、working/awaiting 状态点(Agent is working/Waiting for
  your reply,复用既有 key)、归档/关闭按钮(Archive session/
  Close pane)、工具按钮(Tools)
- 拖放区标签:Split left/right/up/down、Open here、Show here、
  Open as tab
- 画布 toast:Already open in a pane;三条容量提示改 {max} 参数
  插值({max} tiles is the limit — …×2、{max} conversations is all
  one canvas holds…)
- 工具菜单:PANE_TOOLS 用点 t() 包裹(map 参数由 t 重命名为 tool
  消除遮蔽);Restore to grid (Esc)/Focus over the grid/Split this
  pane with a new session/Open full screen/Close pane
- dockview 无障碍公告:库默认英文 `${title} opened` 等会进入
  aria-live 区域(浏览器验证时暴露"新会话 opened"混合文案)。通过
  createDockview 的 messages 选项全量覆盖 12 条公告(panelOpened/
  Closed、groupMaximized/Restored/Floated/Docked/PoppedOut、
  movePickTarget/PickEdge/Committed/Cancelled/NotAllowed),方位词
  以 Left/Right/Top/Bottom/Center edge 辅助 key 组合;t() 在公告
  触发时求值,locale 切换实时生效

实现要点:

- PANE_TOOLS 数据表保持英文 label,在菜单渲染点统一 t()——与
  TOOL_META 同款模式;map 回调参数 t 与 i18n t 同名遮蔽,重命名为
  tool。
- 容量常量 MAX_TILES=4/MAX_PANES=12 以 {max} 参数插值,不硬编码进
  msgid。
- dockview 公告覆盖函数在每次公告时调用 t(),是本批唯一"实时"路径;
  其余(pane 标题等)随 draw()/刷新时求值。

验证:

- `typecheck:app` 绿(无重复 key);`vite build` 通过;i18n parity
  测试含 41 个新 key 全绿
- 浏览器实测(portal 前门 127.0.0.1:61233,分屏画布已激活):
  - zh:tab"新会话"、工具菜单(定时任务/文件/应用/技能/记忆/你的
    密钥)、按钮(用新会话分屏此栏/全屏打开/关闭分栏)、aria-live
    公告"新会话 已打开"全部中文
  - en(不刷新,实时切换):New session/Tools/Split this pane with a
    new session/Open full screen/Close pane 全部回退
  - 截图:`i18n-p3-split-zh.png` / `i18n-p3-split-en.png`
- 全量 `pnpm test`:671/705 通过;2 个失败仍是预存的 packages/api
  tranche6/tranche7(上一批已经 stash 复现验证),与本次改动无关
- 备注:工具菜单按钮的 document 级 click 关闭监听存在重渲染后
  contains 判定失效导致菜单即开即关的预存行为(与 i18n 无关,验证
  时用非冒泡 click 绕过完成菜单项核对;如需修复应另立任务)
