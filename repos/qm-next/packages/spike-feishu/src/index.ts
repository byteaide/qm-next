/**
 * Offline smoke — runnable WITHOUT credentials.
 *
 * Verifies the SDK imports and constructs under Node 22 + ESM + tsx, and
 * asserts the API surface this spike depends on actually exists at runtime.
 * Run: pnpm --filter @qm/spike-feishu spike
 *
 * The three real-connection scripts (ws-receive / send-message /
 * card-callback) are ready to run once FEISHU_APP_ID/SECRET are injected.
 */
import { createRequire } from "node:module";
import { createLarkChannel, WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";

const checks: [string, boolean][] = [
  ["createLarkChannel is a function", typeof createLarkChannel === "function"],
  ["WSClient is a constructor", typeof WSClient === "function"],
  ["EventDispatcher is a constructor", typeof EventDispatcher === "function"],
];

// Construct with dummy values — no network I/O happens in the constructor.
const channel: LarkChannel = createLarkChannel({
  appId: "cli_dummy",
  appSecret: "dummy",
  transport: "websocket",
});

checks.push(
  ["channel.on(name, handler) available", typeof channel.on === "function"],
  ["channel.send available", typeof channel.send === "function"],
  ["channel.stream available (streaming reply)", typeof channel.stream === "function"],
  ["channel.editMessage available", typeof channel.editMessage === "function"],
  ["channel.recallMessage available", typeof channel.recallMessage === "function"],
  ["channel.updateCard available", typeof channel.updateCard === "function"],
  ["channel.addReaction available (react 位)", typeof channel.addReaction === "function"],
  ["channel.downloadResource available (inbound files)", typeof channel.downloadResource === "function"],
  ["channel.getChatInfo available (directory)", typeof channel.getChatInfo === "function"],
  ["channel.getConnectionStatus available", typeof channel.getConnectionStatus === "function"],
  ["channel.updatePolicy available (准入)", typeof channel.updatePolicy === "function"],
  ["disconnect available", typeof channel.disconnect === "function"],
);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`\n[spike] ${failed} check(s) FAILED — SDK surface mismatch, investigate before 9.x.`);
  process.exit(1);
}
console.log("\n[spike] all surface checks passed (v" + sdkVersion() + ", offline).");
console.log("[spike] real-connection scripts ready: spike:receive / spike:send / spike:card");

function sdkVersion(): string {
  // Resolve the installed SDK version from its package.json (ESM-safe).
  try {
    const require = createRequire(import.meta.url);
    return require("@larksuiteoapi/node-sdk/package.json").version as string;
  } catch {
    return "unknown";
  }
}
