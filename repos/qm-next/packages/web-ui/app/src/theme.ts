// Theme: dark mode via the pi-web-ui design-system `.dark` token block.
// Choice persists in localStorage; "system" follows prefers-color-scheme live.
// index.html carries a matching inline pre-paint script so first paint is
// already dark — this module keeps it correct across changes while running.

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "qm.theme";

const darkQuery =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function currentTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // storage unavailable (private mode etc.) — fall through to system
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return darkQuery?.matches ?? false;
}

export function applyTheme(): void {
  const choice = currentTheme();
  const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // ignore persistence failure; the in-memory choice still applies
  }
  applyTheme();
}

// Re-applies when the OS scheme flips while in "system" mode. Returns an
// unhook function for hot-reload/dev hygiene.
export function watchSystemTheme(): () => void {
  if (!darkQuery) return () => {};
  const onChange = (): void => {
    if (currentTheme() === "system") applyTheme();
  };
  darkQuery.addEventListener("change", onChange);
  return () => darkQuery.removeEventListener("change", onChange);
}
