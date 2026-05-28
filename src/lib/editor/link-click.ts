import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Names of @lezer/markdown syntax-tree nodes that carry a URL we want to open.
 *   - `URL`           : the URL portion of `[text](URL)` markdown links
 *   - `URLAutolink`   : GFM bare URLs (https://...)
 *   - `Autolink`      : CommonMark autolinks `<https://...>` (includes brackets)
 */
const URL_NODES = new Set(["URL", "URLAutolink", "Autolink"]);

/**
 * Walk up the syntax tree from `pos` and return the first URL string we find,
 * or null if the position isn't inside any link-like node.
 */
function urlAtPos(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(
    pos,
    0,
  );
  while (node) {
    if (URL_NODES.has(node.type.name)) {
      const text = view.state.doc.sliceString(node.from, node.to);
      // Strip the angle brackets from CommonMark autolinks.
      return text.replace(/^<|>$/g, "");
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return null;
}

/**
 * Decoration: tag every URL/autolink span with `.cm-md-link` so CSS can
 * style and hint at clickability (e.g., pointer cursor when Ctrl is held).
 */
const linkDecoration = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const ranges: ReturnType<typeof Decoration.mark>[] = [];
      const builder: { from: number; to: number; deco: ReturnType<typeof Decoration.mark> }[] = [];
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (node) => {
            if (URL_NODES.has(node.type.name)) {
              builder.push({
                from: node.from,
                to: node.to,
                deco: Decoration.mark({ class: "cm-md-link" }),
              });
            }
          },
        });
      }
      // Decoration.set requires ranges in document order.
      builder.sort((a, b) => a.from - b.from || a.to - b.to);
      return Decoration.set(
        builder.map((b) => b.deco.range(b.from, b.to)),
      );
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Only `http(s)` URLs are passed to the OS opener. This blocks dangerous
 * schemes (`file://`, `javascript:`, `data:`, `vbscript:`, etc.) that a
 * malicious markdown file could otherwise smuggle through a Ctrl+Click.
 */
const SAFE_URL_SCHEME = /^https?:\/\//i;

/**
 * Ctrl/Cmd+Click on a URL opens it in the system browser through
 * the Tauri opener plugin.
 */
const linkClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.ctrlKey || event.metaKey)) return false;
    if (event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const url = urlAtPos(view, pos);
    if (!url) return false;
    if (!SAFE_URL_SCHEME.test(url)) {
      // eslint-disable-next-line no-console
      console.warn("Refusing to open non-http(s) URL:", url);
      return false;
    }
    event.preventDefault();
    // Fire-and-forget — we don't want to block the editor on this.
    openUrl(url).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Failed to open URL", url, err);
    });
    return true;
  },
});

/**
 * Track the Ctrl/Meta modifier state on `<body>` so CSS can switch the
 * cursor and underline style on links to communicate "Ctrl+Click to open".
 * Installed once per session.
 */
let modifierHooked = false;
function installModifierTracker() {
  if (modifierHooked || typeof document === "undefined") return;
  modifierHooked = true;
  const set = (on: boolean) =>
    document.body.classList.toggle("modifier-pressed", on);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) set(true);
  });
  document.addEventListener("keyup", (e) => {
    if (!e.ctrlKey && !e.metaKey) set(false);
  });
  window.addEventListener("blur", () => set(false));
}

/** Combined extension to plug into the editor. */
export function linkSupport() {
  installModifierTracker();
  return [linkDecoration, linkClickHandler];
}
