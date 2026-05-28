/**
 * Post-render enhancements for Viewer-mode HTML.
 *
 *   - `highlightCodeBlocks` colours `<pre><code class="language-XXX">` blocks
 *     using highlight.js. Languages mirror the set the editor supports for
 *     fenced code blocks. Auto-detection runs when no language is specified.
 *   - `linkifyBareUrls` walks text nodes and turns plain `http(s)://...` runs
 *     into clickable `<a target="_blank" rel="noopener noreferrer">`.
 *
 * Both run AFTER DOMPurify has sanitised the markdown output, so they only
 * ever touch text nodes / class-prefixed code elements we know are safe.
 */

// Use the core build + register only the languages we actually want. This
// keeps the bundle small (~30KB gz instead of ~700KB for the full package).
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import jsonLang from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml"; // covers html
import cssLang from "highlight.js/lib/languages/css";
import rustLang from "highlight.js/lib/languages/rust";
import yamlLang from "highlight.js/lib/languages/yaml";
import markdownLang from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("json", jsonLang);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", cssLang);
hljs.registerLanguage("rust", rustLang);
hljs.registerLanguage("yaml", yamlLang);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("plaintext", plaintext);

// Aliases users actually type in fenced code fences.
hljs.registerAliases(["js"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx", "jsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["postgresql", "postgres", "mysql", "sqlite"], {
  languageName: "sql",
});
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md", "mkd", "mdown"], { languageName: "markdown" });
hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
hljs.registerAliases(["text", "txt", "plain"], { languageName: "plaintext" });

hljs.configure({
  ignoreUnescapedHTML: true, // the input is already sanitized
  cssSelector: "pre code",
});

/**
 * Apply syntax highlighting to every `<pre><code>` inside `root`.
 * Idempotent — already-highlighted blocks are skipped.
 */
export function highlightCodeBlocks(root: ParentNode): void {
  const blocks = root.querySelectorAll<HTMLElement>("pre code");
  for (const block of blocks) {
    if (block.dataset.highlighted === "yes") continue;

    const lang = languageFromClass(block.className);
    // Mermaid blocks are handled separately by renderMermaid — never syntax
    // highlight them (they get replaced with a rendered SVG diagram).
    if (lang === "mermaid") continue;
    try {
      if (lang && hljs.getLanguage(lang)) {
        const text = block.textContent ?? "";
        const result = hljs.highlight(text, { language: lang, ignoreIllegals: true });
        block.innerHTML = result.value;
        block.classList.add(`language-${lang}`, "hljs");
      } else {
        // Fallback: auto-detect (only for short snippets to avoid the
        // expensive language scan on big blocks).
        const text = block.textContent ?? "";
        if (text.length < 50_000) {
          const result = hljs.highlightAuto(text);
          block.innerHTML = result.value;
          if (result.language) {
            block.classList.add(`language-${result.language}`);
          }
          block.classList.add("hljs");
        }
      }
      block.dataset.highlighted = "yes";
    } catch {
      // Highlighting is best-effort; never break the viewer over it.
    }
  }
}

function languageFromClass(cls: string): string | null {
  // pulldown-cmark emits `language-XXX`; some authors use `lang-XXX` so we
  // accept both. Class string can have multiple classes.
  for (const c of cls.split(/\s+/)) {
    const m = c.match(/^(?:language|lang)-(.+)$/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/* ── Bare-URL linkification ────────────────────────────────────────────── */

// Match http(s) URLs that look reasonable. The regex is conservative on the
// trailing characters: things like a period/comma/right-paren at the end are
// usually punctuation belonging to the surrounding prose, not the URL.
const BARE_URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])/g;

/**
 * Walk every text node under `root` and turn unwrapped http(s) URLs into
 * `<a>` elements. Existing `<a>`, `<code>`, and `<pre>` subtrees are left
 * alone — code samples shouldn't grow surprise hyperlinks, and authored
 * links shouldn't be double-wrapped.
 */
export function linkifyBareUrls(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement) return NodeFilter.FILTER_REJECT;
      // Skip anything inside <a>, <code>, <pre>, or anything we've already
      // marked as processed.
      let p: HTMLElement | null = node.parentElement;
      while (p && p !== root) {
        const tag = p.tagName;
        if (tag === "A" || tag === "CODE" || tag === "PRE") {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      // Cheap precheck before allocating: the regex test pattern.
      return BARE_URL_RE.test(node.nodeValue ?? "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  // Collect first; walking + mutating concurrently is asking for trouble.
  const targets: Text[] = [];
  let next: Node | null = walker.nextNode();
  while (next) {
    targets.push(next as Text);
    next = walker.nextNode();
  }

  for (const textNode of targets) {
    BARE_URL_RE.lastIndex = 0;
    const value = textNode.nodeValue ?? "";
    if (!BARE_URL_RE.test(value)) continue;

    BARE_URL_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = BARE_URL_RE.exec(value)) !== null) {
      if (m.index > lastIdx) {
        fragment.appendChild(
          document.createTextNode(value.slice(lastIdx, m.index)),
        );
      }
      const a = document.createElement("a");
      a.href = m[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = m[0];
      fragment.appendChild(a);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(lastIdx)));
    }
    textNode.replaceWith(fragment);
  }
}

/* ── Mermaid diagram rendering ─────────────────────────────────────────── */

// mermaid is heavy (~hundreds of KB), so we import it lazily — only the first
// time a viewer actually contains a ```mermaid block. The module is cached
// across calls.
type MermaidModule = typeof import("mermaid")["default"];
let mermaidPromise: Promise<MermaidModule> | null = null;
let mermaidThemeApplied: "dark" | "light" | null = null;

async function getMermaid(theme: "dark" | "light"): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  // (Re)initialize when the theme changes so diagrams match the UI theme.
  if (mermaidThemeApplied !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // sanitize labels, disable click handlers
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: '"Segoe UI", Inter, sans-serif',
    });
    mermaidThemeApplied = theme;
  }
  return mermaid;
}

let mermaidSeq = 0;

/**
 * Replace every ```mermaid code block under `root` with a rendered SVG
 * diagram. Parse errors leave the original code block untouched. Runs after
 * DOMPurify; mermaid's own `securityLevel: 'strict'` keeps the generated SVG
 * safe.
 */
export async function renderMermaid(
  root: Element,
  theme: "dark" | "light",
): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(
      "pre code.language-mermaid, pre code.lang-mermaid",
    ),
  );
  if (blocks.length === 0) return;

  let mermaid: MermaidModule;
  try {
    mermaid = await getMermaid(theme);
  } catch {
    return; // mermaid failed to load — leave code blocks as-is
  }

  for (const block of blocks) {
    const pre = block.closest("pre");
    if (!pre) continue;
    const source = block.textContent ?? "";
    if (!source.trim()) continue;
    try {
      const id = `mmd-${Date.now()}-${mermaidSeq++}`;
      const { svg } = await mermaid.render(id, source);
      const wrap = document.createElement("div");
      wrap.className = "mermaid-rendered";
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch {
      // Invalid diagram syntax — keep the source block visible so the user
      // can fix it rather than silently dropping content.
    }
  }
}

/**
 * Run every post-render enhancement on the viewer root. `theme` drives the
 * mermaid diagram palette. Async because mermaid rendering is async; callers
 * that don't care can ignore the promise.
 */
export async function enhanceViewer(
  root: Element,
  theme: "dark" | "light" = "dark",
): Promise<void> {
  highlightCodeBlocks(root);
  linkifyBareUrls(root);
  await renderMermaid(root, theme);
}
