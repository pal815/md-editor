/**
 * Markdown → safe HTML pipeline for Viewer mode.
 *
 * The pipeline is:
 *   1. Rust `render_markdown` (pulldown-cmark) emits HTML from the source.
 *      We allow raw inline HTML at this stage because some markdown documents
 *      legitimately need things like `<details>` or `<sub>`.
 *   2. DOMPurify strips anything dangerous (scripts, event handlers,
 *      javascript: URLs, dangerous element nesting, etc.) before the HTML
 *      ever touches the document.
 *   3. External http(s) image src attributes are rewritten to a placeholder
 *      unless the user has explicitly opted in via `allowExternalImages`.
 *
 * **Why three stages instead of just DOMPurify?**
 * pulldown-cmark already escapes characters from the markdown source itself
 * (so a `*` typed by the user can't become `<script>`). DOMPurify then deals
 * with raw HTML the user did include intentionally.
 */

import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";

/** Schemes we allow in href / src after purification. */
const SAFE_URI_REGEX = /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);)/i;
/** Local-only schemes the editor itself uses (Tauri asset proto). */
const LOCAL_SCHEME_REGEX = /^(?:asset:|tauri:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);)/i;

interface RenderOptions {
  /** When false, external https images are replaced with a placeholder. */
  allowExternalImages: boolean;
}

/**
 * Convert markdown source to sanitized HTML suitable for innerHTML assignment.
 * Returns an empty string for empty input.
 */
export async function renderMarkdownSafe(
  source: string,
  opts: RenderOptions,
): Promise<string> {
  if (!source) return "";

  // 1. Markdown → HTML (Rust)
  const raw = await invoke<string>("render_markdown", { source });

  // 2. Configure DOMPurify per-call (the hook closes over `opts`).
  const purify = DOMPurify;
  purify.removeAllHooks();

  purify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;

    // Re-check href / src URLs that survived DOMPurify's default filter.
    for (const attr of ["href", "src"] as const) {
      const value = node.getAttribute(attr);
      if (!value) continue;
      if (LOCAL_SCHEME_REGEX.test(value)) continue;
      if (!SAFE_URI_REGEX.test(value)) {
        node.removeAttribute(attr);
        continue;
      }
      // External image gating.
      if (attr === "src" && node.tagName === "IMG" && !opts.allowExternalImages) {
        // /^https?:/i match means it's external — swap for a marker so the
        // user can see something is hidden.
        if (/^https?:/i.test(value)) {
          node.removeAttribute("src");
          node.setAttribute("data-blocked-src", value);
          node.setAttribute(
            "alt",
            `${node.getAttribute("alt") ?? ""} [external image blocked]`.trim(),
          );
        }
      }
    }

    // Force every link to open externally (the host already has Ctrl-click
    // semantics for editor links; here we make plain clicks safe).
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });

  // 3. Run the actual sanitizer.
  const clean = purify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["form", "input", "button", "iframe", "object", "embed", "style"],
    FORBID_ATTR: ["style"],
    // Keep the safe content; DOMPurify defaults already strip <script>,
    // on* attributes, and javascript: URLs.
    ALLOW_DATA_ATTR: true,
    KEEP_CONTENT: true,
  });

  // Clean up the hook so it doesn't leak into a future call with different
  // opts (DOMPurify hooks are global to the singleton).
  purify.removeAllHooks();
  return clean;
}
