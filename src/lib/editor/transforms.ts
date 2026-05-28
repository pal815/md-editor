import type { ChangeSpec, Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Iterate every line touched by the current selection, deduplicated.
 * The callback receives the Line object; mutations should be expressed as
 * ChangeSpec entries returned via the `changes` array.
 */
function forEachSelectedLine(
  view: EditorView,
  callback: (line: Line, changes: ChangeSpec[]) => void,
): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      callback(view.state.doc.line(n), changes);
    }
  }
  return changes;
}

/**
 * Set the heading level of every line that intersects the current selection.
 *   level 1..6 → ATX heading (#, ##, …)
 *   level 0    → strip heading marker, return to paragraph text
 */
export function setHeadingLevel(view: EditorView, level: number): void {
  const changes = forEachSelectedLine(view, (line, out) => {
    const stripped = line.text.replace(/^#{1,6}\s+/, "");
    const next = level === 0 ? stripped : "#".repeat(level) + " " + stripped;
    if (next !== line.text) {
      out.push({ from: line.from, to: line.to, insert: next });
    }
  });
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

/**
 * Toggle `marker` around the primary selection.
 *
 *   - Empty selection between existing markers      → strip the markers
 *   - Empty selection elsewhere                     → insert marker + placeholder
 *                                                     + marker, select placeholder
 *   - Selection that itself starts/ends with marker → strip them
 *   - Selection sandwiched between markers          → strip the surrounding markers
 *   - Anything else                                 → wrap with marker on both sides
 */
export function wrapInline(
  view: EditorView,
  marker: string,
  placeholder = "",
): void {
  const main = view.state.selection.main;
  const len = marker.length;
  const docLen = view.state.doc.length;

  if (main.empty) {
    const before = view.state.sliceDoc(Math.max(0, main.from - len), main.from);
    const after = view.state.sliceDoc(
      main.from,
      Math.min(docLen, main.from + len),
    );
    if (before === marker && after === marker) {
      // Cursor between empty markers (e.g. `**|**`) → strip both.
      view.dispatch({
        changes: {
          from: main.from - len,
          to: main.from + len,
          insert: "",
        },
        selection: { anchor: main.from - len },
      });
      view.focus();
      return;
    }
    // Insert marker + placeholder + marker, select placeholder.
    const insert = `${marker}${placeholder}${marker}`;
    view.dispatch({
      changes: { from: main.from, insert },
      selection: {
        anchor: main.from + len,
        head: main.from + len + placeholder.length,
      },
    });
    view.focus();
    return;
  }

  const selected = view.state.sliceDoc(main.from, main.to);

  // Case: the selection itself includes the markers (user selected `**text**`).
  if (
    selected.length >= 2 * len &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(len, selected.length - len);
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: inner },
      selection: { anchor: main.from, head: main.from + inner.length },
    });
    view.focus();
    return;
  }

  // Case: the selection is the inner content, markers are just outside it
  // (e.g. `**[text]**` — typical state after a previous wrap call).
  const before = view.state.sliceDoc(Math.max(0, main.from - len), main.from);
  const after = view.state.sliceDoc(main.to, Math.min(docLen, main.to + len));
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: main.from - len, to: main.from, insert: "" },
        { from: main.to, to: main.to + len, insert: "" },
      ],
      selection: { anchor: main.from - len, head: main.to - len },
    });
    view.focus();
    return;
  }

  // Default: wrap.
  view.dispatch({
    changes: {
      from: main.from,
      to: main.to,
      insert: `${marker}${selected}${marker}`,
    },
    selection: {
      anchor: main.from + len,
      head: main.from + len + selected.length,
    },
  });
  view.focus();
}

/**
 * Prepend (or replace existing) a line prefix on every line in the selection.
 *   - Used for blockquote (`> `), bullet list (`- `), numbered list (`1. `),
 *     and task list (`- [ ] `).
 *   - `pattern` is the regex matching an existing prefix to replace; if a line
 *     already has the exact `prefix`, it's stripped (toggle behaviour).
 */
export function toggleLinePrefix(
  view: EditorView,
  prefix: string,
  pattern: RegExp,
): void {
  const changes = forEachSelectedLine(view, (line, out) => {
    if (line.text.startsWith(prefix)) {
      out.push({
        from: line.from,
        to: line.from + prefix.length,
        insert: "",
      });
      return;
    }
    if (pattern.test(line.text)) {
      const next = line.text.replace(pattern, prefix);
      out.push({ from: line.from, to: line.to, insert: next });
      return;
    }
    out.push({ from: line.from, insert: prefix });
  });
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

/** Convenience wrappers built on `toggleLinePrefix`. */
export function toggleBlockquote(view: EditorView): void {
  toggleLinePrefix(view, "> ", /^(>+\s+|-+\s+|\d+\.\s+|-\s+\[[ x]\]\s+)/);
}
export function toggleBulletList(view: EditorView): void {
  toggleLinePrefix(view, "- ", /^(>+\s+|-+\s+|\d+\.\s+|-\s+\[[ x]\]\s+)/);
}
export function toggleNumberedList(view: EditorView): void {
  toggleLinePrefix(view, "1. ", /^(>+\s+|-+\s+|\d+\.\s+|-\s+\[[ x]\]\s+)/);
}
export function toggleTaskList(view: EditorView): void {
  toggleLinePrefix(view, "- [ ] ", /^(>+\s+|-+\s+|\d+\.\s+|-\s+\[[ x]\]\s+)/);
}

/**
 * Insert a fresh markdown table at the cursor. Defaults to a 2 × 2 grid:
 *   - 2 columns
 *   - 1 header row + 1 data row (the alignment row is implicit)
 */
export function insertTable(
  view: EditorView,
  cols = 2,
  rows = 2,
): void {
  const colWidth = 8;
  const pad = (s: string) => s.padEnd(colWidth, " ");

  const headerCells: string[] = [];
  const alignCells: string[] = [];
  const dataRows: string[][] = [];

  for (let c = 0; c < cols; c++) {
    headerCells.push(pad(`Header ${c + 1}`));
    alignCells.push("-".repeat(colWidth));
  }
  for (let r = 1; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(pad(""));
    dataRows.push(cells);
  }

  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = [
    line(headerCells),
    line(alignCells),
    ...dataRows.map(line),
  ];

  // Ensure the table starts on its own line.
  const main = view.state.selection.main;
  const here = view.state.doc.lineAt(main.from);
  const prefix = here.text.length > 0 ? "\n\n" : "";
  const suffix = "\n";
  const insert = prefix + lines.join("\n") + suffix;

  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: { anchor: main.from + prefix.length + 2 }, // cursor inside first header cell
  });
  view.focus();
}

/**
 * Insert a fenced code block with the given language tag.
 * If text is selected, that text becomes the body; otherwise the cursor lands
 * inside an empty body for typing.
 */
export function insertCodeBlock(view: EditorView, language = ""): void {
  const main = view.state.selection.main;
  const selected = view.state.sliceDoc(main.from, main.to);
  const lang = language.trim();
  const here = view.state.doc.lineAt(main.from);
  const prefix = here.text.length > 0 ? "\n\n" : "";

  const opener = "```" + lang;
  const closer = "```";
  const body = selected || "";
  const insert = `${prefix}${opener}\n${body}\n${closer}\n`;

  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: { anchor: main.from + prefix.length + opener.length + 1 },
  });
  view.focus();
}

/** Insert `---` (thematic break) on its own line. */
export function insertHorizontalRule(view: EditorView): void {
  const main = view.state.selection.main;
  const here = view.state.doc.lineAt(main.from);
  const prefix = here.text.length > 0 ? "\n\n" : "";
  const insert = `${prefix}---\n`;
  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: { anchor: main.from + insert.length },
  });
  view.focus();
}

/** Insert a plain markdown link, prompting the user for the URL afterwards. */
export function insertLink(view: EditorView, url = "https://"): void {
  const main = view.state.selection.main;
  const selected = view.state.sliceDoc(main.from, main.to);
  const label = selected || "link text";
  const insert = `[${label}](${url})`;
  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: {
      anchor: main.from + 1,
      head: main.from + 1 + label.length,
    },
  });
  view.focus();
}
