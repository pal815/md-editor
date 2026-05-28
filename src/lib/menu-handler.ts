import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  newFile,
  openFile,
  saveFile,
  saveFileAs,
  clearRecentFiles,
  setFileAssociation,
} from "./file-ops";
import { setThemePref } from "./theme";
import { settings } from "./settings.svelte";

/**
 * Subscribe to native menu events emitted by the Rust side.
 * Returns an unlisten function for cleanup.
 */
export async function attachMenuHandler(
  onToggleLineNumbers?: () => void,
): Promise<UnlistenFn> {
  return listen<string>("menu", async (event) => {
    switch (event.payload) {
      case "new":
        await newFile();
        break;
      case "open":
        await openFile();
        break;
      case "save":
        await saveFile();
        break;
      case "save_as":
        await saveFileAs();
        break;
      case "clear_recent":
        await clearRecentFiles();
        break;
      case "register_md":
        await setFileAssociation(true);
        break;
      case "unregister_md":
        await setFileAssociation(false);
        break;
      case "toggle_line_numbers":
        onToggleLineNumbers?.();
        break;
      case "theme_light":
        await setThemePref("light");
        break;
      case "theme_dark":
        await setThemePref("dark");
        break;
      case "theme_system":
        await setThemePref("system");
        break;
      case "toggle_view_mode":
        await settings.toggleViewMode();
        break;
      case "toggle_external_images":
        await settings.toggleAllowExternalImages();
        break;
    }
  });
}
