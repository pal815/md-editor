<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import type { EditorView } from "@codemirror/view";
  import { app } from "$lib/state.svelte";
  import {
    refreshRecentFiles,
    closeTab,
    newFile,
    saveSession,
    loadSession,
    attachDragDropHandler,
    consumeStartupFiles,
    checkAllExternalChanges,
  } from "$lib/file-ops";
  import { attachMenuHandler } from "$lib/menu-handler";
  import {
    createMarkdownEditor,
    destroyMarkdownEditor,
    setEditorContent,
    getEditorContent,
  } from "$lib/editor";
  import { initTheme, getResolvedTheme } from "$lib/theme";
  import { settings } from "$lib/settings.svelte";
  import { renderMarkdownSafe } from "$lib/viewer";
  import { enhanceViewer } from "$lib/viewer-enhance";
  import {
    setHeadingLevel,
    wrapInline,
    toggleBlockquote,
    toggleBulletList,
    toggleNumberedList,
    toggleTaskList,
    insertTable,
    insertCodeBlock,
    insertHorizontalRule,
    insertLink,
  } from "$lib/editor/transforms";
  import {
    getTableInfo,
    insertColumn,
    insertRow,
    deleteColumn,
    deleteRow,
  } from "$lib/editor/table-ops";
  import { copyTableAtCursor } from "$lib/editor/table-copy";
  import ContextMenu, {
    type MenuItem,
  } from "$lib/components/ContextMenu.svelte";

  let editorContainer = $state<HTMLElement | null>(null);
  let editor = $state<EditorView | null>(null);
  let cursorLine = $state(1);
  let cursorCol = $state(1);

  // Editor zoom (font size). Default 14px, range 8..32.
  let fontSize = $state(14);
  const FONT_DEFAULT = 14;
  const FONT_MIN = 8;
  const FONT_MAX = 32;

  // Right-click context menu state.
  let ctxMenuOpen = $state(false);
  let ctxMenuX = $state(0);
  let ctxMenuY = $state(0);

  // Suppress cross-direction sync while we're programmatically pushing
  // content into the editor (e.g., loading a file or switching tabs).
  let suppressSync = false;

  let menuUnlisten: UnlistenFn | null = null;
  let dragDropUnlisten: UnlistenFn | null = null;
  let focusUnlisten: UnlistenFn | null = null;
  // Auto-save debounce timer.
  let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Rendered HTML for the active buffer when Viewer mode is on. Updated by a
  // debounced effect so we don't re-render on every keystroke.
  let viewerHtml = $state<string>("");
  let viewerRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let viewerEl = $state<HTMLElement | null>(null);

  /** Build the items shown when the user right-clicks inside the editor. */
  function buildContextMenu(view: EditorView): MenuItem[] {
    const langs: { label: string; lang: string }[] = [
      { label: "Plain text", lang: "text" },
      { label: "Markdown", lang: "markdown" },
      { label: "Python", lang: "python" },
      { label: "SQL", lang: "sql" },
      { label: "JavaScript", lang: "javascript" },
      { label: "TypeScript", lang: "typescript" },
      { label: "JSON", lang: "json" },
      { label: "HTML", lang: "html" },
      { label: "CSS", lang: "css" },
      { label: "Rust", lang: "rust" },
      { label: "YAML", lang: "yaml" },
    ];

    const tableInfo = getTableInfo(view);
    const tableItems: MenuItem[] = tableInfo
      ? [
          {
            kind: "submenu",
            label: "Table",
            items: [
              {
                kind: "item",
                label: "Insert column left",
                action: () => insertColumn(view, tableInfo, "left"),
              },
              {
                kind: "item",
                label: "Insert column right",
                action: () => insertColumn(view, tableInfo, "right"),
              },
              {
                kind: "item",
                label: "Insert row above",
                action: () => insertRow(view, tableInfo, "above"),
              },
              {
                kind: "item",
                label: "Insert row below",
                action: () => insertRow(view, tableInfo, "below"),
              },
              { kind: "separator" },
              {
                kind: "item",
                label: "Delete column",
                action: () => deleteColumn(view, tableInfo),
                disabled: (tableInfo.rows[0]?.length ?? 0) <= 1,
              },
              {
                kind: "item",
                label: "Delete row",
                action: () => deleteRow(view, tableInfo),
                disabled:
                  tableInfo.currentRowIdx === tableInfo.alignLineIdx ||
                  tableInfo.rows.length <= 2,
              },
              { kind: "separator" },
              {
                kind: "item",
                label: "Copy as TSV (Excel)",
                action: () => {
                  void copyTableAtCursor(view, "tsv");
                },
              },
              {
                kind: "item",
                label: "Copy as HTML table",
                action: () => {
                  void copyTableAtCursor(view, "html");
                },
              },
              {
                kind: "item",
                label: "Copy markdown source",
                action: () => {
                  void copyTableAtCursor(view, "markdown");
                },
              },
            ],
          },
          { kind: "separator" },
        ]
      : [];

    return [
      ...tableItems,
      {
        kind: "submenu",
        label: "Heading",
        items: [
          { kind: "item", label: "Heading 1", action: () => setHeadingLevel(view, 1) },
          { kind: "item", label: "Heading 2", action: () => setHeadingLevel(view, 2) },
          { kind: "item", label: "Heading 3", action: () => setHeadingLevel(view, 3) },
          { kind: "item", label: "Heading 4", action: () => setHeadingLevel(view, 4) },
          { kind: "item", label: "Heading 5", action: () => setHeadingLevel(view, 5) },
          { kind: "item", label: "Heading 6", action: () => setHeadingLevel(view, 6) },
          { kind: "separator" },
          { kind: "item", label: "Body text", action: () => setHeadingLevel(view, 0) },
        ],
      },
      { kind: "separator" },
      { kind: "item", label: "Bold", shortcut: "Ctrl+B", action: () => wrapInline(view, "**", "text") },
      { kind: "item", label: "Italic", shortcut: "Ctrl+I", action: () => wrapInline(view, "*", "text") },
      { kind: "item", label: "Strikethrough", action: () => wrapInline(view, "~~", "text") },
      { kind: "item", label: "Inline code", shortcut: "Ctrl+`", action: () => wrapInline(view, "`", "code") },
      { kind: "separator" },
      { kind: "item", label: "Blockquote", action: () => toggleBlockquote(view) },
      { kind: "item", label: "Bulleted list", action: () => toggleBulletList(view) },
      { kind: "item", label: "Numbered list", action: () => toggleNumberedList(view) },
      { kind: "item", label: "Task list", action: () => toggleTaskList(view) },
      { kind: "separator" },
      { kind: "item", label: "Insert link", action: () => insertLink(view) },
      { kind: "item", label: "Insert table (2 × 2)", action: () => insertTable(view, 2, 2) },
      {
        kind: "submenu",
        label: "Insert code block",
        items: langs.map((l) => ({
          kind: "item" as const,
          label: l.label,
          action: () => insertCodeBlock(view, l.lang),
        })),
      },
      { kind: "item", label: "Horizontal rule", action: () => insertHorizontalRule(view) },
    ];
  }

  function onEditorContextMenu(event: MouseEvent) {
    if (!editor) return;
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    const insideTableWidget = target?.closest(".cm-md-table") != null;
    if (!insideTableWidget) {
      const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) {
        const sel = editor.state.selection.main;
        const insideSelection =
          !sel.empty && pos >= sel.from && pos <= sel.to;
        if (!insideSelection) {
          editor.dispatch({ selection: { anchor: pos } });
        }
      }
    }
    ctxMenuX = event.clientX;
    ctxMenuY = event.clientY;
    ctxMenuOpen = true;
  }

  let ctxMenuItems = $derived.by<MenuItem[]>(() =>
    editor && ctxMenuOpen ? buildContextMenu(editor) : [],
  );

  // Window title reflects the active tab.
  $effect(() => {
    const buf = app.active;
    const mark = buf.isModified ? " •" : "";
    getCurrentWindow().setTitle(`${buf.fileName}${mark} — md-editor`);
  });

  // Sync external state changes (file load, new file, tab switch) into the
  // editor. Editor → state updates flow through the editor's onContentChange.
  $effect(() => {
    const view = editor;
    if (!view) return;
    const buf = app.active;
    const target = buf.content;
    const cursor = buf.cursorPos;
    if (target === getEditorContent(view)) return;
    suppressSync = true;
    setEditorContent(view, target, cursor);
    queueMicrotask(() => {
      suppressSync = false;
    });
  });

  function onWindowKeyDown(e: KeyboardEvent) {
    // Tab management shortcuts (Ctrl+T / Ctrl+W / Ctrl+Tab / Ctrl+1..9).
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "t" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        newFile();
        return;
      }
      if (e.key === "w" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        closeTab(app.activeId);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        app.cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < app.buffers.length) {
          e.preventDefault();
          app.switchTo(app.buffers[idx].id);
        }
        return;
      }
    }
    // Zoom shortcuts.
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.shiftKey || e.altKey) return;
    if (e.key === "e" || e.key === "E") {
      // Ctrl+E: toggle Edit ↔ Viewer (matches the native menu accelerator;
      // we intercept here too so it works even when the editor has focus and
      // would otherwise consume the keystroke).
      e.preventDefault();
      void settings.toggleViewMode();
      return;
    }
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      fontSize = Math.min(FONT_MAX, fontSize + 1);
    } else if (e.key === "-") {
      e.preventDefault();
      fontSize = Math.max(FONT_MIN, fontSize - 1);
    } else if (e.key === "0") {
      e.preventDefault();
      fontSize = FONT_DEFAULT;
    }
  }

  onMount(() => {
    let cancelled = false;

    window.addEventListener("keydown", onWindowKeyDown);

    (async () => {
      // Apply the persisted theme before the editor is created so it picks up
      // the right Compartment value immediately and we avoid a one-frame flash.
      await initTheme();
      // Load the rest of the persisted preferences (view mode, external-image
      // policy) so the UI mounts in the user's last-known configuration.
      await settings.init();
      // Restore the previous session BEFORE anything else so the editor mounts
      // straight into the last-known state.
      await loadSession();
      await refreshRecentFiles();
      menuUnlisten = await attachMenuHandler();
      dragDropUnlisten = await attachDragDropHandler();
      // Open any files passed via Windows file association at first launch
      // (subsequent launches reuse this instance and arrive as `files-dropped`
      // events, already handled by the drag-drop listener above).
      await consumeStartupFiles();

      // When the window regains focus, the user may have just edited an open
      // file in another program. Check each file-backed tab for on-disk
      // changes and prompt to reload or keep the in-memory version.
      focusUnlisten = await getCurrentWindow().onFocusChanged(
        ({ payload: focused }) => {
          if (focused && app.sessionLoaded) {
            void checkAllExternalChanges();
          }
        },
      );

      // Session persistence is handled by the auto-save $effect below — we
      // intentionally don't register an `onCloseRequested` listener: Tauri
      // 2.11's wrapper handed us a flaky close-hang in our setup, and the
      // continuous auto-save gives us a stronger guarantee (state is current
      // within ~600ms of any edit, so the X button can use its default close
      // path safely).

      if (cancelled) {
        menuUnlisten?.();
        dragDropUnlisten?.();
        focusUnlisten?.();
      }
    })();

    if (editorContainer) {
      editor = createMarkdownEditor({
        parent: editorContainer,
        initialContent: app.active.content,
        onContentChange: (content) => {
          if (suppressSync) return;
          app.active.content = content;
        },
        onCursorChange: (line, col, pos) => {
          cursorLine = line;
          cursorCol = col;
          if (!suppressSync) {
            app.active.cursorPos = pos;
          }
        },
      });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onWindowKeyDown);
      if (editor) destroyMarkdownEditor(editor);
      editor = null;
      menuUnlisten?.();
      dragDropUnlisten?.();
      focusUnlisten?.();
      if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
      // Final flush of any pending session changes on unmount.
      saveSession().catch(() => {});
    };
  });

  // Auto-save the session whenever any tracked piece of buffer state changes.
  // Debounce so we don't write on every keystroke.
  $effect(() => {
    // Touch every reactive dep we care about so this effect re-runs on edits.
    void app.activeId;
    for (const b of app.buffers) {
      void b.content;
      void b.currentPath;
      void b.cursorPos;
      void b.savedContent;
    }
    if (!app.sessionLoaded) return; // don't write before initial load finishes
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      saveSession().catch(() => {});
    }, 600);
  });

  // Re-render the Viewer HTML whenever the active buffer content changes or
  // the user toggles the external-image policy. Debounced so big files don't
  // ship every keystroke through the IPC bridge.
  $effect(() => {
    const content = app.active.content;
    const allow = settings.allowExternalImages;
    // Only do work when Viewer mode is actually visible.
    if (settings.viewMode !== "viewer") return;

    if (viewerRenderTimer) clearTimeout(viewerRenderTimer);
    viewerRenderTimer = setTimeout(() => {
      renderMarkdownSafe(content, { allowExternalImages: allow })
        .then((html) => {
          viewerHtml = html;
        })
        .catch(() => {
          viewerHtml = "";
        });
    }, 120);
  });

  // After the viewer HTML lands in the DOM, run post-render enhancements:
  // syntax highlight code blocks and turn bare URLs into anchors. The effect
  // depends on `viewerHtml` so it re-runs on every render.
  $effect(() => {
    void viewerHtml; // re-run when HTML changes
    if (settings.viewMode !== "viewer" || !viewerEl) return;
    // Wait one microtask so {@html} has committed.
    queueMicrotask(() => {
      if (viewerEl) void enhanceViewer(viewerEl, getResolvedTheme());
    });
  });
</script>

<div class="app">
  <header class="tab-bar" role="tablist">
    {#each app.buffers as buffer (buffer.id)}
      <div
        class="tab"
        class:active={buffer.id === app.activeId}
        role="tab"
        tabindex="0"
        aria-selected={buffer.id === app.activeId}
        title={buffer.currentPath ?? buffer.fileName}
        onclick={() => app.switchTo(buffer.id)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            app.switchTo(buffer.id);
          }
        }}
      >
        <span class="tab-name">
          {buffer.fileName}{buffer.isModified ? " •" : ""}
        </span>
        <button
          type="button"
          class="tab-close"
          aria-label="Close tab"
          onclick={(e) => {
            e.stopPropagation();
            closeTab(buffer.id);
          }}
        >×</button>
      </div>
    {/each}
    <button
      type="button"
      class="tab-new"
      aria-label="New tab"
      title="New tab (Ctrl+T)"
      onclick={() => newFile()}
    >+</button>
  </header>

  <main
    class="editor-area"
    bind:this={editorContainer}
    oncontextmenu={onEditorContextMenu}
    style:--editor-font-size="{fontSize}px"
    class:hidden={settings.viewMode === "viewer"}
  ></main>

  {#if settings.viewMode === "viewer"}
    <!-- DOMPurify-cleaned HTML; never inject untrusted strings here. -->
    <article
      class="viewer-area"
      bind:this={viewerEl}
      style:--editor-font-size="{fontSize}px"
    >{@html viewerHtml}</article>
  {/if}

  {#if ctxMenuOpen}
    <ContextMenu
      items={ctxMenuItems}
      x={ctxMenuX}
      y={ctxMenuY}
      onClose={() => (ctxMenuOpen = false)}
    />
  {/if}

  <footer class="statusbar">
    <span>Ln {cursorLine}, Col {cursorCol}</span>
    <span class="spacer"></span>
    {#if app.active.currentPath}
      <span class="path" title={app.active.currentPath}>
        {app.active.currentPath}
      </span>
    {/if}
    <span class="spacer"></span>
    <span>{app.active.isModified ? "Modified" : "Saved"}</span>
    <span class="spacer"></span>
    <span title="Ctrl+= / Ctrl+- / Ctrl+0 to zoom">
      {Math.round((fontSize / FONT_DEFAULT) * 100)}%
    </span>
    <span class="spacer"></span>
    <span
      class="mode-pill"
      title="Toggle Edit / Viewer (Ctrl+E)"
      onclick={() => settings.toggleViewMode()}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          settings.toggleViewMode();
        }
      }}
      role="button"
      tabindex="0"
    >
      {settings.viewMode === "viewer" ? "Viewer" : "Edit"}
    </span>
    <span class="spacer"></span>
    <span>Markdown</span>
  </footer>
</div>

<style>
  /* ── Theme tokens ─────────────────────────────────────────────────────
     All colours used by the app shell live here. Dark is the default;
     `[data-theme="light"]` (set on <html> by theme.ts) overrides the same
     tokens with their light-mode counterparts. Add new colours as tokens
     rather than hard-coding them.
  */
  :global(:root) {
    --bg-app: #1e1e1e;
    --bg-tab-bar: #1a1a1a;
    --bg-tab: #252526;
    --bg-tab-hover: #2c2c2d;
    --bg-tab-active: #1e1e1e;
    --bg-gutter: #1e1e1e;
    --bg-table: #262626;
    --bg-table-header: #2f2f2f;
    --bg-table-hover: #2a2d33;
    --bg-statusbar: #007acc;

    --fg-app: #d4d4d4;
    --fg-tab: #aaa;
    --fg-tab-hover: #ddd;
    --fg-tab-active: #fff;
    --fg-muted: #888;
    --fg-table-th: #e8e8e8;
    --fg-table-td: #d4d4d4;
    --fg-statusbar: #fff;
    --fg-statusbar-path: rgba(255, 255, 255, 0.85);

    --border-tab: #252525;
    --border-tab-bar: #2a2a2a;
    --border-gutter: #2d2d2d;
    --border-table: #3a3a3a;

    --scrollbar-thumb: #333;
    --tab-close-hover-bg: rgba(255, 255, 255, 0.12);
    --tab-new-hover-bg: rgba(255, 255, 255, 0.06);
    --accent: #007acc;
  }

  :global(:root[data-theme="light"]) {
    --bg-app: #ffffff;
    --bg-tab-bar: #f3f3f3;
    --bg-tab: #e8e8e8;
    --bg-tab-hover: #dcdcdc;
    --bg-tab-active: #ffffff;
    --bg-gutter: #f7f7f7;
    --bg-table: #ffffff;
    --bg-table-header: #f3f3f3;
    --bg-table-hover: #eaf3ff;
    --bg-statusbar: #0078d4;

    --fg-app: #1f1f1f;
    --fg-tab: #555;
    --fg-tab-hover: #222;
    --fg-tab-active: #000;
    --fg-muted: #888;
    --fg-table-th: #1f1f1f;
    --fg-table-td: #1f1f1f;
    --fg-statusbar: #ffffff;
    --fg-statusbar-path: rgba(255, 255, 255, 0.92);

    --border-tab: #d4d4d4;
    --border-tab-bar: #d4d4d4;
    --border-gutter: #e0e0e0;
    --border-table: #d4d4d4;

    --scrollbar-thumb: #c0c0c0;
    --tab-close-hover-bg: rgba(0, 0, 0, 0.08);
    --tab-new-hover-bg: rgba(0, 0, 0, 0.05);
    --accent: #0078d4;
  }

  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    background: var(--bg-app);
    color: var(--fg-app);
    font-family:
      "Segoe UI", Inter, Avenir, Helvetica, Arial, sans-serif;
    overflow: hidden;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* ── Tab bar ───────────────────────────────────────────────────────── */
  .tab-bar {
    display: flex;
    background: var(--bg-tab-bar);
    border-bottom: 1px solid var(--border-tab-bar);
    overflow-x: auto;
    overflow-y: hidden;
    flex-shrink: 0;
  }
  .tab-bar::-webkit-scrollbar {
    height: 4px;
  }
  .tab-bar::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
  }

  .tab {
    display: flex;
    align-items: center;
    padding: 5px 4px 5px 12px;
    border-right: 1px solid var(--border-tab);
    background: var(--bg-tab);
    color: var(--fg-tab);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
    max-width: 240px;
    min-width: 80px;
    height: 28px;
    box-sizing: border-box;
  }
  .tab:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-tab-hover);
  }
  .tab.active {
    background: var(--bg-tab-active);
    color: var(--fg-tab-active);
    border-bottom: 2px solid var(--accent);
    margin-bottom: -1px;
  }
  .tab-name {
    margin-right: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
  .tab-close {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 3px;
    opacity: 0.5;
  }
  .tab-close:hover {
    opacity: 1;
    background: var(--tab-close-hover-bg);
  }
  .tab-new {
    background: transparent;
    border: none;
    color: var(--fg-muted);
    cursor: pointer;
    padding: 4px 12px;
    font-size: 16px;
    line-height: 1;
    align-self: center;
  }
  .tab-new:hover {
    color: var(--fg-tab-active);
    background: var(--tab-new-hover-bg);
  }

  /* ── Editor area ────────────────────────────────────────────────────── */
  .editor-area {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }
  .editor-area.hidden {
    display: none;
  }

  .editor-area :global(.cm-editor) {
    flex: 1;
    height: 100%;
    font-size: var(--editor-font-size, 14px);
  }
  .editor-area :global(.cm-scroller) {
    font-family: "Cascadia Code", "Consolas", "Menlo", monospace;
    line-height: 1.6;
  }
  .editor-area :global(.cm-content) {
    padding: 14px 0;
  }
  /* Dark theme: keep the gutter colour matched to the editor surround.
     The light CodeMirror theme already styles its own gutter, so we only
     override here for dark (oneDark uses transparent gutters by default). */
  :global(:root:not([data-theme="light"])) .editor-area :global(.cm-gutters) {
    background: var(--bg-gutter);
    border-right: 1px solid var(--border-gutter);
  }

  /* URL / autolink — Ctrl-click affordance. */
  .editor-area :global(.cm-md-link) {
    cursor: text;
  }
  :global(body.modifier-pressed) .editor-area :global(.cm-md-link) {
    cursor: pointer;
    text-decoration: underline;
  }

  /* Headings — visually larger. */
  .editor-area :global(.cm-md-h1) {
    font-size: 1.9em;
    font-weight: 700;
    line-height: 1.3;
  }
  .editor-area :global(.cm-md-h2) {
    font-size: 1.55em;
    font-weight: 700;
    line-height: 1.3;
  }
  .editor-area :global(.cm-md-h3) {
    font-size: 1.3em;
    font-weight: 700;
    line-height: 1.35;
  }
  .editor-area :global(.cm-md-h4) {
    font-size: 1.15em;
    font-weight: 700;
  }
  .editor-area :global(.cm-md-h5) {
    font-weight: 700;
  }
  .editor-area :global(.cm-md-h6) {
    font-weight: 700;
    color: var(--fg-muted);
  }

  /* Inline / block markers (**, *, >, -, `) — dim except on the active line. */
  .editor-area :global(.cm-md-mark) {
    opacity: 0.35;
  }
  .editor-area :global(.cm-md-mark-active) {
    opacity: 1;
  }

  /* Heading markers — fully hidden when the cursor isn't on the line. */
  .editor-area :global(.cm-md-mark-hide) {
    display: none;
  }
  .editor-area :global(.cm-md-mark-hide-active) {
    display: inline;
  }

  /* Table widget (table-widget.ts). */
  .editor-area :global(.cm-md-table-wrap) {
    padding: 4px 0 8px 0;
  }
  .editor-area :global(.cm-md-table) {
    border-collapse: collapse;
    font-family: "Segoe UI", Inter, sans-serif;
    font-size: 13px;
    background: var(--bg-table);
    border: 1px solid var(--border-table);
    border-radius: 4px;
    overflow: hidden;
  }
  .editor-area :global(.cm-md-table th),
  .editor-area :global(.cm-md-table td) {
    border: 1px solid var(--border-table);
    padding: 6px 12px;
    text-align: left;
    cursor: text;
    min-width: 80px;
    height: 1.6em;
  }
  .editor-area :global(.cm-md-table td:empty)::before {
    content: "";
    display: inline-block;
    min-width: 1em;
  }
  .editor-area :global(.cm-md-table th) {
    background: var(--bg-table-header);
    font-weight: 600;
    color: var(--fg-table-th);
  }
  .editor-area :global(.cm-md-table td) {
    color: var(--fg-table-td);
  }
  .editor-area :global(.cm-md-table tr:hover td),
  .editor-area :global(.cm-md-table tr:hover th) {
    background: var(--bg-table-hover);
  }

  /* ── Viewer area ────────────────────────────────────────────────────── */
  .viewer-area {
    flex: 1;
    overflow-y: auto;
    padding: 24px 36px 60px 36px;
    background: var(--bg-app);
    color: var(--fg-app);
    font-size: var(--editor-font-size, 14px);
    line-height: 1.65;
    box-sizing: border-box;
  }
  .viewer-area :global(h1),
  .viewer-area :global(h2),
  .viewer-area :global(h3),
  .viewer-area :global(h4),
  .viewer-area :global(h5),
  .viewer-area :global(h6) {
    margin-top: 1.4em;
    margin-bottom: 0.5em;
    line-height: 1.3;
  }
  .viewer-area :global(h1) {
    font-size: 1.9em;
    border-bottom: 1px solid var(--border-table);
    padding-bottom: 0.2em;
  }
  .viewer-area :global(h2) {
    font-size: 1.55em;
    border-bottom: 1px solid var(--border-table);
    padding-bottom: 0.15em;
  }
  .viewer-area :global(h3) { font-size: 1.3em; }
  .viewer-area :global(h4) { font-size: 1.15em; }
  .viewer-area :global(p) {
    margin: 0.7em 0;
  }
  .viewer-area :global(a) {
    color: var(--accent);
    text-decoration: underline;
  }
  .viewer-area :global(code) {
    background: var(--bg-table-header);
    padding: 0.15em 0.4em;
    border-radius: 3px;
    font-family: "Cascadia Code", "Consolas", "Menlo", monospace;
    font-size: 0.92em;
  }
  .viewer-area :global(pre) {
    background: var(--bg-table-header);
    border: 1px solid var(--border-table);
    border-radius: 4px;
    padding: 12px 14px;
    overflow-x: auto;
    line-height: 1.5;
  }
  .viewer-area :global(pre code) {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: 0.95em;
  }
  /* ── highlight.js token colours (atom-one palette, both themes). ─────
     Selectors are scoped under .viewer-area so they never leak into the
     CodeMirror editor (which has its own theming). Dark is the default;
     [data-theme="light"] overrides take over when the user is in light. */
  .viewer-area :global(code.hljs),
  .viewer-area :global(.hljs) {
    color: #abb2bf;
    background: transparent;
  }
  .viewer-area :global(.hljs-comment),
  .viewer-area :global(.hljs-quote) {
    color: #5c6370;
    font-style: italic;
  }
  .viewer-area :global(.hljs-doctag),
  .viewer-area :global(.hljs-keyword),
  .viewer-area :global(.hljs-formula) {
    color: #c678dd;
  }
  .viewer-area :global(.hljs-section),
  .viewer-area :global(.hljs-name),
  .viewer-area :global(.hljs-selector-tag),
  .viewer-area :global(.hljs-deletion),
  .viewer-area :global(.hljs-subst) {
    color: #e06c75;
  }
  .viewer-area :global(.hljs-literal) {
    color: #56b6c2;
  }
  .viewer-area :global(.hljs-string),
  .viewer-area :global(.hljs-regexp),
  .viewer-area :global(.hljs-addition),
  .viewer-area :global(.hljs-attribute),
  .viewer-area :global(.hljs-meta .hljs-string) {
    color: #98c379;
  }
  .viewer-area :global(.hljs-attr),
  .viewer-area :global(.hljs-variable),
  .viewer-area :global(.hljs-template-variable),
  .viewer-area :global(.hljs-type),
  .viewer-area :global(.hljs-selector-class),
  .viewer-area :global(.hljs-selector-attr),
  .viewer-area :global(.hljs-selector-pseudo),
  .viewer-area :global(.hljs-number) {
    color: #d19a66;
  }
  .viewer-area :global(.hljs-symbol),
  .viewer-area :global(.hljs-bullet),
  .viewer-area :global(.hljs-link),
  .viewer-area :global(.hljs-meta),
  .viewer-area :global(.hljs-selector-id),
  .viewer-area :global(.hljs-title) {
    color: #61afef;
  }
  .viewer-area :global(.hljs-built_in),
  .viewer-area :global(.hljs-title.class_),
  .viewer-area :global(.hljs-class .hljs-title) {
    color: #e6c07b;
  }
  .viewer-area :global(.hljs-emphasis) { font-style: italic; }
  .viewer-area :global(.hljs-strong) { font-weight: 700; }
  .viewer-area :global(.hljs-link) { text-decoration: underline; }

  /* Light overrides (atom-one-light palette). */
  :global(:root[data-theme="light"]) .viewer-area :global(code.hljs),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs) {
    color: #383a42;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-comment),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-quote) {
    color: #a0a1a7;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-doctag),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-keyword),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-formula) {
    color: #a626a4;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-section),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-name),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-selector-tag),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-deletion),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-subst) {
    color: #e45649;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-literal) {
    color: #0184bb;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-string),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-regexp),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-addition),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-attribute),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-meta .hljs-string) {
    color: #50a14f;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-attr),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-variable),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-template-variable),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-type),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-selector-class),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-selector-attr),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-selector-pseudo),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-number) {
    color: #986801;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-symbol),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-bullet),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-link),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-meta),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-selector-id),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-title) {
    color: #4078f2;
  }
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-built_in),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-title.class_),
  :global(:root[data-theme="light"]) .viewer-area :global(.hljs-class .hljs-title) {
    color: #c18401;
  }
  .viewer-area :global(blockquote) {
    border-left: 3px solid var(--border-table);
    margin: 0.7em 0;
    padding: 0.2em 1em;
    color: var(--fg-muted);
  }
  .viewer-area :global(table) {
    border-collapse: collapse;
    margin: 1em 0;
    font-size: 0.95em;
    background: var(--bg-table);
    border: 1px solid var(--border-table);
    border-radius: 4px;
    overflow: hidden;
  }
  .viewer-area :global(th),
  .viewer-area :global(td) {
    border: 1px solid var(--border-table);
    padding: 6px 12px;
    text-align: left;
  }
  .viewer-area :global(th) {
    background: var(--bg-table-header);
    font-weight: 600;
  }
  .viewer-area :global(img) {
    max-width: 100%;
    height: auto;
  }
  /* Marker for an image whose src was blocked by the external-image policy. */
  .viewer-area :global(img[data-blocked-src]) {
    border: 1px dashed var(--border-table);
    padding: 8px 12px;
    color: var(--fg-muted);
    background: var(--bg-table-header);
    min-height: 40px;
  }
  .viewer-area :global(hr) {
    border: none;
    border-top: 1px solid var(--border-table);
    margin: 1.6em 0;
  }
  .viewer-area :global(ul),
  .viewer-area :global(ol) {
    padding-left: 1.6em;
  }
  .viewer-area :global(li) {
    margin: 0.25em 0;
  }
  .viewer-area :global(li input[type="checkbox"]) {
    margin-right: 0.4em;
  }

  /* ── Status bar ─────────────────────────────────────────────────────── */
  .statusbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 14px;
    background: var(--bg-statusbar);
    color: var(--fg-statusbar);
    font-size: 12px;
    flex-shrink: 0;
  }
  .statusbar .spacer {
    flex: 1;
  }
  .statusbar .path {
    color: var(--fg-statusbar-path);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }
  .mode-pill {
    padding: 1px 8px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.18);
    color: var(--fg-statusbar);
    cursor: pointer;
    font-size: 11px;
    user-select: none;
  }
  .mode-pill:hover {
    background: rgba(255, 255, 255, 0.28);
  }
</style>
