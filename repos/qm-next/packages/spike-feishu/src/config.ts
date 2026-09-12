/**
 * Shared env config for the feishu SDK spike.
 *
 * Credentials come from the environment only (never committed):
 *   FEISHU_APP_ID / FEISHU_APP_SECRET   — required for real connection
 *   FEISHU_TEST_CHAT_ID                 — optional, target chat for send/card demos
 *   FEISHU_DOMAIN                       — optional, "feishu" (default) | "lark"
 */
export interface SpikeConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  testChatId?: string;
}

export function loadConfig(): SpikeConfig {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.error(
      "[spike] missing credentials. Set FEISHU_APP_ID / FEISHU_APP_SECRET in the environment, e.g.:\n" +
        "  aidevops secret set FEISHU_APP_ID\n" +
        "  aidevops secret set FEISHU_APP_SECRET\n" +
        "then re-run with them exported.",
    );
    process.exit(2);
  }
  const testChatId = process.env.FEISHU_TEST_CHAT_ID;
  const domainRaw = process.env.FEISHU_DOMAIN;
  return {
    appId,
    appSecret,
    domain: domainRaw === "lark" ? "lark" : "feishu",
    ...(testChatId ? { testChatId } : {}),
  };
}
