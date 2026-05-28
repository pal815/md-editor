import { type EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

/* ── Local helpers (mirror of table-ops.ts; kept private so this module
   stands alone) ─────────────────────────────────────────────────────────── */

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
      buf += "\\|";
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

/** Document position just inside the `colIdx`-th cell of `lineText`. */
function findCellStartPos(
  lineText: string,
  colIdx: number,
  lineStart: number,
): number {
  let pipes = 0;
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === "\\" && lineText[i + 1] === "|") {
      i++;
      continue;
    }
    if (lineText[i] === "|") {
      pipes++;
      if (pipes === colIdx + 1) {
        let pos = i + 1;
        while (pos < lineText.length && lineText[pos] === " ") pos++;
        return lineStart + pos;
      }
    }
  }
  return lineStart;
}

/* ── Widget ──────────────────────────────────────────────────────────────── */

interface SourceLine {
  from: number;
  text: string;
}

class TableWidget extends WidgetType {
  constructor(
    public rows: string[][],
    public alignLineIdx: number,
    public sourceLines: SourceLine[],
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    if (this.rows.length !== other.rows.length) return false;
    if (this.alignLineIdx !== other.alignLineIdx) return false;
    for (let r = 0; r < this.rows.length; r++) {
      if (this.rows[r].length !== other.rows[r].length) return false;
      for (let c = 0; c < this.rows[r].length; c++) {
        if (this.rows[r][c] !== other.rows[r][c]) return false;
      }
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";

    const table = document.createElement("table");
    table.className = "cm-md-table";

    for (let r = 0; r < this.rows.length; r++) {
      if (r === this.alignLineIdx) continue;

      const tr = document.createElement("tr");
      const isHeader = r < this.alignLineIdx;

      for (let c = 0; c < this.rows[r].length; c++) {
        const cell = document.createElement(isHeader ? "th" : "td");
        // Render the cell text, turning the literal `<br>` GFM line-break
        // marker into actual `<br>` DOM nodes. Other HTML is escaped (kept as
        // text nodes) to avoid arbitrary HTML injection from file contents.
        const cellText = this.rows[r][c] || "";
        const parts = cellText.split(/<br\s*\/?>/i);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) cell.appendChild(document.createElement("br"));
          cell.appendChild(document.createTextNode(parts[i]));
        }

        // Clicking a cell moves the cursor into that cell's source position;
        // the state field will then rebuild and the widget will be replaced by
        // the raw markdown so the user can edit it.
        cell.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          const line = this.sourceLines[r];
          if (!line) return;
          const pos = findCellStartPos(line.text, c, line.from);
          view.dispatch({ selection: { anchor: pos } });
          view.focus();
        });

        tr.appendChild(cell);
      }
      table.appendChild(tr);
    }

    wrap.appendChild(table);
    return wrap;
  }

  /** Let mousedown / contextmenu reach our DOM handlers. */
  ignoreEvent(event: Event): boolean {
    if (event.type === "mousedown" || event.type === "contextmenu") {
      return false;
    }
    return true;
  }
}

/* ── State field ─────────────────────────────────────────────────────────── */

/**
 * Compute the set of table-widget replacement decorations for the given state.
 * Returns Decoration.none if the cursor is inside every table (i.e., we never
 * want to hide its source while editing).
 */
function buildTableDecorations(state: EditorState): DecorationSet {
  const decos: { from: number; to: number; deco: Decoration }[] = [];
  const head = state.selection.main.head;
  const cursorLine = state.doc.lineAt(head).number;

  const totalLines = state.doc.lines;
  let n = 1;
  while (n <= totalLines) {
    const line = state.doc.line(n);
    if (!isTableLine(line.text)) {
      n++;
      continue;
    }

    // Found a table block; scan down for the contiguous range of table lines.
    const startLine = n;
    let endLine = startLine;
    while (endLine < totalLines) {
      const next = state.doc.line(endLine + 1);
      if (!isTableLine(next.text)) break;
      endLine++;
    }
    if (endLine - startLine + 1 < 2) {
      n = endLine + 1;
      continue;
    }

    // When the cursor is inside this table, show its raw source so the user
    // can edit it directly. The widget reappears as soon as the cursor leaves.
    if (cursorLine >= startLine && cursorLine <= endLine) {
      n = endLine + 1;
      continue;
    }

    // Parse the table into rows + locate the alignment row.
    const rows: string[][] = [];
    const sourceLines: SourceLine[] = [];
    let alignLineIdx = -1;
    for (let i = startLine; i <= endLine; i++) {
      const ln = state.doc.line(i);
      sourceLines.push({ from: ln.from, text: ln.text });
      if (alignLineIdx === -1 && isAlignmentLine(ln.text)) {
        alignLineIdx = i - startLine;
      }
      rows.push(parseCells(ln.text));
    }
    if (alignLineIdx === -1) {
      n = endLine + 1;
      continue;
    }

    const fromPos = state.doc.line(startLine).from;
    const toPos = state.doc.line(endLine).to;
    decos.push({
      from: fromPos,
      to: toPos,
      deco: Decoration.replace({
        widget: new TableWidget(rows, alignLineIdx, sourceLines),
        block: true,
      }),
    });

    n = endLine + 1;
  }

  return Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)));
}

/**
 * State field that produces block-replace decorations for every markdown
 * table in the document — except the one currently containing the cursor.
 *
 * State fields are the canonical way to provide block decorations
 * (`Decoration.replace({block: true})`) in CodeMirror 6; the `provide` hook
 * wires the field's value into the `EditorView.decorations` facet.
 */
export const tableWidget = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection) {
      return buildTableDecorations(tr.state);
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});
