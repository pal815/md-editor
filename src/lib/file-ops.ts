import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, confirm, message } from "@tauri-apps/plugin-dialog";
import { app, Buffer } from "./state.svelte";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

/** True if the buffer is empty enough to be reused for a fresh `Open File`. */
function isEmptyUntitled(b: Buffer): boolean {
  return b.currentPath === null && b.content === "" && b.savedContent === "";
}

function isAcceptedMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Open a fresh empty tab. */
export async function newFile(): Promise<void> {
  app.addBuffer();
}

/** Show the file picker and open the chosen file in a tab. */
export async function openFile(): Promise<void> {
  const selected = await invoke<string | null>("pick_file_open");
  if (typeof selected !== "string") return;

  // If the file is already open in another tab, just switch to it.
  const existing = app.buffers.find((b) => b.currentPath === selected);
  if (existing) {
    app.switchTo(existing.id);
    return;
  }

  // Otherwise reuse the active tab if it's a blank untitled buffer, or open
  // the file in a new tab.
  const target = isEmptyUntitled(app.active) ? app.active : app.addBuffer();
  await loadFile(selected, target);
}

/**
 * Open one or more paths as tabs. Each path that's already open just switches
 * to its existing tab; otherwise the empty active tab is reused (or a fresh
 * tab is added). Non-markdown paths are silently ignored.
 *
 * The caller is responsible for ensuring the paths have been approved on the
 * Rust side (native dialog, drag-drop, CLI args, or single-instance forward).
 */
export async function openPaths(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (typeof path !== "string" || !isAcceptedMarkdownPath(path)) continue;

    const existing = app.buffers.find((b) => b.currentPath === path);
    if (existing) {
      app.switchTo(existing.id);
      continue;
    }

    const target = isEmptyUntitled(app.active) ? app.active : app.addBuffer();
    await loadFile(path, target);
  }
}

/**
 * Subscribe to native file-drop events. Dropped paths are approved in Rust
 * before this event is emitted; this handler only decides which tab to use.
 * The same event is also emitted when a second instance is launched (e.g.,
 * the user double-clicks another .md while md-editor is already running).
 */
export async function attachDragDropHandler(): Promise<UnlistenFn> {
  return listen<string[]>("files-dropped", async (event) => {
    if (!Array.isArray(event.payload)) return;
    await openPaths(event.payload);
  });
}

/**
 * Drain the list of files the OS handed us on the *very first* launch via
 * command-line args (file association double-click, drag onto exe icon).
 * Subsequent launches are intercepted by the single-instance plugin and
 * arrive via the `files-dropped` event instead.
 */
export async function consumeStartupFiles(): Promise<void> {
  try {
    const files = await invoke<string[]>("consume_startup_files");
    if (files.length > 0) await openPaths(files);
  } catch {
    // No startup files or backend not ready — nothing to do.
  }
}

/** Load a file from an explicit path into the given (or active) buffer. */
export async function loadFile(
  path: string,
  buffer: Buffer = app.active,
): Promise<void> {
  try {
    const text = await invoke<string>("read_file", { path });
    buffer.currentPath = path;
    buffer.content = text;
    buffer.savedContent = text;
    buffer.cursorPos = 0;
    app.activeId = buffer.id;
    app.recentFiles = await invoke<string[]>("add_recent_file", { path });
  } catch (err) {
    await message(`Could not open file:\n${err}`, {
      title: "Open failed",
      kind: "error",
    });
  }
}

/** Save the active buffer. Falls back to Save As when it has no path yet. */
export async function saveFile(): Promise<boolean> {
  const buffer = app.active;
  if (!buffer.currentPath) return saveFileAs();
  return writeBufferTo(buffer, buffer.currentPath);
}

/** Prompt for a path and save the active buffer there. */
export async function saveFileAs(): Promise<boolean> {
  const buffer = app.active;
  const path = await invoke<string | null>("pick_file_save", {
    defaultPath: buffer.currentPath ?? "untitled.md",
  });
  if (typeof path !== "string") return false;
  const ok = await writeBufferTo(buffer, path);
  if (ok) {
    buffer.currentPath = path;
    app.recentFiles = await invoke<string[]>("add_recent_file", { path });
  }
  return ok;
}

async function writeBufferTo(buffer: Buffer, path: string): Promise<boolean> {
  try {
    await invoke<void>("write_file", { path, contents: buffer.content });
    buffer.savedContent = buffer.content;
    return true;
  } catch (err) {
    await message(`Could not save file:\n${err}`, {
      title: "Save failed",
      kind: "error",
    });
    return false;
  }
}

/** Strip ASCII control characters from text destined for a system dialog. */
function safeForDialog(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 32;
    out += cp < 0x20 || cp === 0x7f ? " " : ch;
  }
  return out;
}

/**
 * Close a tab. If it has unsaved changes we prompt — explicit per-tab closes
 * discard the buffer entirely, so we don't want to lose work silently.
 * (Closing the whole window persists everything via `saveSession`.)
 */
export async function closeTab(id: number): Promise<void> {
  const buffer = app.buffers.find((b) => b.id === id);
  if (!buffer) return;
  if (buffer.isModified) {
    const ok = await confirm(
      `"${safeForDialog(buffer.fileName)}"의 저장되지 않은 변경을 버리시겠습니까?`,
      {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard",
        cancelLabel: "Cancel",
      },
    );
    if (!ok) return;
  }
  app.closeBuffer(id);
}

/* ── Windows .md file association (opt-in, from the File menu) ────────── */

/**
 * Register or remove md-editor as a per-user handler for `.md` files. Shows a
 * result dialog. Windows-only; the backend returns an error elsewhere.
 */
export async function setFileAssociation(enabled: boolean): Promise<void> {
  try {
    await invoke<boolean>("set_file_association", { enabled });
    await message(
      enabled
        ? `md-editor를 마크다운 파일(.md, .markdown, .mdown, .mkd) 처리기로 등록했습니다.\n\n` +
            `기본 앱으로 쓰려면: .md 파일 우클릭 → 연결 프로그램 → md-editor 선택 후 "항상"을 체크하세요.`
        : `md-editor의 마크다운 파일 연결을 해제했습니다.`,
      { title: "파일 연결", kind: "info" },
    );
  } catch (err) {
    await message(`파일 연결 변경에 실패했습니다:\n${err}`, {
      title: "파일 연결 오류",
      kind: "error",
    });
  }
}

export async function refreshRecentFiles(): Promise<void> {
  try {
    app.recentFiles = await invoke<string[]>("get_recent_files");
  } catch {
    app.recentFiles = [];
  }
}

export async function clearRecentFiles(): Promise<void> {
  try {
    await invoke<void>("clear_recent_files");
    app.recentFiles = [];
  } catch (err) {
    await message(`Could not clear recent files:\n${err}`, {
      title: "Error",
      kind: "error",
    });
  }
}

/* ── Session persistence ─────────────────────────────────────────────── */

interface SessionTab {
  currentPath: string | null;
  content: string;
  savedContent: string;
  cursorPos: number;
}

interface SessionShape {
  tabs: SessionTab[];
  activeIdx: number;
}

/** Snapshot every tab to disk so the next launch can resume editing. */
export async function saveSession(): Promise<void> {
  const session: SessionShape = {
    tabs: app.buffers.map((b) => ({
      currentPath: b.currentPath,
      content: b.content,
      savedContent: b.savedContent,
      cursorPos: b.cursorPos,
    })),
    activeIdx: Math.max(
      0,
      app.buffers.findIndex((b) => b.id === app.activeId),
    ),
  };
  try {
    await invoke<void>("save_session", { session });
  } catch {
    // best-effort; never block window close on failure
  }
}

/**
 * Build a restored buffer for one session tab, re-reading the backing file
 * from disk so external edits made since the session was saved are picked up.
 *
 * Conflict policy:
 *   - No path (untitled) → restore the session snapshot as-is.
 *   - File unchanged on disk (disk === session.savedContent) → restore the
 *     session content (preserves any unsaved edits, cursor, etc).
 *   - File changed on disk + the tab had NO unsaved edits → adopt the disk
 *     version wholesale (this is the common "I edited it elsewhere" case).
 *   - File changed on disk + the tab HAD unsaved edits → keep the user's
 *     edited content (never silently discard work), but treat the *current*
 *     disk content as the saved baseline so the tab correctly shows as
 *     modified against what's actually on disk.
 *   - File unreadable now (moved/deleted) → fall back to the session snapshot.
 */
async function restoreSessionTab(t: SessionTab): Promise<Buffer> {
  if (t.currentPath) {
    try {
      const diskContent = await invoke<string>("read_file", {
        path: t.currentPath,
      });
      const hadUnsavedEdits = t.content !== t.savedContent;
      const diskUnchanged = diskContent === t.savedContent;

      if (diskUnchanged) {
        return new Buffer({
          currentPath: t.currentPath,
          content: t.content,
          savedContent: t.savedContent,
          cursorPos: t.cursorPos,
        });
      }
      if (!hadUnsavedEdits) {
        // Adopt the fresh on-disk content; no work to lose.
        return new Buffer({
          currentPath: t.currentPath,
          content: diskContent,
          savedContent: diskContent,
          cursorPos: t.cursorPos,
        });
      }
      // Unsaved edits + external change: keep the edits, rebase the saved
      // baseline onto current disk so "modified" status is accurate.
      return new Buffer({
        currentPath: t.currentPath,
        content: t.content,
        savedContent: diskContent,
        cursorPos: t.cursorPos,
      });
    } catch {
      // File missing / unreadable — fall through to the snapshot below.
    }
  }
  return new Buffer({
    currentPath: t.currentPath,
    content: t.content,
    savedContent: t.savedContent,
    cursorPos: t.cursorPos,
  });
}

/** Read the saved session (if any) and replace the buffer list. */
export async function loadSession(): Promise<void> {
  try {
    const session = await invoke<SessionShape | null>("load_session");
    if (!session || !session.tabs || session.tabs.length === 0) return;
    // `load_session` has already added each tab's path to the Rust
    // approve-list, so the per-tab `read_file` calls below are authorized.
    const buffers = await Promise.all(
      session.tabs.map((t) => restoreSessionTab(t)),
    );
    app.replaceBuffers(buffers, session.activeIdx ?? 0);
  } catch {
    // first run or corrupt session — start fresh, no error UI
  } finally {
    app.sessionLoaded = true;
  }
}

/* ── External-change detection ───────────────────────────────────────── */

/** Per-buffer re-entrancy guard so we never stack two dialogs for one tab. */
const externalCheckInFlight = new Set<number>();
/** Whole-sweep guard so a flurry of focus events doesn't pile up. */
let externalSweepInFlight = false;

/**
 * Detect whether the file backing `buffer` was changed by another program
 * since md-editor last read/saved it, and if so ask the user whether to
 * reload from disk or keep their in-memory version.
 *
 * Decision table once a change is detected:
 *   - "디스크 다시 불러오기" → replace content + saved baseline with disk.
 *   - "현재 내용 유지" → keep the in-memory content, but adopt disk as the new
 *     saved baseline so (a) we stop re-prompting for the same change and
 *     (b) the modified indicator reflects divergence from the actual file.
 *
 * No-ops for untitled buffers, unreadable files, or when a check for this
 * buffer is already running.
 */
export async function checkExternalChange(buffer: Buffer): Promise<void> {
  if (!buffer.currentPath) return;
  if (externalCheckInFlight.has(buffer.id)) return;
  externalCheckInFlight.add(buffer.id);
  try {
    let diskContent: string;
    try {
      diskContent = await invoke<string>("read_file", {
        path: buffer.currentPath,
      });
    } catch {
      // File removed / moved / unreadable — leave the buffer untouched.
      return;
    }

    // Disk still matches our last-known baseline → no external change.
    if (diskContent === buffer.savedContent) return;

    const hasUnsavedEdits = buffer.content !== buffer.savedContent;
    const name = safeForDialog(buffer.fileName);
    const detail = hasUnsavedEdits
      ? `"${name}" 파일이 다른 프로그램에서 변경되었습니다.\n` +
        `현재 저장하지 않은 편집 내용이 있습니다.\n\n` +
        `디스크의 새 버전을 불러오면 편집 중인 내용이 사라집니다. 어떻게 할까요?`
      : `"${name}" 파일이 다른 프로그램에서 변경되었습니다.\n\n` +
        `디스크의 새 버전을 불러올까요?`;

    const reload = await ask(detail, {
      title: "외부에서 파일이 변경됨",
      kind: "warning",
      okLabel: "디스크 다시 불러오기",
      cancelLabel: "현재 내용 유지",
    });

    // The file could have changed AGAIN while the dialog was open — re-read
    // so we apply the most current bytes.
    let latest = diskContent;
    try {
      latest = await invoke<string>("read_file", { path: buffer.currentPath });
    } catch {
      return;
    }

    if (reload) {
      buffer.content = latest;
      buffer.savedContent = latest;
      buffer.cursorPos = Math.min(buffer.cursorPos, latest.length);
    } else {
      // Keep in-memory content; rebase saved baseline onto disk.
      buffer.savedContent = latest;
    }
  } finally {
    externalCheckInFlight.delete(buffer.id);
  }
}

/**
 * Check every file-backed tab for external changes. Intended to run when the
 * window regains focus (the user likely just edited a file in another app and
 * switched back). Dialogs are shown sequentially — active tab first — so they
 * never stack on top of each other.
 */
export async function checkAllExternalChanges(): Promise<void> {
  if (externalSweepInFlight) return;
  externalSweepInFlight = true;
  try {
    const active = app.active;
    await checkExternalChange(active);
    // Snapshot the list so tab mutations mid-sweep don't break iteration.
    for (const b of [...app.buffers]) {
      if (b.id === active.id) continue;
      await checkExternalChange(b);
    }
  } finally {
    externalSweepInFlight = false;
  }
}
