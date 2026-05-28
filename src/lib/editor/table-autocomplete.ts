/**
 * Editor helpers that smooth out the "I'm typing a table by hand" UX:
 *
 *   1. `enterTableAutocomplete` — when Enter is hit on a row that looks like
 *      a header (`| a | b |`) but the block has no alignment row yet, we
 *      auto-insert `| --- | --- |` plus an empty data row, and place the
 *      cursor in the first cell of the new row. From there on the existing
 *      Enter handler (which adds `<br>` inside cells) takes over.
 *
 *   2. `pipeColumnSync` — when the user types `|` inside a row of a table
 *      block, every OTHER row of the same block gets an empty cell inserted
 *      at the matching column position, in the SAME transaction. This means
 *      growing/shrinking columns no longer requires the user to edit every
 *      row manually.
 *
 * Both helpers operate on the "loose" definition of a table block: a run of
 * consecutive lines that start and end with `|`. The proper markdown
 * definition also requires an alignment row — we accept blocks without one
 * so that we can build them up incrementally.
 */

import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { getTableInfo, type TableInfo } from "./table-ops";

/* ── Local parsing helpers (mirror table-ops.ts / table-widget.ts) ────── */

function isTableLikeLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

function isAlignmentLine(text: string): boolean {
  const t = text.trim();
  return /^\|[\s\-:|]+\|$/.test(t) && /-/.test(t);
}

/** Split a row into cells, preserving escaped `\|` inside cells. */
function parseCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (t[i] === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += t[i];
  }
  cells.push(buf);
  return cells;
}

/** Offset (within `lineText`) of the `pipeIdx`-th unescaped `|`, or -1. */
function findPipeOffset(lineText: string, pipeIdx: number): number {
  let count = 0;
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === "\\" && lineText[i + 1] === "|") {
      i++;
      continue;
    }
    if (lineText[i] === "|") {
      if (count === pipeIdx) return i;
      count++;
    }
  }
  return -1;
}

/** Offset of the LAST unescaped `|` in `lineText`, or -1 if none. */
function findLastPipeOffset(lineText: string): number {
  let last = -1;
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === "\\" && lineText[i + 1] === "|") {
      i++;
      continue;
    }
    if (lineText[i] === "|") last = i;
  }
  return last;
}

interface LooseTableBlock {
  startLine: number;
  endLine: number;
}

/**
 * Locate the contiguous run of table-like lines containing `lineN`, or null
 * if that line isn't table-like.
 */
function findLooseTableBlock(
  state: EditorState,
  lineN: number,
): LooseTableBlock | null {
  if (!isTableLikeLine(state.doc.line(lineN).text)) return null;

  let start = lineN;
  while (start > 1 && isTableLikeLine(state.doc.line(start - 1).text)) {
    start--;
  }
  let end = lineN;
  const total = state.doc.lines;
  while (end < total && isTableLikeLine(state.doc.line(end + 1).text)) {
    end++;
  }
  return { startLine: start, endLine: end };
}

/* ── Enter: auto-complete a header-only row into a real table ─────────── */

/**
 * Called when the regular Enter handler couldn't find a recognised table
 * (i.e. no alignment row yet). If the cursor is on a table-like line with
 * at least two cells, append a synthetic alignment row plus an empty data
 * row at the end of the block and move the cursor into the new data row.
 *
 * Returns true when the autocomplete fired and the keystroke is consumed.
 */
export function enterTableAutocomplete(view: EditorView): boolean {
  const main = view.state.selection.main;
  if (!main.empty) return false;

  const line = view.state.doc.lineAt(main.from);
  if (!isTableLikeLine(line.text)) return false;

  const cells = parseCells(line.text);
  // Demand at least two cells — single-pipe text like `| hello` is ambiguous.
  if (cells.length < 2) return false;

  const block = findLooseTableBlock(view.state, line.number);
  if (!block) return false;

  // Refuse to autocomplete if the cursor is mid-cell BUT only on a row
  // that's NOT the last one — the user is likely just editing existing
  // content there. On the last line of the block we always autocomplete
  // (that's the "I just typed my header, now Enter" case).
  if (line.number !== block.endLine) return false;

  // Does the block already have an alignment row?
  let hasAlign = false;
  for (let n = block.startLine; n <= block.endLine; n++) {
    if (isAlignmentLine(view.state.doc.line(n).text)) {
      hasAlign = true;
      break;
    }
  }

  const cols = cells.length;
  const blockEnd = view.state.doc.line(block.endLine).to;

  if (hasAlign) {
    // Block already complete; just append an empty data row.
    const empty = "| " + new Array(cols).fill("  ").join(" | ") + " |";
    view.dispatch({
      changes: { from: blockEnd, insert: `\n${empty}` },
      // Place cursor after the leading `| ` of the new row.
      selection: { anchor: blockEnd + 1 + 2 },
      scrollIntoView: true,
    });
    return true;
  }

  // Header-only → append alignment + empty data row.
  const align = "| " + new Array(cols).fill("---").join(" | ") + " |";
  const empty = "| " + new Array(cols).fill("  ").join(" | ") + " |";
  view.dispatch({
    changes: { from: blockEnd, insert: `\n${align}\n${empty}` },
    selection: { anchor: blockEnd + 1 + align.length + 1 + 2 },
    scrollIntoView: true,
  });
  return true;
}

/* ── Enter inside a recognised table block ───────────────────────────── */

/**
 * Append an empty data row at the very end of the table block and place the
 * cursor in its first cell. Used when the user presses Enter while the
 * cursor sits past the last `|` of any row.
 */
function appendEmptyRowToBlock(
  view: EditorView,
  info: TableInfo,
): boolean {
  const cols = info.rows[0]?.length ?? 0;
  if (cols < 1) return false;
  const empty = "| " + new Array(cols).fill("  ").join(" | ") + " |";
  const blockEnd = view.state.doc.line(info.endLine).to;
  view.dispatch({
    changes: { from: blockEnd, insert: `\n${empty}` },
    selection: { anchor: blockEnd + 1 + 2 }, // skip "\n| "
    scrollIntoView: true,
  });
  return true;
}

/**
 * Exit the table by removing the (already-empty) data row the cursor is on
 * and placing the cursor on a fresh blank plain line. If the empty row is
 * the last line of the block, we just clear its content. Otherwise the
 * line is deleted entirely (including its trailing newline).
 */
function exitTableViaEmptyRow(
  view: EditorView,
  line: { from: number; to: number; number: number },
  info: TableInfo,
): boolean {
  if (line.number === info.endLine) {
    // Replace the `|   |   |` row with an empty plain line.
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    return true;
  }
  // Mid-block empty row: delete the whole line (including \n).
  const docLen = view.state.doc.length;
  const deleteTo = Math.min(line.to + 1, docLen);
  view.dispatch({
    changes: { from: line.from, to: deleteTo, insert: "" },
    selection: { anchor: line.from },
    scrollIntoView: true,
  });
  return true;
}

/**
 * Enter behaviour for a cursor that's inside a *fully recognised* markdown
 * table (header + alignment + data). Routes between:
 *   - alignment row → swallow,
 *   - empty data row → exit the table (one fresh plain line below),
 *   - cursor past the last `|` of any row → append a new empty data row,
 *   - cursor inside a cell → insert `<br>` (in-cell line break).
 *
 * Returns false when there's no table at all (caller should fall back to
 * `enterTableAutocomplete`).
 */
export function enhancedEnterInTable(view: EditorView): boolean {
  const info = getTableInfo(view);
  if (!info) return false;

  const main = view.state.selection.main;
  if (!main.empty) {
    // Selection-replace inside a table: let CodeMirror's default handle it
    // (insert newline, splitting the row — user's mess to clean up).
    return false;
  }

  const line = view.state.doc.lineAt(main.from);
  const lineIdx = line.number - info.startLine;

  // Alignment row Enter: swallow to avoid breaking the table.
  if (lineIdx === info.alignLineIdx) return true;

  // Empty DATA row: pressing Enter inside it exits the table.
  const isDataRow = lineIdx > info.alignLineIdx;
  const rowCells = info.rows[lineIdx] ?? [];
  const rowIsEmpty = rowCells.length > 0 && rowCells.every((c) => c.trim() === "");
  if (isDataRow && rowIsEmpty) {
    return exitTableViaEmptyRow(view, line, info);
  }

  // Cursor past the last `|` → append new empty row at the end of the block.
  const lastPipe = findLastPipeOffset(line.text);
  const cursorInLine = main.from - line.from;
  if (lastPipe !== -1 && cursorInLine > lastPipe) {
    return appendEmptyRowToBlock(view, info);
  }

  // Inside a cell → insert `<br>` for an in-cell line break (existing
  // behaviour from the original keymap).
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: "<br>" },
    selection: { anchor: main.from + 4 },
  });
  return true;
}

/**
 * Ctrl+Enter (Cmd+Enter on macOS) anywhere inside a table forces an exit:
 * insert a fresh blank line below the block end and put the cursor there.
 */
export function ctrlEnterExitTable(view: EditorView): boolean {
  const info = getTableInfo(view);
  if (!info) return false;

  const blockEnd = view.state.doc.line(info.endLine).to;
  view.dispatch({
    changes: { from: blockEnd, insert: "\n" },
    selection: { anchor: blockEnd + 1 },
    scrollIntoView: true,
  });
  return true;
}

/* ── `|` keystroke: keep all rows in the table at the same column count ── */

/**
 * Keymap handler for the `|` key. Inserts the pipe at the cursor and, if the
 * cursor is on a table-like line with sibling rows, splices an empty cell
 * into every other row at the matching column index — all in a single
 * transaction so undo restores everything in one step.
 *
 * Returns false when the cursor isn't in a table block (CodeMirror's default
 * `|` insertion handles those cases).
 */
export function pipeColumnSync(view: EditorView): boolean {
  const sel = view.state.selection.main;
  // Selection-replace and multi-cursor cases: skip the sync logic so we
  // don't garble user intent. CodeMirror's default `|` insertion handles
  // those just fine.
  if (!sel.empty) return false;

  const oldLine = view.state.doc.lineAt(sel.from);
  if (!isTableLikeLine(oldLine.text)) return false;

  // Compute what the line will look like after we insert the pipe.
  const relPos = sel.from - oldLine.from;
  const newLineText =
    oldLine.text.slice(0, relPos) + "|" + oldLine.text.slice(relPos);
  if (!isTableLikeLine(newLineText)) return false;

  const oldCells = parseCells(oldLine.text);
  const newCells = parseCells(newLineText);
  // No column count change → fall through to default insertion.
  if (newCells.length <= oldCells.length) return false;

  const block = findLooseTableBlock(view.state, oldLine.number);
  if (!block) return false;
  // Single-row block has no siblings to sync with — defer to default.
  if (block.startLine === block.endLine) return false;

  // Locate the column index where the new (empty) cell appears in the
  // post-insert row. We compare cell-by-cell with the old row: the first
  // index that diverges is where the new cell landed.
  let insertedAt = -1;
  for (let i = 0; i < oldCells.length; i++) {
    if (newCells[i] !== oldCells[i]) {
      insertedAt = i;
      break;
    }
  }
  if (insertedAt === -1) {
    // Appended at the end of the row.
    insertedAt = oldCells.length;
  }

  // Build the combined transaction: pipe insertion at cursor + empty cells
  // inserted into every other row at the same column boundary.
  const changes: { from: number; to: number; insert: string }[] = [
    { from: sel.from, to: sel.from, insert: "|" },
  ];

  for (let n = block.startLine; n <= block.endLine; n++) {
    if (n === oldLine.number) continue;
    const ln = view.state.doc.line(n);
    const isAlign = isAlignmentLine(ln.text);

    // Find the `insertedAt`-th unescaped pipe (0-based). That's the pipe
    // that OPENS cell `insertedAt`; we insert the new cell right after it.
    const pipePos = findPipeOffset(ln.text, insertedAt);
    if (pipePos === -1) continue;

    const cellText = isAlign ? "---|" : "   |";
    changes.push({
      from: ln.from + pipePos + 1,
      to: ln.from + pipePos + 1,
      insert: cellText,
    });
  }

  // Building a ChangeSet first lets us map the cursor's OLD position
  // through all the inserts to land precisely after the user's just-typed
  // `|`. A naive `sel.from + 1` is wrong whenever a sibling row inserts an
  // empty cell at a doc offset earlier than the cursor — the cursor would
  // get pushed forward by the sibling's length, so its NEW position is
  // `sel.from + (sum of earlier inserts) + 1`.
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: { anchor: changeSet.mapPos(sel.from, 1) },
  });
  return true;
}
