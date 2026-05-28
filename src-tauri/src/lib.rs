// QuantVault desktop shell — supervises the local sidecars (SurrealDB,
// open-notebook API, and its job worker) and hosts the QuantVault UI as the
// webview. Fully offline; everything runs on the user's machine.
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Sidecars(Mutex<Vec<Child>>);

#[derive(Serialize, Debug)]
struct PdfEntry {
    path: String,
    name: String,
    size: u64,
    /// Path components below the picked root (forward-slash joined) — used by
    /// the frontend's CFA-source classifier to infer level/sourceKind.
    relative: String,
}

/// Walk a folder recursively and return every PDF found. The path argument
/// MUST be one the user just chose via the dialog plugin (the dialog narrows
/// fs scope; we don't open arbitrary roots ourselves).
#[tauri::command]
fn cfa_list_pdfs(folder: String) -> Result<Vec<PdfEntry>, String> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", folder));
    }
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    // Cap depth+breadth defensively so a stray pick of "/" doesn't pin the CPU.
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        if visited > 100_000 {
            return Err("Folder is too large to scan (over 100k entries).".into());
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited += 1;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let lowered = path
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.to_ascii_lowercase());
            if lowered.as_deref() != Some("pdf") {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let relative = pathdiff_to_string(&path, &root);
            out.push(PdfEntry {
                path: path.to_string_lossy().to_string(),
                name,
                size,
                relative,
            });
        }
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

fn pathdiff_to_string(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| s.replace('\\', "/"))
        .unwrap_or_default()
}

/// Open the native folder picker. Returns the chosen folder path, or null if
/// the user cancelled. Runs in a background blocking task so it doesn't stall
/// the webview's main thread.
#[tauri::command]
async fn cfa_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Choose a folder of CFA curriculum PDFs")
        .pick_folder(move |chosen| {
            // FilePath is platform-dependent; convert via Display.
            let path = chosen.map(|p| p.to_string());
            let _ = tx.send(path);
        });
    rx.recv()
        .map_err(|e| format!("Folder picker channel error: {e}"))
}

/// Read a file's bytes by absolute path. The path must come from a prior
/// `cfa_list_pdfs` call (which only walks below a user-chosen folder).
#[tauri::command]
fn cfa_read_pdf_bytes(path: String) -> Result<Vec<u8>, String> {
    let lowered = path.to_ascii_lowercase();
    if !lowered.ends_with(".pdf") {
        return Err("Refusing to read non-PDF path.".into());
    }
    std::fs::read(&path).map_err(|e| format!("read failed: {e}"))
}

/// Locate the local services directory. Override with QV_SERVICES_DIR; otherwise
/// look for a `spike/` dir near the working directory (dev) — later this points
/// at bundled resources.
fn services_dir() -> PathBuf {
    if let Ok(p) = std::env::var("QV_SERVICES_DIR") {
        return PathBuf::from(p);
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    for cand in [cwd.join("spike"), cwd.join("..").join("spike")] {
        if cand.join("bin").exists() || cand.join("open-notebook").exists() {
            return cand;
        }
    }
    cwd.join("spike")
}

fn spawn_sidecars() -> Vec<Child> {
    let dir = services_dir();
    let onb = dir.join("open-notebook");
    let env_file = onb.join(".env");
    let mut kids = Vec::new();

    // 1) SurrealDB (single binary, the one local brain)
    let db = dir.join("surreal_data").join("db");
    match Command::new(dir.join("bin").join("surreal2.exe"))
        .args(["start", "--user", "root", "--pass", "root"])
        .arg(format!("rocksdb:{}", db.display()))
        .spawn()
    {
        Ok(c) => {
            log::info!("sidecar: SurrealDB started (pid {})", c.id());
            kids.push(c);
        }
        Err(e) => log::error!("sidecar: SurrealDB failed to start: {e}"),
    }

    // 2) open-notebook FastAPI backend
    match Command::new("uv")
        .arg("run").arg("--directory").arg(&onb)
        .arg("--env-file").arg(&env_file)
        .args(["python", "run_api.py"])
        .spawn()
    {
        Ok(c) => {
            log::info!("sidecar: open-notebook API started (pid {})", c.id());
            kids.push(c);
        }
        Err(e) => log::error!("sidecar: open-notebook API failed to start: {e}"),
    }

    // 3) surreal-commands job worker (PYTHONUTF8 avoids cp1252 console crash on Windows)
    match Command::new("uv")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg("run").arg("--directory").arg(&onb)
        .arg("--env-file").arg(&env_file)
        .args(["surreal-commands-worker", "--import-modules", "commands"])
        .spawn()
    {
        Ok(c) => {
            log::info!("sidecar: open-notebook worker started (pid {})", c.id());
            kids.push(c);
        }
        Err(e) => log::error!("sidecar: open-notebook worker failed to start: {e}"),
    }

    kids
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn pathdiff_strips_root_and_normalizes_separators() {
        let root = PathBuf::from("C:/users/me/cfa");
        let path = PathBuf::from("C:/users/me/cfa/level1/volume1.pdf");
        assert_eq!(pathdiff_to_string(&path, &root), "level1/volume1.pdf");
    }

    #[test]
    fn pathdiff_returns_empty_when_not_under_root() {
        let root = PathBuf::from("C:/a");
        let path = PathBuf::from("C:/b/file.pdf");
        assert_eq!(pathdiff_to_string(&path, &root), "");
    }

    #[test]
    fn list_pdfs_errors_for_missing_directory() {
        let result = cfa_list_pdfs("Z:/quantvault-does-not-exist-xyzzy".into());
        assert!(result.is_err());
        let message = result.unwrap_err();
        assert!(message.contains("Not a directory"));
    }

    #[test]
    fn list_pdfs_walks_recursively_and_filters_to_pdfs() {
        // Build a temp tree with one PDF, one .txt, and one nested PDF.
        let tmp = std::env::temp_dir().join("qv-test-list-pdfs");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("nested")).unwrap();
        fs::write(tmp.join("a.pdf"), b"%PDF-1.4 stub").unwrap();
        fs::write(tmp.join("notes.txt"), b"ignore me").unwrap();
        fs::write(tmp.join("nested/b.pdf"), b"%PDF-1.4 stub b").unwrap();

        let entries = cfa_list_pdfs(tmp.to_string_lossy().to_string()).expect("walk");
        let names: Vec<_> = entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"a.pdf".to_string()));
        assert!(names.contains(&"b.pdf".to_string()));
        assert_eq!(entries.len(), 2);
        // Relative paths are forward-slash normalized.
        let nested = entries.iter().find(|e| e.name == "b.pdf").unwrap();
        assert_eq!(nested.relative, "nested/b.pdf");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_pdf_bytes_refuses_non_pdf_paths() {
        let result = cfa_read_pdf_bytes("/tmp/not-a-pdf.txt".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("non-PDF"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![cfa_list_pdfs, cfa_pick_folder, cfa_read_pdf_bytes])
        .manage(Sidecars::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let kids = spawn_sidecars();
            if let Some(state) = app.try_state::<Sidecars>() {
                *state.0.lock().unwrap() = kids;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building QuantVault desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Sidecars>() {
                    for mut child in state.0.lock().unwrap().drain(..) {
                        let _ = child.kill();
                        log::info!("sidecar: terminated on exit");
                    }
                }
            }
        });
}
