/**
 * Spike 1/3 — WS long-connection inbound events.
 *
 * Verifies: WSClient transport via createLarkChannel, `message` event shape
 * (NormalizedMessage), reject/error/reconnect lifecycle callbacks, and
 * getConnectionStatus() snapshots.
 *
 * Real-connect run (needs credentials):
 *   pnpm --filter @qm/spike-feishu spike:receive
 * Then @-mention the bot in a group or DM it; events print to stdout.
 */
import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import { loadConfig } from "./config.ts";

const config = loadConfig();

const channel = createLarkChannel({
  appId: config.appId,
  appSecret: config.appSecret,
  domain: config.domain,
  transport: "websocket",
  // Watchdog: terminate if no inbound frame within 30s (server pings ~1min cadence).
  wsConfig: { pingTimeout: 30 },
  handshakeTimeoutMs: 10_000,
  includeRawEvent: true,
});

const unsubscribe = channel.on({
  message: (msg) => {
    console.log("[message]", JSON.stringify({
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      mentionedBot: msg.mentionedBot,
      threadId: msg.threadId,
      content: msg.content,
      resources: msg.resources.length,
    }));
  },
  reject: (evt) => console.log("[reject]", evt.reason, evt.messageId),
  cardAction: (evt) => console.log("[cardAction]", JSON.stringify(evt.action)),
  error: (err) => console.error("[error]", err.code, err.message),
  reconnecting: () => console.warn("[ws] reconnecting…"),
  reconnected: () => console.warn("[ws] reconnected"),
});

process.on("SIGINT", () => {
  unsubscribe();
  void channel.disconnect().then(() => process.exit(0));
});

await channel.connect();
console.log("[ws] connected:", channel.getConnectionStatus());
// Keep the process alive; Ctrl+C to disconnect.
setInterval(() => {
  const status = channel.getConnectionStatus();
  if (status) console.log("[ws status]", status.state, "attempts:", status.reconnectAttempts);
}, 30_000);
