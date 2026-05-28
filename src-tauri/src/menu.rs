use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime, Wry};

/// Build the native application menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("clear_recent", "Clear Recent Files").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("register_md", "Set as .md Handler…").build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("unregister_md", "Remove .md Handler").build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Exit"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let theme_submenu = SubmenuBuilder::new(app, "Theme")
        .item(&MenuItemBuilder::with_id("theme_light", "Light").build(app)?)
        .item(&MenuItemBuilder::with_id("theme_dark", "Dark").build(app)?)
        .item(&MenuItemBuilder::with_id("theme_system", "Follow System").build(app)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle_view_mode", "Toggle Edit / Viewer")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle_external_images", "Allow External Images (Viewer)")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("toggle_line_numbers", "Toggle Line Numbers").build(app)?)
        .separator()
        .item(&theme_submenu)
        .build()?;

    MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&view)
        .build()
}

/// Handle a menu event by forwarding the id to the frontend as a `menu` event.
pub fn handle_event(app: &AppHandle<Wry>, id: &str) {
    // Predefined items (undo, redo, cut, copy, paste, select_all, quit)
    // are handled natively by the OS — they don't reach this handler.
    let _ = app.emit("menu", id.to_string());
}
