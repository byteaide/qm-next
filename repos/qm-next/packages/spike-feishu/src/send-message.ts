/**
 * Spike 2/3 — outbound: send text/markdown, thread reply, edit.
 *
 * Verifies: send() SendInput variants (text/markdown), SendOptions
 * (replyTo + replyInThread for thread replies), editMessage() for in-place
 * content updates (streaming-reply building block).
 *
 * Real-connect run (needs credentials + a test chat):
 *   FEISHU_TEST_CHAT_ID=oc_xxx pnpm --filter @qm/spike-feishu spike:send
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
await channel.connect();

// 1) Plain text.
const first = await channel.send(config.testChatId, { text: "spike: text ok" });
console.log("[send text]", first.messageId);

// 2) Markdown, as a thread reply to the first message.
const threadReply = await channel.send(
  config.testChatId,
  { markdown: "**spike:** markdown *ok*" },
  { replyTo: first.messageId, replyInThread: true },
);
console.log("[send thread markdown]", threadReply.messageId);

// 3) Edit the thread reply in place (streaming-reply building block).
await channel.editMessage(threadReply.messageId, "**spike:** edited in place");
console.log("[edit]", threadReply.messageId);

// 4) Recall to prove delete works.
await channel.recallMessage(threadReply.messageId);
console.log("[recall]", threadReply.messageId);

await channel.disconnect();
