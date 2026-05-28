import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Heading node names from @lezer/markdown → CSS class for the line. */
const HEADING_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/**
 * Marker nodes that should be COMPLETELY hidden when the cursor isn't on
 * their line — leaving only the rendered prose visible.
 */
const HIDE_MARK_NODES = new Set([
  "HeaderMark", // # ## ### ...
]);

/**
 * Marker nodes that should be dimmed (low opacity) when the cursor isn't on
 * their line. We keep them visible because their absence would remove visual
 * cues for block structure (`>` for quotes, `-` for lists) that the syntax
 * highlighter alone doesn't replace.
 */
const DIM_MARK_NODES = new Set([
  "EmphasisMark", // * or _
  "StrikethroughMark", // ~~
  "CodeMark", // `
  "QuoteMark", // >
  "ListMark", // - + *  or  1.
  "TaskMarker", // [x] / [ ]
  "LinkMark", // [ ] ( )
  "CodeInfo", // language tag after ```
]);

/**
 * Line numbers (1-based) of every line touched by the current selection.
 * Markers on those lines are revealed in full opacity.
 */
function selectedLineNumbers(view: EditorView): Set<number> {
  const result = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const fromLine = view.state.doc.lineAt(range.from).number;
    const toLine = view.state.doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) result.add(n);
  }
  return result;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const activeLines = selectedLineNumbers(view);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.type.name;

        const headingLevel = HEADING_LEVELS[name];
        if (headingLevel !== undefined) {
          const line = view.state.doc.lineAt(node.from);
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: `cm-md-h${headingLevel}` }),
          );
          return;
        }

        if (HIDE_MARK_NODES.has(name)) {
          const lineNum = view.state.doc.lineAt(node.from).number;
          const cls = activeLines.has(lineNum)
            ? "cm-md-mark-hide cm-md-mark-hide-active"
            : "cm-md-mark-hide";
          builder.add(node.from, node.to, Decoration.mark({ class: cls }));
          return;
        }

        if (DIM_MARK_NODES.has(name)) {
          const lineNum = view.state.doc.lineAt(node.from).number;
          const cls = activeLines.has(lineNum)
            ? "cm-md-mark cm-md-mark-active"
            : "cm-md-mark";
          builder.add(node.from, node.to, Decoration.mark({ class: cls }));
          return;
        }
      },
    });
  }

  return builder.finish();
}

/**
 * ViewPlugin that adds:
 *   - `.cm-md-h{1..6}` line decoration to every heading line
 *   - `.cm-md-mark` (dim) / `.cm-md-mark-active` (full opacity) on syntactic
 *     marker characters, with "active" applied when the cursor/selection is
 *     on the same line
 *
 * Re-runs whenever the doc, viewport, or selection changes.
 */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
