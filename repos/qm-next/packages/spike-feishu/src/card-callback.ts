/**
 * Spike 3/3 — approval-style interactive card + WS card callback.
 *
 * Verifies: card SendInput, `cardAction` event over the websocket transport
 * (SDK registers `card.action.trigger` on its EventDispatcher), action.value
 * round-trip, and updateCard() status write-back.
 *
 * App-side prerequisite (once, in Feishu open platform console):
 *   卡片回调方式 must be set to 使用长连接接收回调 for WS delivery.
 *
 * Real-connect run (needs credentials + a test chat):
 *   FEISHU_TEST_CHAT_ID=oc_xxx pnpm --filter @qm/spike-feishu spike:card
 */
import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import { loadConfig } from "./config.ts";

const config = loadConfig();
if (!config.testChatId) {
  console.error("[spike] set FEISHU_TEST_CHAT_ID to a chat the bot can post in.");
  process.exit(2);
}

const channel = createLarkChannel({
  appId: config.appId,
  appSecret: config.appSecret,
  domain: config.domain,
  transport: "websocket",
});

// Approval card with two buttons; decision rides in action.value.
const approvalCard = {
  config: { update_multi: true },
  header: { title: { tag: "plain_text", content: "spike 审批" }, template: "blue" },
  elements: [
    { tag: "markdown", content: "运行 `run-spike-001`，是否继续？" },
    {
      tag: "action",
      actions: [
        { tag: "button", text: { tag: "plain_text", content: "批准" }, type: "primary", value: { action: "approve", runId: "run-spike-001" } },
        { tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger", value: { action: "reject", runId: "run-spike-001" } },
      ],
    },
  ],
};

channel.on("cardAction", async (evt) => {
  const decision = (evt.action as { value?: Record<string, unknown> }).value;
  console.log("[cardAction]", evt.operator.openId, JSON.stringify(decision));
  // Status write-back on the same card.
  await channel.updateCard(evt.messageId, {
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: `spike 审批 — ${decision?.action === "approve" ? "已批准" : "已拒绝"}` },
      template: decision?.action === "approve" ? "green" : "red",
    },
    elements: [{ tag: "markdown", content: `由 <at id=${evt.operator.openId}></at> 处理` }],
  });
});

await channel.connect();
const sent = await channel.send(config.testChatId, { card: approvalCard });
console.log("[card sent]", sent.messageId, "— click a button; Ctrl+C to exit.");

process.on("SIGINT", () => {
  void channel.disconnect().then(() => process.exit(0));
});
