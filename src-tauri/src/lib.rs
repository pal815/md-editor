mod commands;
mod menu;

use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Keep a single running instance. A second `md-editor.exe foo.md` from
        // the shell (file association double-click, "Open With", drag onto the
        // app icon) hands its args off to the first instance instead of
        // spawning a duplicate window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = commands::collect_file_args(&args);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                if !files.is_empty() {
                    let approved = app.state::<commands::ApprovedPaths>();
                    for f in &files {
                        approved.inner().add(PathBuf::from(f));
                    }
                    let _ = window.emit("files-dropped", files);
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::ApprovedPaths::default())
        .manage(commands::StartupFiles::default())
        .setup(|app| {
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;

            // Files passed on the very first launch (e.g., user double-clicked
            // a .md from Explorer). Approve them up-front and stash them for
            // the frontend to drain on mount via `consume_startup_files`.
            let startup_args: Vec<String> = std::env::args().collect();
            let startup_files = commands::collect_file_args(&startup_args);
            if !startup_files.is_empty() {
                let approved = app.state::<commands::ApprovedPaths>();
                for f in &startup_files {
                    approved.inner().add(PathBuf::from(f));
                }
                app.state::<commands::StartupFiles>()
                    .set(startup_files);
            }

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                let drop_window = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                        paths, ..
                    }) = event
                    {
                        let approved = app_handle.state::<commands::ApprovedPaths>();
                        for path in paths {
                            approved.inner().add(path.clone());
                        }
                        let payload = paths
                            .iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect::<Vec<_>>();
                        let _ = drop_window.emit("files-dropped", payload);
                    }
                });

                #[cfg(debug_assertions)]
                window.open_devtools();
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_file_open,
            commands::pick_file_save,
            commands::read_file,
            commands::write_file,
            commands::get_recent_files,
            commands::add_recent_file,
            commands::clear_recent_files,
            commands::save_session,
            commands::load_session,
            commands::consume_startup_files,
            commands::load_settings,
            commands::save_settings,
            commands::render_markdown,
            commands::get_file_association,
            commands::set_file_association,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
