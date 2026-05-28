/**
 * Global app state using Svelte 5 runes.
 *
 * The app is organised as a list of open buffers (one per tab). Each Buffer
 * holds the editable state for a single document.
 */

let bufferSerial = 0;

export interface BufferInit {
  currentPath?: string | null;
  content?: string;
  savedContent?: string;
  cursorPos?: number;
}

export class Buffer {
  /** Stable identifier for keyed lists / tab routing. */
  readonly id: number;

  /** Absolute path on disk, or null for an untitled buffer. */
  currentPath = $state<string | null>(null);

  /** Full text content. */
  content = $state<string>("");

  /** Content snapshot at the last save/load — used to detect modifications. */
  savedContent = $state<string>("");

  /** Absolute cursor offset in `content`. */
  cursorPos = $state<number>(0);

  constructor(init: BufferInit = {}) {
    this.id = ++bufferSerial;
    this.currentPath = init.currentPath ?? null;
    this.content = init.content ?? "";
    this.savedContent = init.savedContent ?? "";
    this.cursorPos = init.cursorPos ?? 0;
  }

  get isModified(): boolean {
    return this.content !== this.savedContent;
  }

  get fileName(): string {
    if (!this.currentPath) return "Untitled";
    const norm = this.currentPath.replace(/\\/g, "/");
    return norm.substring(norm.lastIndexOf("/") + 1);
  }
}

class AppState {
  /** Open tabs in display order. There is always at least one. */
  buffers = $state<Buffer[]>([new Buffer()]);

  /** Identifier of the currently active tab. */
  activeId = $state<number>(this.buffers[0].id);

  /** Recent files history (independent of which tabs are open). */
  recentFiles = $state<string[]>([]);

  /** True once the saved session has been read from disk on startup. */
  sessionLoaded = $state<boolean>(false);

  /** Resolve the buffer matching `activeId`. Self-heals if state is stale. */
  get active(): Buffer {
    const found = this.buffers.find((b) => b.id === this.activeId);
    if (found) return found;
    if (this.buffers.length === 0) {
      const fresh = new Buffer();
      this.buffers.push(fresh);
      this.activeId = fresh.id;
      return fresh;
    }
    this.activeId = this.buffers[0].id;
    return this.buffers[0];
  }

  addBuffer(buffer: Buffer = new Buffer()): Buffer {
    this.buffers.push(buffer);
    this.activeId = buffer.id;
    return buffer;
  }

  /** Remove a tab; if it was active, pick a sensible neighbour. */
  closeBuffer(id: number): void {
    const idx = this.buffers.findIndex((b) => b.id === id);
    if (idx === -1) return;
    this.buffers.splice(idx, 1);
    if (this.buffers.length === 0) {
      this.addBuffer();
      return;
    }
    if (this.activeId === id) {
      const newIdx = Math.min(idx, this.buffers.length - 1);
      this.activeId = this.buffers[newIdx].id;
    }
  }

  switchTo(id: number): void {
    if (this.buffers.some((b) => b.id === id)) {
      this.activeId = id;
    }
  }

  /** Jump to next / previous tab in display order. */
  cycleTab(direction: 1 | -1): void {
    if (this.buffers.length <= 1) return;
    const idx = this.buffers.findIndex((b) => b.id === this.activeId);
    const next = (idx + direction + this.buffers.length) % this.buffers.length;
    this.activeId = this.buffers[next].id;
  }

  /** Replace all buffers with the given list (used to restore a session). */
  replaceBuffers(buffers: Buffer[], activeIdx = 0): void {
    if (buffers.length === 0) buffers = [new Buffer()];
    this.buffers = buffers;
    const safeIdx = Math.max(0, Math.min(activeIdx, buffers.length - 1));
    this.activeId = buffers[safeIdx].id;
  }
}

export const app = new AppState();
