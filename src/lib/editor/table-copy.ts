/**
 * Excel-style table copy.
 *
 * Three paths trigger TSV conversion:
 *   1. CodeMirror selection that consists ENTIRELY of one or more contiguous
 *      markdown table blocks (cursor inside source mode). Default markdown
 *      pipe text gets replaced with TSV + HTML on copy.
 *   2. DOM selection inside a rendered table widget (widget mode). The
 *      browser's selection covers `<th>`/`<td>` text but Ctrl+C would
 *      otherwise just emit the raw cell text concatenated; we intercept and
 *      build clean TSV/HTML so Excel and Sheets accept it cleanly.
 *   3. Explicit "Copy as TSV / HTML" context-menu actions (see table-ops
 *      consumers — those bypass the heuristics and always convert).
 */

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

export interface TableClipPayload {
  /** Tab-separated, one row per line. Cells with newlines are quoted. */
  tsv: string;
  /** `<table>...</table>` markup. `<br>` inside cells is preserved. */
  html: string;
}

/* ── Markdown table parsing helpers (kept local; mirrors table-ops.ts) ── */

function isTableLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

function isAlignmentLine(text: string): boolean {
  const t = text.trim();
  return /^\|[\s\-:|]+\|$/.test(t) && /-/.test(t);
}

function parseCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      buf += "|"; // unescape for clipboard output
      i++;
      continue;
    }
    if (t[i] === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += t[i];
  }
  cells.push(buf.trim());
  return cells;
}

/* ── TSV / HTML emitters ───────────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cellToHtml(raw: string): string {
  // The markdown `<br>` line-break marker becomes a real <br>. Everything
  // else is escaped (we never trust source HTML for clipboard output).
  return raw
    .split(/<br\s*\/?>/i)
    .map(escapeHtml)
    .join("<br>");
}

function cellToTsv(raw: string): string {
  // Convert <br> markers to real LF, then quote the cell if it contains a
  // tab or newline (Excel-compatible TSV quoting: double quotes, with inner
  // double-quotes escaped as "").
  const expanded = raw.replace(/<br\s*\/?>/gi, "\n");
  if (/[\t\n"]/.test(expanded)) {
    return `"${expanded.replace(/"/g, '""')}"`;
  }
  return expanded;
}

/**
 * Convert a parsed table (`rows` includes the alignment row) into TSV + HTML
 * payloads, dropping the alignment row.
 */
export function tableRowsToPayload(
  rows: string[][],
  alignLineIdx: number,
): TableClipPayload {
  const tsvLines: string[] = [];
  const htmlBodyRows: string[] = [];
  const htmlHeaderRows: string[] = [];

  for (let r = 0; r < rows.length; r++) {
    if (r === alignLineIdx) continue;
    const isHeader = r < alignLineIdx;

    tsvLines.push(rows[r].map(cellToTsv).join("\t"));

    const tag = isHeader ? "th" : "td";
    const cellsHtml = rows[r]
      .map((c) => `<${tag}>${cellToHtml(c)}</${tag}>`)
      .join("");
    const rowHtml = `<tr>${cellsHtml}</tr>`;
    if (isHeader) htmlHeaderRows.push(rowHtml);
    else htmlBodyRows.push(rowHtml);
  }

  const html =
    `<table>` +
    (htmlHeaderRows.length ? `<thead>${htmlHeaderRows.join("")}</thead>` : "") +
    (htmlBodyRows.length ? `<tbody>${htmlBodyRows.join("")}</tbody>` : "") +
    `</table>`;

  return { tsv: tsvLines.join("\n"), html };
}

/* ── Markdown-source matching ──────────────────────────────────────────── */

interface TableBlock {
  startLine: number;
  endLine: number;
  rows: string[][];
  alignLineIdx: number;
}

/** Parse the table block at `startLine` if there is one; else null. */
function parseBlockAt(state: EditorState, startLine: number): TableBlock | null {
  const total = state.doc.lines;
  if (startLine < 1 || startLine > total) return null;
  if (!isTableLine(state.doc.line(startLine).text)) return null;

  let endLine = startLine;
  while (endLine < total) {
    const next = state.doc.line(endLine + 1);
    if (!isTableLine(next.text)) break;
    endLine++;
  }
  if (endLine - startLine + 1 < 2) return null;

  const rows: string[][] = [];
  let alignLineIdx = -1;
  for (let i = startLine; i <= endLine; i++) {
    const text = state.doc.line(i).text;
    if (alignLineIdx === -1 && isAlignmentLine(text)) {
      alignLineIdx = i - startLine;
    }
    rows.push(parseCells(text));
  }
  if (alignLineIdx === -1) return null;
  return { startLine, endLine, rows, alignLineIdx };
}

/**
 * If the CodeMirror selection consists EXACTLY of one or more contiguous
 * table blocks (no other text, no partial cells), return their combined
 * payload. Otherwise null.
 */
function payloadFromCmSelection(view: EditorView): TableClipPayload | null {
  const sel = view.state.selection.main;
  if (sel.empty) return null;

  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  // Selection must start at column 0 of a table line and end at the EOL of
  // a table line — otherwise the user has a partial selection that's better
  // served by the default copy behaviour.
  if (sel.from !== startLine.from) return null;
  if (sel.to !== endLine.to) return null;

  // Every line in the selection must be a table line (no plain prose mixed in).
  for (let n = startLine.number; n <= endLine.number; n++) {
    if (!isTableLine(view.state.doc.line(n).text)) return null;
  }

  // Walk the selected range and collect contiguous table blocks.
  const blocks: TableBlock[] = [];
  let n = startLine.number;
  while (n <= endLine.number) {
    const block = parseBlockAt(view.state, n);
    if (!block) return null;
    blocks.push(block);
    n = block.endLine + 1;
  }

  if (blocks.length === 0) return null;
  if (blocks.length === 1) {
    return tableRowsToPayload(blocks[0].rows, blocks[0].alignLineIdx);
  }
  // Multiple blocks → concatenate their TSV with a blank line between, and
  // their HTML one after the other.
  const tsv = blocks
    .map((b) => tableRowsToPayload(b.rows, b.alignLineIdx).tsv)
    .join("\n\n");
  const html = blocks
    .map((b) => tableRowsToPayload(b.rows, b.alignLineIdx).html)
    .join("");
  return { tsv, html };
}

/* ── DOM (widget) matching ─────────────────────────────────────────────── */

function findEnclosingTable(node: Node | null): HTMLTableElement | null {
  let cur: Node | null = node;
  while (cur && cur !== document.body) {
    if (
      cur.nodeType === Node.ELEMENT_NODE &&
      (cur as Element).classList?.contains("cm-md-table")
    ) {
      return cur as HTMLTableElement;
    }
    cur = cur.parentNode;
  }
  return null;
}

/**
 * If the current DOM selection lies inside a rendered table widget, harvest
 * the rows/cells from that widget's DOM and convert. Returns null when the
 * selection is empty, multi-table, or outside any widget.
 */
function payloadFromDomSelection(): TableClipPayload | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const startTable = findEnclosingTable(range.startContainer);
  const endTable = findEnclosingTable(range.endContainer);
  if (!startTable || startTable !== endTable) return null;

  // Walk the table's DOM and collect rows/cells whose text intersects the
  // selection range.
  const rows: string[][] = [];
  let alignLineIdx = -1; // No alignment row in DOM (widget skips it). We
  // synthesise a value of 1 so the first row is treated as header (matches
  // how the widget actually renders the markdown).
  const trs = Array.from(startTable.querySelectorAll("tr"));
  if (trs.length === 0) return null;

  // Walk each row; include the row if any of its cells touch the selection.
  for (let r = 0; r < trs.length; r++) {
    const tr = trs[r];
    const cells = Array.from(tr.querySelectorAll("th, td"));
    let any = false;
    const rowCells: string[] = [];
    for (const cell of cells) {
      // Per-cell intersection check: a cell counts if any of its DOM range
      // overlaps the user selection.
      const cellRange = document.createRange();
      cellRange.selectNodeContents(cell);
      const intersects =
        range.compareBoundaryPoints(Range.END_TO_START, cellRange) <= 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, cellRange) >= 0;
      cellRange.detach?.();
      if (intersects) {
        any = true;
        rowCells.push(cellText(cell as HTMLElement));
      } else {
        rowCells.push("");
      }
    }
    if (any) rows.push(rowCells);
  }
  if (rows.length === 0) return null;

  // Determine the header boundary: in the widget DOM, header cells are <th>.
  // Find the index of the first row whose first cell isn't <th>.
  let headerRows = 0;
  for (let r = 0; r < trs.length; r++) {
    const first = trs[r].querySelector("th, td");
    if (first && first.tagName === "TH") headerRows++;
    else break;
  }
  // Insert a synthetic alignment row right after the header rows for the
  // payload converter's contract. But because we only emit a header row /
  // body row distinction in the HTML, we just pass it through.
  if (headerRows > 0) {
    // Insert a placeholder alignment row at headerRows; mark it as the align
    // index for the payload builder. The builder skips it on output.
    rows.splice(headerRows, 0, new Array(rows[0]?.length ?? 0).fill("---"));
    alignLineIdx = headerRows;
  } else {
    alignLineIdx = -1;
  }

  return tableRowsToPayload(rows, alignLineIdx);
}

function cellText(el: HTMLElement): string {
  // Reconstruct the cell's original markdown-cell content: text nodes joined
  // verbatim, with `<br>` elements rendered as the `<br>` marker (so the
  // payload's tsv/html stages can re-emit them faithfully).
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const e = child as HTMLElement;
      if (e.tagName === "BR") out += "<br>";
      else out += e.textContent ?? "";
    }
  }
  return out.trim();
}

/* ── Public clipboard helpers ──────────────────────────────────────────── */

function writePayload(event: ClipboardEvent, payload: TableClipPayload): void {
  event.preventDefault();
  event.clipboardData?.setData("text/plain", payload.tsv);
  event.clipboardData?.setData("text/html", payload.html);
}

/**
 * The CodeMirror extension that wires the auto-conversion path. Add it to
 * the editor's extension list. Returns true when it actually replaced the
 * clipboard payload; false to let the default copy proceed.
 */
export const tableTsvCopy = EditorView.domEventHandlers({
  copy: (event, view) => {
    // 1. Source-mode: selection wraps complete table block(s) in the markdown
    //    source.
    const fromCm = payloadFromCmSelection(view);
    if (fromCm) {
      writePayload(event, fromCm);
      return true;
    }
    // 2. Widget-mode: user has highlighted text inside a rendered widget.
    const fromDom = payloadFromDomSelection();
    if (fromDom) {
      writePayload(event, fromDom);
      return true;
    }
    return false;
  },
});

/**
 * Imperatively copy the table that the cursor is currently inside (used by
 * the context-menu actions). Returns whether anything was copied.
 */
export async function copyTableAtCursor(
  view: EditorView,
  format: "tsv" | "html" | "markdown",
): Promise<boolean> {
  const sel = view.state.selection.main;
  const block = parseBlockAt(view.state, view.state.doc.lineAt(sel.from).number);
  // The cursor line might be in the middle of the block; walk up to find the
  // actual start line.
  const actual = block ?? (() => {
    let n = view.state.doc.lineAt(sel.from).number;
    while (n > 1 && isTableLine(view.state.doc.line(n - 1).text)) n--;
    return parseBlockAt(view.state, n);
  })();
  if (!actual) return false;

  const payload = tableRowsToPayload(actual.rows, actual.alignLineIdx);

  try {
    if (format === "tsv") {
      await navigator.clipboard.writeText(payload.tsv);
    } else if (format === "html") {
      // ClipboardItem supports multiple formats so paste targets can pick.
      const html = new Blob([payload.html], { type: "text/html" });
      const text = new Blob([payload.tsv], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": html, "text/plain": text }),
      ]);
    } else {
      // markdown — round-trip the source lines as-is for fidelity.
      const startLine = view.state.doc.line(actual.startLine);
      const endLine = view.state.doc.line(actual.endLine);
      const src = view.state.doc.sliceString(startLine.from, endLine.to);
      await navigator.clipboard.writeText(src);
    }
    return true;
  } catch {
    return false;
  }
}
