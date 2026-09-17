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
  // model sign-in errors (model-connect friendly())
  "That API key was rejected — check it and try again.": "API 密钥被拒绝,请检查后重试。",
  "Sign-in didn't complete. Try again — the code may have expired.": "登录未完成,请重试——验证码可能已过期。",
  "Couldn't reach the sign-in service. Check your connection and try again.":
    "无法连接登录服务,请检查网络后重试。",
} satisfies Record<keyof typeof uiEn, string>;
