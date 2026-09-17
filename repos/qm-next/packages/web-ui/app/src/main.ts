import "dockview-core/dist/styles/dockview.css";
import "./shell.css";
import { bootSafely, mountShell, refreshActiveView, renderSidebarTop, syncDocumentTitle } from "./shell";
import { registerChatSearchHotkey } from "./search";
import { closeFormMenus } from "./ui";
import { applyTheme, watchSystemTheme } from "./theme";
import { applyLocale, onLocaleChange } from "./i18n/index";
import { allConversations } from "./conversations";
import {
  clearSessionSelection,
  closeOpenSessionMenu,
  closeSessionSelectionColor,
  renderList,
  sessionsState,
} from "./sessions";
import { appState } from "./shell-state";
import { closeDeployMenu } from "./deploys";

function closeComposerMenus(keepOpenWithin: Element | null): boolean {
  let changed = false;
  for (const conv of allConversations()) {
    if (keepOpenWithin && conv.state.host?.contains(keepOpenWithin)) continue;
    if (!conv.composer.closeMenus()) continue;
    changed = true;
    conv.redraw();
  }
  return changed;
}

document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  const inside = target?.closest(".menu-control, .composer-wrap") ?? null;
  closeComposerMenus(inside);
  if (!target?.closest(".form-menu-control")) closeFormMenus();
  if (sessionsState.openMenuId && !target?.closest(".session-menu")) {
    sessionsState.openMenuId = null;
    renderList();
  }
  if (!target?.closest(".multi-select-color")) closeSessionSelectionColor();
  closeDeployMenu(target);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeComposerMenus(null);
  closeOpenSessionMenu();
  clearSessionSelection();
  closeDeployMenu(null, true);
  closeFormMenus();
});

registerChatSearchHotkey();
applyTheme();
watchSystemTheme();
applyLocale();

// Locale switches re-run every active render path: chrome (sidebar), session
// list, open conversations, the current view, and the document title. Text is
// resolved at render time via t(), so re-rendering is the whole mechanism.
onLocaleChange(() => {
  if (!appState.me) return; // pre-login gates pick up the locale on next render
  mountShell();
  renderSidebarTop();
  renderList();
  for (const conv of allConversations()) conv.redraw();
  refreshActiveView(appState.currentView);
  syncDocumentTitle();
});

void bootSafely();
