// English word list — the en text IS the key (msgid model). This file is the
// single source of truth for keys: every t() key used in templates must be
// registered here, and ui.zh.ts must carry exactly the same key set
// (enforced by the `satisfies Record<keyof typeof uiEn, string>` constraint
// on uiZh plus the i18n parity test). Values mirror the keys so t() can do a
// uniform table lookup and future locales can be added mechanically.

export const uiEn = {
  // shell sidebar (locale switcher)
  "Switch to Chinese": "Switch to Chinese",
  "Switch to English": "Switch to English",
  // document titles (VIEW_TITLES)
  Chats: "Chats",
  Projects: "Projects",
  Webhooks: "Webhooks",
  Crons: "Crons",
  Files: "Files",
  Keychain: "Keychain",
  Apps: "Apps",
  Memory: "Memory",
  Skills: "Skills",
  // chats
  "New chat": "New chat",
} as const;
