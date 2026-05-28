/**
 * Theme management: light / dark / follow-system.
 *
 * Responsibilities:
 *   - Read & persist the user's theme preference (via Rust `load_settings` /
 *     `save_settings`).
 *   - Apply the resolved theme to the document (`<html data-theme="...">`),
 *     which drives all CSS custom-property values.
 *   - Expose a CodeMirror Compartment so the editor can be reconfigured with
 *     the matching theme extension without rebuilding the state.
 *   - Listen to OS-level `prefers-color-scheme` changes when the user is on
 *     "system" mode and re-apply automatically.
 */

import { invoke } from "@tauri-apps/api/core";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";

/** Theme preference as stored on disk. */
export type ThemePref = "light" | "dark" | "system";

/** Effective theme actually applied to the UI (never "system"). */
export type ResolvedTheme = "light" | "dark";

/* ── State ──────────────────────────────────────────────────────────── */

let currentPref: ThemePref = "system";
let currentResolved: ResolvedTheme = "dark";
const themeCompartment = new Compartment();
const editors = new Set<EditorView>();
const subscribers = new Set<(resolved: ResolvedTheme, pref: ThemePref) => void>();
let mediaQuery: MediaQueryList | null = null;

/* ── Backend settings shape (only the theme field is relevant here) ──── */

interface SettingsShape {
  theme?: string;
  allowExternalImages?: boolean;
  viewMode?: string;
}

/* ── Public API ─────────────────────────────────────────────────────── */

/** Returns the CodeMirror extension that can be reconfigured per-theme. */
export function themeExtension(): Extension {
  return themeCompartment.of(extensionFor(currentResolved));
}

/** Register a freshly-created EditorView so it can be reconfigured on theme
 *  changes. The caller should unregister on destroy. */
export function registerEditor(view: EditorView): void {
  editors.add(view);
}
export function unregisterEditor(view: EditorView): void {
  editors.delete(view);
}

/** Subscribe to theme changes. Useful for components that want to react in JS
 *  (e.g. a status-bar indicator). */
export function subscribeTheme(
  fn: (resolved: ResolvedTheme, pref: ThemePref) => void,
): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Current user preference ("light"/"dark"/"system"). */
export function getThemePref(): ThemePref {
  return currentPref;
}

/** Current effective theme ("light"/"dark"). */
export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

/** Load the persisted preference, apply it, and start listening for OS
 *  scheme changes. Call once on app mount. */
export async function initTheme(): Promise<void> {
  let pref: ThemePref = "system";
  try {
    const s = await invoke<SettingsShape>("load_settings");
    pref = normalizePref(s?.theme);
  } catch {
    // Backend not ready / first run — fall through to default.
  }
  attachMediaListener();
  applyPref(pref, /* persist */ false);
}

/** Switch theme preference and persist it. */
export async function setThemePref(pref: ThemePref): Promise<void> {
  applyPref(pref, /* persist */ true);
}

/* ── Internals ──────────────────────────────────────────────────────── */

function normalizePref(raw: unknown): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "system";
}

function resolvePref(pref: ThemePref): ResolvedTheme {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  // "system": consult the media query. Default to dark if unavailable.
  if (mediaQuery) return mediaQuery.matches ? "dark" : "light";
  return "dark";
}

function extensionFor(resolved: ResolvedTheme): Extension {
  return resolved === "dark" ? oneDark : lightEditorTheme;
}

function applyPref(pref: ThemePref, persist: boolean): void {
  currentPref = pref;
  const resolved = resolvePref(pref);
  currentResolved = resolved;

  // 1. Drive the CSS via a single attribute on <html>.
  document.documentElement.setAttribute("data-theme", resolved);

  // 2. Reconfigure every live editor.
  const ext = extensionFor(resolved);
  for (const view of editors) {
    view.dispatch({ effects: themeCompartment.reconfigure(ext) });
  }

  // 3. Notify subscribers.
  for (const fn of subscribers) fn(resolved, pref);

  // 4. Persist (fire-and-forget; failure means next launch picks default).
  if (persist) {
    void persistTheme(pref);
  }
}

async function persistTheme(pref: ThemePref): Promise<void> {
  try {
    // Read-modify-write so we preserve other settings fields (added later).
    const existing = await invoke<SettingsShape>("load_settings").catch(
      () => ({}) as SettingsShape,
    );
    const next: SettingsShape = { ...existing, theme: pref };
    await invoke<void>("save_settings", { settings: next });
  } catch {
    // best-effort
  }
}

function attachMediaListener(): void {
  if (mediaQuery || typeof window === "undefined" || !window.matchMedia) return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    // Only re-apply if the user is on "system" mode.
    if (currentPref === "system") applyPref("system", /* persist */ false);
  });
}

/* ── Light CodeMirror theme ─────────────────────────────────────────── */

/**
 * A purpose-built light theme for CodeMirror that pairs with our light-mode
 * CSS tokens. Uses semi-transparent surfaces so the editor inherits the host
 * page background where appropriate (matching oneDark's behaviour).
 */
const lightEditorTheme: Extension = EditorView.theme(
  {
    "&": {
      color: "#1f1f1f",
      backgroundColor: "transparent",
    },
    ".cm-content": {
      caretColor: "#0078d4",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#0078d4",
    },
    "&.cm-focused .cm-selectionBackgroundLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "#cfe4ff",
      },
    ".cm-activeLine": {
      backgroundColor: "rgba(0, 120, 212, 0.06)",
    },
    ".cm-gutters": {
      backgroundColor: "#f7f7f7",
      color: "#888",
      border: "none",
      borderRight: "1px solid #e0e0e0",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(0, 120, 212, 0.08)",
      color: "#0078d4",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 4px 0 8px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: "#999",
    },
    ".cm-tooltip": {
      backgroundColor: "#fff",
      border: "1px solid #d4d4d4",
      color: "#1f1f1f",
    },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      outline: "1px solid #0078d4",
      backgroundColor: "transparent",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(255, 200, 0, 0.4)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(255, 160, 0, 0.7)",
    },
  },
  { dark: false },
);
