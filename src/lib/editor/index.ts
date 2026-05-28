import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import {
  bracketMatching,
  indentOnInput,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { themeExtension, registerEditor, unregisterEditor } from "../theme";
import { linkSupport } from "./link-click";
import { livePreview } from "./live-preview";
import { tableWidget } from "./table-widget";
import { tableTsvCopy } from "./table-copy";
import {
  enterTableAutocomplete,
  enhancedEnterInTable,
  ctrlEnterExitTable,
  pipeColumnSync,
} from "./table-autocomplete";
import { wrapInline } from "./transforms";

// Language packages for nested code-block highlighting.
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";

/**
 * A no-op StreamLanguage used to register ``` text ``` / ``` plain ``` etc.
 * so the fenced block is recognised as a code block but no tokens are emitted.
 */
const plainTextLanguage = StreamLanguage.define({
  token(stream) {
    stream.skipToEnd();
    return null;
  },
});

/**
 * Languages available inside fenced code blocks (```python, ```sql, etc.).
 * Add a new LanguageDescription to extend support.
 */
const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "markdown",
    alias: ["md", "mkd", "mdown"],
    extensions: ["md", "markdown"],
    // Nested markdown — uses the same GFM-flavoured base as the outer document.
    load: async () => markdown({ base: markdownLanguage }),
  }),
  LanguageDescription.of({
    name: "text",
    alias: ["txt", "plain", "plaintext"],
    load: async () => new LanguageSupport(plainTextLanguage),
  }),
  LanguageDescription.of({
    name: "python",
    alias: ["py"],
    extensions: ["py"],
    load: async () => python(),
  }),
  LanguageDescription.of({
    name: "sql",
    alias: ["postgres", "postgresql", "mysql", "sqlite"],
    extensions: ["sql"],
    load: async () => sql(),
  }),
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "ts", "typescript", "jsx", "tsx"],
    extensions: ["js", "ts", "jsx", "tsx"],
    load: async () => javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: "json",
    extensions: ["json"],
    load: async () => json(),
  }),
  LanguageDescription.of({
    name: "html",
    alias: ["htm", "xml"],
    extensions: ["html", "htm"],
    load: async () => html(),
  }),
  LanguageDescription.of({
    name: "css",
    extensions: ["css"],
    load: async () => css(),
  }),
  LanguageDescription.of({
    name: "rust",
    alias: ["rs"],
    extensions: ["rs"],
    load: async () => rust(),
  }),
  LanguageDescription.of({
    name: "yaml",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: async () => yaml(),
  }),
];

export interface EditorCallbacks {
  /** Fired whenever the document text changes. */
  onContentChange?: (content: string) => void;
  /**
   * Fired whenever the cursor moves.
   *   line/column: 1-based human-readable coordinates
   *   pos:        0-based absolute offset within the document
   */
  onCursorChange?: (line: number, column: number, pos: number) => void;
}

export interface CreateEditorOptions extends EditorCallbacks {
  parent: HTMLElement;
  initialContent?: string;
}

/**
 * Create a CodeMirror 6 instance configured for markdown editing:
 * - Line numbers gutter
 * - Soft wrap (no horizontal scroll)
 * - GFM-flavored markdown (tables, autolinks, strikethrough, task lists)
 * - Syntax highlighting inside fenced code blocks for popular languages
 * - One Dark theme
 */
export function createMarkdownEditor(opts: CreateEditorOptions): EditorView {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && opts.onContentChange) {
      opts.onContentChange(update.state.doc.toString());
    }
    if ((update.selectionSet || update.docChanged) && opts.onCursorChange) {
      const head = update.state.selection.main.head;
      const line = update.state.doc.lineAt(head);
      opts.onCursorChange(line.number, head - line.from + 1, head);
    }
  });

  const state = EditorState.create({
    doc: opts.initialContent ?? "",
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        codeLanguages,
        extensions: [GFM],
        addKeymap: true,
      }),
      keymap.of([
        {
          // Enter inside a markdown table routes between four behaviours:
          //   - alignment row → swallow (don't break the layout)
          //   - empty data row → exit table (cursor on fresh blank line)
          //   - past the row's last `|` → append empty row to the block
          //   - inside a cell → insert `<br>` (in-cell line break)
          //
          // If the block has no alignment row yet, `enterTableAutocomplete`
          // synthesises one + an empty data row so the user can keep typing.
          key: "Enter",
          run: (view) =>
            enhancedEnterInTable(view) || enterTableAutocomplete(view),
        },
        {
          // Ctrl+Enter / Cmd+Enter anywhere inside a table = exit table,
          // putting the cursor on a fresh plain line below the block.
          key: "Mod-Enter",
          run: ctrlEnterExitTable,
        },
        {
          // Typing `|` inside a table row keeps every other row in sync so
          // the user doesn't have to manually add an empty cell in each row.
          key: "|",
          run: pipeColumnSync,
        },
        {
          key: "Mod-b",
          run: (view) => {
            wrapInline(view, "**", "text");
            return true;
          },
        },
        {
          key: "Mod-i",
          run: (view) => {
            wrapInline(view, "*", "text");
            return true;
          },
        },
        {
          key: "Mod-`",
          run: (view) => {
            wrapInline(view, "`", "code");
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      themeExtension(),
      linkSupport(),
      livePreview,
      tableWidget,
      tableTsvCopy,
      updateListener,
    ],
  });

  const view = new EditorView({ state, parent: opts.parent });
  registerEditor(view);
  return view;
}

/**
 * Tear down an editor view AND unregister it from theme tracking so theme
 * dispatches don't leak after the editor is gone.
 */
export function destroyMarkdownEditor(view: EditorView): void {
  unregisterEditor(view);
  view.destroy();
}

/**
 * Replace the entire document content of an editor.
 * Use when loading a file, creating a new buffer, or switching tabs.
 * `cursorPos` is the 0-based offset to place the cursor at (clamped to the
 * new content length).
 */
export function setEditorContent(
  view: EditorView,
  content: string,
  cursorPos = 0,
): void {
  const anchor = Math.max(0, Math.min(cursorPos, content.length));
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: content,
    },
    selection: { anchor },
  });
}

/** Read the current document text from the editor. */
export function getEditorContent(view: EditorView): string {
  return view.state.doc.toString();
}
