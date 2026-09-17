// Chinese word list for the zh locale. Keys must match ui.en.ts exactly —
// the `satisfies` constraint below fails the build when a key is missing on
// either side, and the i18n parity test re-checks at runtime.

import { uiEn } from "./ui.en";

export const uiZh = {
  // shell sidebar (locale switcher)
  "Switch to Chinese": "切换到中文",
  "Switch to English": "切换到英文",
  // document titles (VIEW_TITLES)
  Chats: "聊天",
  Projects: "项目",
  Webhooks: "Webhook",
  Crons: "定时任务",
  Files: "文件",
  Keychain: "密钥",
  Apps: "应用",
  Memory: "记忆",
  Skills: "技能",
  // chats
  "New chat": "新聊天",
} satisfies Record<keyof typeof uiEn, string>;
