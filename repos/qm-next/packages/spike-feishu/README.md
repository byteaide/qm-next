# spike-feishu — `@larksuiteoapi/node-sdk` 可行性验证（M2 · 6.0）

Scratch 包，不依赖 qm-next 其他代码。结论是 `im-feishu`（9.x）实现方式的输入。

## 结论：**有条件满足 → 用 SDK，9.1 不需要直连 OpenAPI**

SDK **v1.73.3**（2026-09 安装时的最新版）提供高层 `createLarkChannel` 封装，与 qm-next
计划中的 im-core 契约惊人地同构，三件套全部有直接支撑：

| 三件事 | 状态 | 依据 |
|--------|------|------|
| WS 长连接收事件 | ✅ 类型面 + 实现面已验证；真连待凭据 | `createLarkChannel({transport:'websocket'})` → 内部 `WSClient`；断线自动重连（`autoReconnect`、generation 防僵尸重连环）、ping 看门狗（`wsConfig.pingTimeout`）、握手超时（`handshakeTimeoutMs`）、`getConnectionStatus()` 五态查询 |
| 发消息 | ✅ 同上 | `send(to, input, opts)`；`SendInput` 判别联合覆盖 text/markdown/post/image/file/audio/video/card/shareChat/shareUser（文件即 uploadFile 位）；`SendOptions.replyTo+replyInThread` → 线程回复；`editMessage`/`recallMessage` → 编辑/删除 |
| 卡片回调 | ✅ 同上 | **WS 传输下可达**：SDK 在自己的 EventDispatcher 上注册 `card.action.trigger`（es/index.js:106992），归一化为 `CardActionEvent`，且内置点击去重（同卡同人同按钮折叠，真重投按 key 去重）；`updateCard` 做状态回写 |

**超出预期的能力**（9.2/9.4 可白嫖，不必自研）：

- **流式回复**：`stream(to, {markdown: producer})` — `MarkdownStreamController.append/setContent`
  编辑同一条消息；超过单元素上限（默认 30000 字符）自动**滚动开新卡**继续输出；
  节流（`streamThrottleMs/Chars`）内置。PRD 的"线程内流式回复"直接用它。
- **准入策略**：`PolicyConfig`（groupAllowlist/dmMode/dmAllowlist/requireMention/respondToMentionAll）
  + `RejectEvent` 明确拒绝原因（`no_mention`/`group_not_allowed`/…），对应 orchestrator 准入前置层。
- **安全面**：事件去重（event_id dedup TTL 可配）、过期消息窗口（`staleMessageWindowMs`）、
  出站 SSRF 防护（`ssrfGuard` + allowlist）、本地文件路径白名单（`allowedFileDirs`）、出站重试（`retry`）。
- **格式**：`SendInput.markdown` 内置 md→lark 转换（`markdownConverter: 'builtin' | 自定义`）。
- **reaction**：`addReaction/removeReaction` 可用（v1 推迟，契约保留位）。

## 三个真连脚本（凭据注入后即可跑）

```
FEISHU_APP_ID=… FEISHU_APP_SECRET=…                              pnpm --filter @qm/spike-feishu spike:receive
FEISHU_APP_ID=… FEISHU_APP_SECRET=… FEISHU_TEST_CHAT_ID=oc_xxx   pnpm --filter @qm/spike-feishu spike:send
FEISHU_APP_ID=… FEISHU_APP_SECRET=… FEISHU_TEST_CHAT_ID=oc_xxx   pnpm --filter @qm/spike-feishu spike:card
```

- `spike:receive` — @机器人/私聊 → NormalizedMessage 打印；重连生命周期日志。
- `spike:send` — 文本 → 线程内 markdown 回复 → 原地编辑 → 撤回。
- `spike:card` — 审批卡（批准/拒绝按钮）→ 点击回调打印 `action.value` → 同卡状态回写。
  **应用侧一次性配置**：开放平台「卡片回调方式」须选**使用长连接接收回调**。

离线验证（本机已跑通）：`pnpm --filter @qm/spike-feishu spike` → 15/15 surface checks PASS，
`typecheck` strict 绿。

## 坑与注意事项

1. **真连验证仍欠**：类型/实现面证据充分，但 PRD 验收口径是真机。凭据到位后三脚本 ≈ 10.0 冒烟预演。
2. **卡片回调应用配置**：默认可能走 HTTP 回调；WS 接收须在开放平台改设置，否则 `card.action.trigger` 不会经 WS 下发。
3. **`editMessage` 只支持 text/post**：卡片编辑必须走 `updateCard`，用错 API 报错信息不友好（SDK 注释明确警告）。
4. **`im.v1.message.update` vs `patch`**：高层 `editMessage` 用 update；若后续需要覆盖 patch 语义（如卡片流式），直接用 rawClient（`channel.rawClient.im.v1.message.*`）。
5. **`streamMaxElementChars` 滚卡**：流式超长会开新卡（新 messageId），调用方要跟住 `SendResult.messageId`/chunkIds，im-core 的 Destination 消息句柄要可更新。
6. **pingTimeout 语义**：是"无入站帧即判死"的看门狗，不要设小于服务端 ping 周期（~1min），默认 30s 合理。
7. **SDK 双格式发布**（lib CJS + es ESM + types 单文件 rollup）：NodeNext/ESM 下从 `es` 路径解析，tsx 运行正常，strict 下无类型报错。

## 对 9.x 的建议

- **9.1 用 `createLarkChannel`（websocket 传输）作为 im-feishu 的接入层**，不直连 OpenAPI；
  原始 `channel.rawClient` 留作逃生舱（patch 类 API、目录 API）。
- **im-core 契约不要 leak LarkChannel 类型**：LarkChannel 与契约同构是巧合也是验证，
  im-feishu 适配器做 `NormalizedMessage → InboundEvent`、`OutboundOp → send/edit/updateCard` 映射。
- 准入（requireMention/allowlist）语义放 im-core 策略位，im-feishu 用 `PolicyConfig` 落地，
  `RejectEvent.reason` 映射回 `InboundEvent` 的拒绝分支。
