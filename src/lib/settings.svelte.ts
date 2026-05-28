/**
 * Cross-app preferences (Viewer mode, external-image policy, etc.).
 *
 * Theme has its own module because it ties tightly into CodeMirror's
 * Compartment system; everything else lives here. Both modules persist to
 * the same `settings.json` (read-modify-write so they don't clobber one
 * another).
 */

import { invoke } from "@tauri-apps/api/core";

export type ViewMode = "edit" | "viewer";

interface SettingsShape {
  theme?: string;
  allowExternalImages?: boolean;
  viewMode?: string;
}

class Settings {
  /** "edit" shows the CodeMirror editor; "viewer" shows rendered HTML. */
  viewMode = $state<ViewMode>("edit");
  /** Whether to let the Viewer load external https images. Default off. */
  allowExternalImages = $state<boolean>(false);
  /** True once `init()` has finished reading from disk. */
  loaded = $state<boolean>(false);

  async init(): Promise<void> {
    try {
      const s = await invoke<SettingsShape>("load_settings");
      this.viewMode = s?.viewMode === "viewer" ? "viewer" : "edit";
      this.allowExternalImages = !!s?.allowExternalImages;
    } catch {
      // first run / backend not ready — keep defaults
    } finally {
      this.loaded = true;
    }
  }

  async setViewMode(mode: ViewMode): Promise<void> {
    this.viewMode = mode;
    await this.persist({ viewMode: mode });
  }

  async toggleViewMode(): Promise<void> {
    await this.setViewMode(this.viewMode === "edit" ? "viewer" : "edit");
  }

  async setAllowExternalImages(allow: boolean): Promise<void> {
    this.allowExternalImages = allow;
    await this.persist({ allowExternalImages: allow });
  }

  async toggleAllowExternalImages(): Promise<void> {
    await this.setAllowExternalImages(!this.allowExternalImages);
  }

  /**
   * Read-modify-write so we don't clobber the `theme` field (owned by theme.ts).
   */
  private async persist(patch: Partial<SettingsShape>): Promise<void> {
    try {
      const existing = await invoke<SettingsShape>("load_settings").catch(
        () => ({}) as SettingsShape,
      );
      const next: SettingsShape = { ...existing, ...patch };
      await invoke<void>("save_settings", { settings: next });
    } catch {
      // best-effort
    }
  }
}

export const settings = new Settings();
