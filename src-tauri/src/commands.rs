use pulldown_cmark::{html, Options, Parser};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

const RECENT_FILE_NAME: &str = "recent.json";
const SESSION_FILE_NAME: &str = "session.json";
const SETTINGS_FILE_NAME: &str = "settings.json";
const RECENT_LIMIT: usize = 10;
/// Hard ceiling on file size we'll happily slurp into memory. Anything bigger
/// is probably not a markdown document the user actually wants to edit, and
/// loading it would risk OOM (or DoS via a tampered recent-files entry).
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024; // 64 MB
const PATH_NOT_APPROVED: &str = "Path not approved. Open or save the file via the menu first.";

#[derive(Default)]
pub struct ApprovedPaths(pub std::sync::Mutex<std::collections::HashSet<PathBuf>>);

impl ApprovedPaths {
    pub fn add(&self, path: PathBuf) {
        let keys = approval_keys(&path);
        let mut approved = self.0.lock().unwrap_or_else(|err| err.into_inner());
        for key in keys {
            approved.insert(key);
        }
    }

    pub fn contains(&self, path: &Path) -> bool {
        let keys = approval_keys(path);
        let approved = self.0.lock().unwrap_or_else(|err| err.into_inner());
        keys.iter().any(|key| approved.contains(key))
    }
}

/// Files passed on the command line at startup (Windows file association /
/// "Open With" double-click). Populated in `lib.rs` before the webview is
/// ready; drained once by the frontend on mount.
#[derive(Default)]
pub struct StartupFiles(pub std::sync::Mutex<Vec<String>>);

impl StartupFiles {
    pub fn set(&self, files: Vec<String>) {
        let mut guard = self.0.lock().unwrap_or_else(|err| err.into_inner());
        *guard = files;
    }

    pub fn take(&self) -> Vec<String> {
        let mut guard = self.0.lock().unwrap_or_else(|err| err.into_inner());
        std::mem::take(&mut *guard)
    }
}

/// Filter raw CLI args down to existing files. The first arg (the exe path)
/// is skipped. Anything that isn't a real file on disk is dropped silently —
/// we don't want to litter the approve-list with garbage.
pub fn collect_file_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter_map(|raw| {
            let p = PathBuf::from(raw);
            if p.is_file() {
                Some(p.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub fn consume_startup_files(startup: State<'_, StartupFiles>) -> Vec<String> {
    startup.inner().take()
}

fn approval_keys(path: &Path) -> Vec<PathBuf> {
    let mut keys = vec![approval_key(path)];
    if let Some(canonical) = canonicalize_for_approval(path) {
        let canonical_key = approval_key(&canonical);
        if !keys.contains(&canonical_key) {
            keys.push(canonical_key);
        }
    }
    keys
}

#[cfg(target_os = "windows")]
fn approval_key(path: &Path) -> PathBuf {
    let mut key = path.to_string_lossy().replace('/', "\\").to_lowercase();
    if let Some(stripped) = key.strip_prefix("\\\\?\\") {
        key = stripped.to_string();
    }
    PathBuf::from(key)
}

#[cfg(not(target_os = "windows"))]
fn approval_key(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn canonicalize_for_approval(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Some(canonical);
    }

    let parent = path.parent()?;
    let name = path.file_name()?;
    let parent_canonical = parent.canonicalize().ok()?;
    Some(parent_canonical.join(name))
}

fn ensure_approved_path(approved: &ApprovedPaths, validated: &Path) -> Result<(), String> {
    if approved.contains(validated) {
        Ok(())
    } else {
        Err(PATH_NOT_APPROVED.to_string())
    }
}

fn markdown_dialog<R: tauri::Runtime>(dialog: FileDialogBuilder<R>) -> FileDialogBuilder<R> {
    dialog
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .add_filter("All Files", &["*"])
}

fn set_dialog_default_path<R: tauri::Runtime>(
    mut dialog: FileDialogBuilder<R>,
    default_path: PathBuf,
) -> FileDialogBuilder<R> {
    let default_path: PathBuf = default_path.components().collect();
    if default_path.is_file() || !default_path.exists() {
        if let (Some(parent), Some(file_name)) = (default_path.parent(), default_path.file_name()) {
            if parent.components().count() > 0 {
                dialog = dialog.set_directory(parent);
            }
            dialog.set_file_name(file_name.to_string_lossy())
        } else {
            dialog.set_directory(default_path)
        }
    } else {
        dialog.set_directory(default_path)
    }
}

async fn recv_dialog_path(
    rx: tokio::sync::oneshot::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> Result<Option<PathBuf>, String> {
    let Some(path) = rx
        .await
        .map_err(|_| "File dialog closed before returning a path.".to_string())?
    else {
        return Ok(None);
    };
    path.into_path()
        .map(Some)
        .map_err(|e| format!("Invalid selected path: {e}"))
}

/* ── Path safety ─────────────────────────────────────────────────────── */

/// Validate that a path supplied by the frontend isn't pointing at system
/// directories. This is defence-in-depth — the legitimate UI only ever passes
/// paths the user explicitly picked via the OS file dialog (or paths in their
/// own recent/session history that originally came from such a dialog), but a
/// compromised WebView could otherwise invoke `read_file` / `write_file` with
/// arbitrary paths.
///
/// We resolve symlinks and `..` segments via canonicalize. For paths whose
/// target doesn't exist yet (new file in `write_file`), we canonicalize the
/// parent directory and rejoin the file name.
fn validate_path(path_str: &str) -> Result<PathBuf, String> {
    // Reject early — before any canonicalize / FS resolution that could
    // trigger network access (SMB auth on UNC) or surprise reparses.
    reject_unc(path_str)?;
    #[cfg(target_os = "windows")]
    reject_ntfs_ads(path_str)?;

    let raw = PathBuf::from(path_str);

    let canonical = match raw.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            // Likely doesn't exist yet (new file). Canonicalize the parent and
            // rejoin the filename.
            let parent = raw
                .parent()
                .ok_or_else(|| "Path has no parent directory".to_string())?;
            let parent_canonical = parent
                .canonicalize()
                .map_err(|e| format!("Invalid parent directory: {e}"))?;
            let name = raw
                .file_name()
                .ok_or_else(|| "Path has no filename".to_string())?;
            parent_canonical.join(name)
        }
    };

    // Re-check UNC after canonicalize because a symlink could resolve to one.
    reject_unc(&canonical.to_string_lossy())?;

    if is_system_dir(&canonical) {
        return Err("Access to system directories is not allowed.".to_string());
    }
    Ok(canonical)
}

/// Reject UNC (`\\server\share\…`) and device-namespace (`\\.\…`) forms
/// outright — on Windows they can trigger SMB authentication against
/// attacker-controlled servers.
///
/// The `\\?\…` "verbatim" prefix is what `Path::canonicalize` produces for
/// **local** paths (e.g. `\\?\C:\Users\…`); those are fine to accept. Only
/// `\\?\UNC\server\share\…` — the verbatim flavour of a UNC path — is still
/// rejected.
fn reject_unc(path: &str) -> Result<(), String> {
    let trimmed = path.trim_start();
    let normalized = trimmed.replace('/', "\\");

    if !normalized.starts_with("\\\\") {
        return Ok(());
    }
    let rest = &normalized[2..];

    if let Some(after_q) = rest.strip_prefix("?\\") {
        // `\\?\UNC\…` → UNC in verbatim form. Reject.
        if after_q.to_ascii_uppercase().starts_with("UNC\\") {
            return Err("UNC / network paths are not allowed.".to_string());
        }
        // `\\?\C:\…` and similar local verbatim paths are fine.
        return Ok(());
    }

    if rest.starts_with(".\\") {
        return Err("Device-namespace paths are not allowed.".to_string());
    }

    // Plain UNC: `\\server\share\…`.
    Err("UNC / network paths are not allowed.".to_string())
}

/// Block NTFS alternate data streams (`note.md:hidden`). The first `:` after
/// the drive letter (position 1 in `C:\…`) is the only legitimate occurrence.
#[cfg(target_os = "windows")]
fn reject_ntfs_ads(path: &str) -> Result<(), String> {
    let after_drive = if path.len() >= 2
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[0].is_ascii_alphabetic()
    {
        &path[2..]
    } else {
        path
    };
    if after_drive.contains(':') {
        return Err("NTFS alternate data streams are not allowed.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_system_dir(p: &Path) -> bool {
    // Normalize to backslashes + lowercase so casing / separator variations
    // don't bypass the check. Strip the verbatim-length prefix if present.
    let s = p.to_string_lossy().to_lowercase().replace('/', "\\");
    let s = s.trim_start_matches("\\\\?\\").to_string();

    // Pick up system roots from env vars so non-C: installs aren't missed.
    let mut blocked: Vec<String> = Vec::new();
    for var in [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Ok(v) = std::env::var(var) {
            blocked.push(v.to_lowercase().replace('/', "\\"));
        }
    }
    // Fallbacks in case env vars aren't set.
    blocked.extend(
        [
            "c:\\windows",
            "c:\\program files",
            "c:\\program files (x86)",
            "c:\\programdata",
        ]
        .iter()
        .map(|s| s.to_string()),
    );

    for root in &blocked {
        let root_slash = format!("{root}\\");
        if s == *root || s.starts_with(&root_slash) {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn is_system_dir(p: &Path) -> bool {
    let s = p.to_string_lossy().to_string();
    // Both the plain Unix form and macOS' canonicalized `/private/...` form,
    // plus macOS system trees.
    const BLOCKED: &[&str] = &[
        "/etc",
        "/sys",
        "/proc",
        "/boot",
        "/dev",
        "/private/etc",
        "/private/var",
        "/System",
        "/Library",
        "/usr/bin",
        "/usr/sbin",
        "/sbin",
        "/bin",
    ];
    BLOCKED
        .iter()
        .any(|b| s == *b || s.starts_with(&format!("{b}/")))
}

/* ── Recent files ─────────────────────────────────────────────────────── */

#[derive(Debug, Serialize, Deserialize, Default)]
struct RecentFilesStore {
    paths: Vec<String>,
}

fn recent_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(dir.join(RECENT_FILE_NAME))
}

fn load_recent(app: &AppHandle) -> RecentFilesStore {
    let path = match recent_store_path(app) {
        Ok(p) => p,
        Err(_) => return RecentFilesStore::default(),
    };
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => RecentFilesStore::default(),
    }
}

fn save_recent(app: &AppHandle, store: &RecentFilesStore) -> Result<(), String> {
    let path = recent_store_path(app)?;
    let content = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/* ── File I/O ─────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn pick_file_open(
    app: AppHandle,
    approved: State<'_, ApprovedPaths>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    markdown_dialog(app.dialog().file()).pick_file(move |path| {
        let _ = tx.send(path);
    });

    let Some(path) = recv_dialog_path(rx).await? else {
        return Ok(None);
    };
    approved.inner().add(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_file_save(
    app: AppHandle,
    approved: State<'_, ApprovedPaths>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = markdown_dialog(app.dialog().file());
    if let Some(default_path) = default_path {
        dialog = set_dialog_default_path(dialog, PathBuf::from(default_path));
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });

    let Some(path) = recv_dialog_path(rx).await? else {
        return Ok(None);
    };
    approved.inner().add(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn read_file(path: String, approved: State<'_, ApprovedPaths>) -> Result<String, String> {
    let validated = validate_path(&path)?;
    ensure_approved_path(approved.inner(), &validated)?;
    let metadata = fs::metadata(&validated).map_err(|e| format!("Failed to stat file: {e}"))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "File too large ({:.1} MB). The 64 MB limit keeps the editor responsive.",
            metadata.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    fs::read_to_string(&validated).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub fn write_file(
    path: String,
    contents: String,
    approved: State<'_, ApprovedPaths>,
) -> Result<(), String> {
    if contents.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "Buffer too large to save ({:.1} MB > 64 MB limit).",
            contents.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let validated = validate_path(&path)?;
    ensure_approved_path(approved.inner(), &validated)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&validated)
        .map_err(|e| format!("Failed to open file for write: {e}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("Failed to write file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_recent_files(app: AppHandle, approved: State<'_, ApprovedPaths>) -> Vec<String> {
    let store = load_recent(&app);
    let approved = approved.inner();
    store
        .paths
        .into_iter()
        .filter_map(|p| {
            if Path::new(&p).exists() {
                approved.add(PathBuf::from(&p));
                Some(p)
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub fn add_recent_file(
    app: AppHandle,
    path: String,
    approved: State<'_, ApprovedPaths>,
) -> Result<Vec<String>, String> {
    // Even though add_recent_file only stores the path (no I/O), we validate
    // here too so a compromised UI can't poison the recent-files file with
    // entries pointing at system directories that would later be auto-opened.
    let validated = validate_path(&path)?;
    ensure_approved_path(approved.inner(), &validated)?;
    let mut store = load_recent(&app);
    store.paths.retain(|p| p != &path);
    store.paths.insert(0, path);
    store.paths.truncate(RECENT_LIMIT);
    save_recent(&app, &store)?;
    Ok(store.paths)
}

#[tauri::command]
pub fn clear_recent_files(app: AppHandle) -> Result<(), String> {
    save_recent(&app, &RecentFilesStore::default())
}

/* ── Session persistence ──────────────────────────────────────────────── */

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub current_path: Option<String>,
    pub content: String,
    pub saved_content: String,
    pub cursor_pos: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub tabs: Vec<SessionTab>,
    pub active_idx: usize,
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(dir.join(SESSION_FILE_NAME))
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    approved: State<'_, ApprovedPaths>,
    session: Session,
) -> Result<(), String> {
    for path in session
        .tabs
        .iter()
        .filter_map(|tab| tab.current_path.as_ref())
    {
        let validated = validate_path(path)?;
        ensure_approved_path(approved.inner(), &validated)?;
    }

    let path = session_path(&app)?;
    let content = serde_json::to_string_pretty(&session).map_err(|e| format!("serialize: {e}"))?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("Session payload exceeds 64 MB safety limit.".to_string());
    }
    fs::write(&path, content).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/* ── Markdown rendering (Viewer mode) ────────────────────────────────── */

/// Render a markdown string to HTML using pulldown-cmark. Raw inline HTML in
/// the source IS allowed through (so users can include `<details>` etc.) but
/// the frontend is required to run the output through DOMPurify before
/// inserting it into the document. We never inject this server-side — the
/// frontend takes the string from this command, sanitises, then sets innerHTML.
#[tauri::command]
pub fn render_markdown(source: String) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    // ENABLE_GFM-like behaviour is achieved by the above flags; we
    // deliberately leave raw HTML enabled (default) but rely on DOMPurify
    // in the frontend to keep the output safe.

    let parser = Parser::new_ext(&source, options);
    let mut out = String::with_capacity(source.len() + source.len() / 2);
    html::push_html(&mut out, parser);
    out
}

/* ── App settings ─────────────────────────────────────────────────────── */

/// User-level preferences that survive across sessions. Kept tiny and string-y
/// so we don't end up with a sprawling schema; everything here is purely
/// cosmetic / behavioural (no paths, no secrets).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "light" | "dark" | "system". Anything else is treated as "system".
    pub theme: String,
    /// Allow external https images in Viewer mode. Off by default to avoid
    /// tracking-pixel leaks via remote images in markdown documents.
    pub allow_external_images: bool,
    /// Last view mode used (per-app, not per-tab).
    /// "edit" | "viewer". Defaults to "edit".
    pub view_mode: String,
    /// Whether the editor's line-numbers gutter is shown. On by default;
    /// configs written before this field existed are treated as `true`.
    #[serde(default = "default_true")]
    pub show_line_numbers: bool,
}

fn default_true() -> bool {
    true
}

// Manual `Default` (instead of deriving) so a missing settings file — or any
// field absent from an older config — yields the same sensible defaults that
// `#[serde(default)]` uses to fill gaps, including `show_line_numbers: true`.
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: String::new(),
            allow_external_images: false,
            view_mode: String::new(),
            show_line_numbers: true,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Settings {
    let path = match settings_path(&app) {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let content = serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_session(app: AppHandle, approved: State<'_, ApprovedPaths>) -> Option<Session> {
    let path = session_path(&app).ok()?;
    // Cap how much we'll deserialize so a tampered session.json can't OOM us.
    let metadata = fs::metadata(&path).ok()?;
    if metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let session: Session = serde_json::from_str(&content).ok()?;
    for path in session
        .tabs
        .iter()
        .filter_map(|tab| tab.current_path.as_ref())
    {
        approved.inner().add(PathBuf::from(path));
    }
    Some(session)
}

/* ── Windows .md file association (per-user, opt-in) ──────────────────── */

/// We deliberately do NOT register file associations from the installer.
/// Instead the user opts in from the app's File menu, which writes a
/// per-user ProgID under `HKCU\Software\Classes` and adds md-editor to each
/// extension's `OpenWithProgids` list. This never touches HKLM, needs no
/// admin rights, and is fully reversible.
#[cfg(target_os = "windows")]
mod file_assoc {
    use winreg::enums::*;
    use winreg::RegKey;

    const PROG_ID: &str = "md-editor.markdown";
    const EXTS: &[&str] = &["md", "markdown", "mdown", "mkd"];

    fn exe_path() -> Result<String, String> {
        let p = std::env::current_exe().map_err(|e| format!("exe path: {e}"))?;
        p.to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "executable path is not valid UTF-8".to_string())
    }

    pub fn is_registered() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!("Software\\Classes\\{PROG_ID}"))
            .is_ok()
    }

    pub fn register() -> Result<(), String> {
        let exe = exe_path()?;
        let classes = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
            .map_err(|e| format!("open HKCU\\Software\\Classes: {e}"))?;

        // ProgID with icon + open command.
        let (progid, _) = classes
            .create_subkey(PROG_ID)
            .map_err(|e| format!("create ProgID: {e}"))?;
        progid
            .set_value("", &"Markdown Document")
            .map_err(|e| e.to_string())?;
        let (icon, _) = progid
            .create_subkey("DefaultIcon")
            .map_err(|e| e.to_string())?;
        icon.set_value("", &format!("{exe},0"))
            .map_err(|e| e.to_string())?;
        let (cmd, _) = progid
            .create_subkey("shell\\open\\command")
            .map_err(|e| e.to_string())?;
        cmd.set_value("", &format!("\"{exe}\" \"%1\""))
            .map_err(|e| e.to_string())?;

        // Add the ProgID to each extension's Open-With list.
        for ext in EXTS {
            let (ext_key, _) = classes
                .create_subkey(format!(".{ext}"))
                .map_err(|e| e.to_string())?;
            let (owp, _) = ext_key
                .create_subkey("OpenWithProgids")
                .map_err(|e| e.to_string())?;
            owp.set_value(PROG_ID, &"").map_err(|e| e.to_string())?;
        }

        notify_assoc_changed();
        Ok(())
    }

    pub fn unregister() -> Result<(), String> {
        let classes = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
            .map_err(|e| format!("open HKCU\\Software\\Classes: {e}"))?;

        for ext in EXTS {
            if let Ok(owp) = classes.open_subkey_with_flags(
                format!(".{ext}\\OpenWithProgids"),
                KEY_WRITE,
            ) {
                let _ = owp.delete_value(PROG_ID);
            }
        }
        // Remove the whole ProgID tree (ignore "not found").
        let _ = classes.delete_subkey_all(PROG_ID);

        notify_assoc_changed();
        Ok(())
    }

    /// Tell the shell that file associations changed so Explorer refreshes
    /// without a logoff. Declared inline to avoid pulling in a winapi crate.
    fn notify_assoc_changed() {
        #[link(name = "shell32")]
        extern "system" {
            fn SHChangeNotify(
                w_event_id: i32,
                u_flags: u32,
                dw_item1: *const core::ffi::c_void,
                dw_item2: *const core::ffi::c_void,
            );
        }
        const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
        const SHCNF_IDLIST: u32 = 0x0000;
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED,
                SHCNF_IDLIST,
                core::ptr::null(),
                core::ptr::null(),
            );
        }
    }
}

/// Whether md-editor is currently registered as a `.md` handler for the
/// current user. Always false on non-Windows platforms.
#[tauri::command]
pub fn get_file_association() -> bool {
    #[cfg(target_os = "windows")]
    {
        file_assoc::is_registered()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Register (`enabled = true`) or remove (`enabled = false`) the per-user
/// `.md` file association. Returns the resulting registration state.
#[tauri::command]
pub fn set_file_association(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            file_assoc::register()?;
        } else {
            file_assoc::unregister()?;
        }
        Ok(file_assoc::is_registered())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("File association is only supported on Windows.".to_string())
    }
}
