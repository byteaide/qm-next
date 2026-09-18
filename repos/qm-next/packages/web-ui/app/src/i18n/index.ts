// Locale: UI language ("en" | "zh") persisted in localStorage. Mirrors
// theme.ts: index.html carries a matching inline pre-paint script that syncs
// <html lang> before first paint; this module keeps it correct while running.
//
// This codebase renders with lit-html's imperative render() (no LitElement
// classes), so there is nothing to host a ReactiveController — components
// that care about locale subscribe via onLocaleChange() and re-run their
// render path. main.ts registers the app-wide re-render.

import { uiEn } from "./ui.en";
import { uiZh } from "./ui.zh";

export type Locale = "en" | "zh";

const STORAGE_KEY = "qm.locale";
const TABLES: Record<Locale, Record<string, string>> = { en: uiEn, zh: uiZh };

let cached: Locale | null = null;

export function currentLocale(): Locale {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "zh") {
      cached = raw;
      return cached;
    }
  } catch {
    // storage unavailable (private mode, plain node, etc.) — fall through
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  cached = (nav || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  return cached;
}

export function applyLocale(): void {
  if (typeof document === "undefined") return; // plain node / SSR
  document.documentElement.lang = currentLocale() === "zh" ? "zh-CN" : "en";
  syncLocaleCookie(currentLocale());
}

// Mirror the choice into a `qm.locale` cookie so the same-origin portal pages
// (server-rendered HTML) follow the SPA's language (i18n plan §4.4). Runs on
// startup via applyLocale() and on every toggle; host-only cookie — portal and
// SPA share one origin on the qm-next single-process topology.
function syncLocaleCookie(locale: Locale): void {
  if (typeof document === "undefined") return; // plain node / SSR
  document.cookie = `${STORAGE_KEY}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale()) return;
  cached = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore persistence failure; the in-memory choice still applies
  }
  applyLocale();
  for (const listener of localeListeners) listener(locale);
}

export function toggleLocale(): void {
  setLocale(currentLocale() === "zh" ? "en" : "zh");
}

// Translate: the en text is the key, so t("Deploy") renders "Deploy" (en) or
// "部署" (zh). Unknown keys pass through, so en is always safe. `{name}`
// placeholders interpolate from params.
export function t(key: string, params?: Record<string, string | number>): string {
  const table = TABLES[currentLocale()];
  const entry = Object.hasOwn(table, key) ? table[key] : undefined;
  let out: string = entry ?? key;
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    );
  }
  return out;
}

const localeListeners = new Set<(locale: Locale) => void>();

// Subscribe to locale switches; returns an unhook function for hot-reload/dev
// hygiene. Listeners re-run their render path — locale is resolved at render
// time via t(), so a re-render is all that is needed.
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}
