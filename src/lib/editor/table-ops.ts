import type { EditorView } from "@codemirror/view";

/**
 * Parsed view of a markdown table at the cursor, including which cell the
 * cursor is currently inside.
 */
export interface TableInfo {
  /** 1-based line numbers of the table block in the editor. */
  startLine: number;
  endLine: number;
  /** Row index (within `rows`) of the `|---|---|` alignment line. */
  alignLineIdx: number;
  /** Parsed cells per row — `rows[r][c]` is the trimmed cell text. */
  rows: string[][];
  /** Row index (within `rows`) where the cursor is. */
  currentRowIdx: number;
  /** Column index where the cursor is. */
  currentColIdx: number;
}

/** A "table line" must start and end with `|` (after trimming). */
function isTableLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

/** The alignment line uses only `-`, `:`, `|`, and whitespace, and has a `-`. */
function isAlignmentLine(text: string): boolean {
  const t = text.trim();
  return /^\|[\s\-:|]+\|$/.test(t) && /-/.test(t);
}

/**
 * Split a table row into its cells. Strips the outer pipes and trims each
 * cell. Escaped pipes (`\|`) are kept inside cells.
 */
function parseCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  // Split on unescaped `|`.
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

/** Locate the table that contains the cursor, or null if there isn't one. */
export function getTableInfo(view: EditorView): TableInfo | null {
  const main = view.state.selection.main;
  const cursorLine = view.state.doc.lineAt(main.from);
  if (!isTableLine(cursorLine.text)) return null;

  // Scan up while consecutive lines are table lines.
  let startLine = cursorLine.number;
  while (startLine > 1) {
    const prev = view.state.doc.line(startLine - 1);
    if (!isTableLine(prev.text)) break;
    startLine--;
  }

  // Scan down.
  let endLine = cursorLine.number;
  const totalLines = view.state.doc.lines;
  while (endLine < totalLines) {
    const next = view.state.doc.line(endLine + 1);
    if (!isTableLine(next.text)) break;
    endLine++;
  }

  // Parse rows.
  const rows: string[][] = [];
  let alignLineIdx = -1;
  for (let n = startLine; n <= endLine; n++) {
    const text = view.state.doc.line(n).text;
    if (alignLineIdx === -1 && isAlignmentLine(text)) {
      alignLineIdx = n - startLine;
    }
    rows.push(parseCells(text));
  }

  // A valid markdown table needs an alignment row.
  if (alignLineIdx === -1) return null;

  // Determine current column by counting unescaped `|` chars to the left
  // of the cursor on its line.
  const cursorOffset = main.from - cursorLine.from;
  const before = cursorLine.text.slice(0, cursorOffset);
  let pipeCount = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "\\" && before[i + 1] === "|") {
      i++;
      continue;
    }
    if (before[i] === "|") pipeCount++;
  }
  // First `|` is the left border (column 0 starts after it). Pipes after
  // that increase the column index by 1 each.
  const currentColIdx = Math.max(0, pipeCount - 1);

  return {
    startLine,
    endLine,
    alignLineIdx,
    rows,
    currentRowIdx: cursorLine.number - startLine,
    currentColIdx,
  };
}

/** Re-render a parsed table as nicely-padded markdown text. */
function renderTable(rows: string[][], alignLineIdx: number): string {
  if (rows.length === 0) return "";
  const cols = rows[0].length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let max = 3; // minimum width to keep `---` legible
    for (let r = 0; r < rows.length; r++) {
      if (r === alignLineIdx) continue;
      max = Math.max(max, (rows[r][c] ?? "").length);
    }
    widths.push(max);
  }

  const lines: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const raw = rows[r][c] ?? "";
      if (r === alignLineIdx) {
        cells.push("-".repeat(widths[c]));
      } else {
        cells.push(raw.padEnd(widths[c], " "));
      }
    }
    lines.push("| " + cells.join(" | ") + " |");
  }
  return lines.join("\n");
}

/** Replace the table block in the document with newly-rendered text. */
function commitTable(
  view: EditorView,
  info: TableInfo,
  rows: string[][],
  alignLineIdx: number,
): void {
  const startLine = view.state.doc.line(info.startLine);
  const endLine = view.state.doc.line(info.endLine);
  const newText = renderTable(rows, alignLineIdx);
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: newText },
  });
  view.focus();
}

/* ── Mutations ─────────────────────────────────────────────────────────── */

export function insertColumn(
  view: EditorView,
  info: TableInfo,
  side: "left" | "right",
): void {
  const insertAt = side === "left" ? info.currentColIdx : info.currentColIdx + 1;
  const newRows = info.rows.map((row, r) => {
    const next = row.slice();
    next.splice(insertAt, 0, r === info.alignLineIdx ? "---" : "");
    return next;
  });
  commitTable(view, info, newRows, info.alignLineIdx);
}

export function insertRow(
  view: EditorView,
  info: TableInfo,
  side: "above" | "below",
): void {
  const cols = info.rows[0]?.length ?? 0;
  if (cols === 0) return;
  const newRow = new Array(cols).fill("");
  let insertAt =
    side === "above" ? info.currentRowIdx : info.currentRowIdx + 1;
  // The alignment row must stay in place; nudge insertion past it.
  if (insertAt === info.alignLineIdx) {
    insertAt = info.alignLineIdx + 1;
  }
  const newRows = info.rows.slice();
  newRows.splice(insertAt, 0, newRow);
  const newAlignIdx =
    insertAt <= info.alignLineIdx ? info.alignLineIdx + 1 : info.alignLineIdx;
  commitTable(view, info, newRows, newAlignIdx);
}

export function deleteColumn(view: EditorView, info: TableInfo): void {
  if ((info.rows[0]?.length ?? 0) <= 1) return; // refuse to delete the last column
  const newRows = info.rows.map((row) => {
    const next = row.slice();
    next.splice(info.currentColIdx, 1);
    return next;
  });
  commitTable(view, info, newRows, info.alignLineIdx);
}

export function deleteRow(view: EditorView, info: TableInfo): void {
  // Never delete the alignment row; if the user is on it, no-op.
  if (info.currentRowIdx === info.alignLineIdx) return;
  // Must keep at least the header + alignment + 1 data row, otherwise the
  // user ends up with a partial table that's invalid markdown.
  if (info.rows.length <= 2) return;
  const newRows = info.rows.slice();
  newRows.splice(info.currentRowIdx, 1);
  const newAlignIdx =
    info.currentRowIdx < info.alignLineIdx
      ? info.alignLineIdx - 1
      : info.alignLineIdx;
  commitTable(view, info, newRows, newAlignIdx);
}
