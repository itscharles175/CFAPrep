// QuantVault desktop shell — supervises the local sidecars (SurrealDB,
// open-notebook API, and its job worker) and hosts the QuantVault UI as the
// webview. Fully offline; everything runs on the user's machine.
//
// Sidecar resolution (`services_dir`) currently expects a `spike/` directory
// next to the working dir containing the SurrealDB binary + the open-notebook
// clone with its `.venv`. That's a dev-time arrangement only. Production
// packaging (Pillar 0, still open) needs to bundle the Python backend via
// PyInstaller into Tauri's `resourceDir()` and update this path resolution.
// Set the `QV_SERVICES_DIR` env var to override the search at runtime.
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
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
    pick_folder_recv(rx)
}

/// Pure-logic wrapper around the dialog callback's channel receive. Extracted
/// so unit tests can exercise the success / cancel / channel-closed branches
/// without bringing up a real Tauri AppHandle + dialog plugin.
fn pick_folder_recv(
    rx: std::sync::mpsc::Receiver<Option<String>>,
) -> Result<Option<String>, String> {
    rx.recv()
        .map_err(|e| format!("Folder picker channel error: {e}"))
}

/// Read a file's bytes by absolute path. The path must come from a prior
/// `cfa_list_pdfs` call (which only walks below a user-chosen folder).
#[tauri::command]
fn cfa_read_pdf_bytes(path: String) -> Result<Vec<u8>, String> {
    cfa_read_pdf_bytes_impl(&path)
}

/// Pure helper backing `cfa_read_pdf_bytes`. Validates the path is a regular
/// `.pdf` file before reading; surfaces distinct error strings for the missing,
/// non-file, and wrong-extension cases so the UI (and tests) can branch.
fn cfa_read_pdf_bytes_impl(path: &str) -> Result<Vec<u8>, String> {
    let lowered = path.to_ascii_lowercase();
    if !lowered.ends_with(".pdf") {
        return Err("Refusing to read non-PDF path.".into());
    }
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if !p.is_file() {
        return Err(format!("Not a regular file: {}", path));
    }
    std::fs::read(path).map_err(|e| format!("read failed: {e}"))
}

/// Locate the local services directory. Search order:
///   1. `QV_SERVICES_DIR` env var (explicit override; used in tests + CI).
///   2. `spike/` next to the working directory (dev arrangement).
///   3. `spike/` one level up from cwd (running from `src-tauri/`).
///   4. `resources/services/` next to the running executable (production
///      install path — populated by the Tauri bundler's `bundle.resources`
///      list once the PyInstaller-bundled backend is wired in Pillar 0).
///   5. `../Resources/services/` next to the running executable (macOS .app
///      bundle layout).
///   6. Fall back to `spike/` under cwd so log output reads coherently
///      even when nothing exists.
fn services_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_default();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_default();
    let env_override = std::env::var("QV_SERVICES_DIR").ok().map(PathBuf::from);
    services_dir_search(env_override.as_deref(), &cwd, &exe_dir)
        .unwrap_or_else(|| cwd.join("spike"))
}

/// Pure search routine for `services_dir`. Returns `Some(path)` if any of the
/// documented candidates resolves to an existing services directory (an env
/// override is honored even if its target doesn't yet exist, matching the
/// runtime override semantics callers rely on in tests + CI); returns `None`
/// when no candidate is usable.
///
/// Heuristic for "this is a services directory": the candidate exists and
/// contains a `bin/` subdirectory (where the SurrealDB binary lives), an
/// `open-notebook/` subdirectory (the FastAPI clone), or an `lsat-backend/`
/// subdirectory (StudyVault's frozen LSAT sidecar). Any one is enough to pin
/// the layout — in dev several are present; in a packaged install only the
/// bundled ones exist.
fn services_dir_search(
    env_override: Option<&Path>,
    cwd: &Path,
    exe_dir: &Path,
) -> Option<PathBuf> {
    if let Some(p) = env_override {
        if p.exists() {
            return Some(p.to_path_buf());
        }
        // Honor the override even if missing — explicit operator intent.
        return Some(p.to_path_buf());
    }
    let candidates = [
        cwd.join("spike"),
        cwd.join("..").join("spike"),
        exe_dir.join("resources").join("services"),
        exe_dir.join("..").join("Resources").join("services"),
    ];
    for cand in &candidates {
        if cand.join("bin").exists()
            || cand.join("open-notebook").exists()
            || cand.join("lsat-backend").exists()
        {
            return Some(cand.clone());
        }
    }
    None
}

/// TCP "is this port up?" probe used by the supervisor's readiness checks and
/// exercised by the integration tests. Returns false on any DNS, connect, or
/// timeout error — callers treat absence as "not yet listening".
#[allow(dead_code)] // Wired in by the readiness-gate work that owns sidecar startup ordering.
fn is_port_listening(host: &str, port: u16, timeout_ms: u64) -> bool {
    let timeout = Duration::from_millis(timeout_ms);
    let addrs: Vec<SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(it) => it.collect(),
        Err(_) => return false,
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return true;
        }
    }
    false
}

/// Declarative description of one sidecar process. Decoupled from
/// `std::process::Command` so the supervisor's orchestration (which sidecars
/// to spawn, with what args, in what order) can be unit-tested via a mock
/// launcher without exec'ing real binaries.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SidecarSpec {
    /// Human-readable tag used in log lines (e.g. "SurrealDB").
    name: String,
    /// Executable to invoke. May be an absolute path (SurrealDB binary) or a
    /// PATH lookup (`uv`).
    program: PathBuf,
    args: Vec<String>,
    /// Extra env vars layered onto the inherited environment.
    env: Vec<(String, String)>,
}

/// Abstraction over "spawn this child". The production impl shells out via
/// `std::process::Command`; tests substitute a mock that records the request
/// without touching the real process table.
trait SidecarLauncher {
    fn launch(&self, spec: &SidecarSpec) -> Result<Child, String>;
}

struct ProcessLauncher;

impl SidecarLauncher for ProcessLauncher {
    fn launch(&self, spec: &SidecarSpec) -> Result<Child, String> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.spawn().map_err(|e| e.to_string())
    }
}

/// Build the three sidecar specs the supervisor manages, parameterized by the
/// resolved services directory. Pure — does no I/O — so tests can assert that
/// the program paths, args, and env match what we expect for a given `dir`.
fn build_sidecar_specs(dir: &Path) -> Vec<SidecarSpec> {
    let onb = dir.join("open-notebook");
    let env_file = onb.join(".env");
    let db = dir.join("surreal_data").join("db");

    let surreal = SidecarSpec {
        name: "SurrealDB".into(),
        program: dir.join("bin").join("surreal2.exe"),
        args: vec![
            "start".into(),
            "--user".into(),
            "root".into(),
            "--pass".into(),
            "root".into(),
            format!("rocksdb:{}", db.display()),
        ],
        env: vec![],
    };

    let api = SidecarSpec {
        name: "open-notebook API".into(),
        program: PathBuf::from("uv"),
        args: vec![
            "run".into(),
            "--directory".into(),
            onb.to_string_lossy().into_owned(),
            "--env-file".into(),
            env_file.to_string_lossy().into_owned(),
            "python".into(),
            "run_api.py".into(),
        ],
        env: vec![],
    };

    let worker = SidecarSpec {
        name: "open-notebook worker".into(),
        program: PathBuf::from("uv"),
        args: vec![
            "run".into(),
            "--directory".into(),
            onb.to_string_lossy().into_owned(),
            "--env-file".into(),
            env_file.to_string_lossy().into_owned(),
            "surreal-commands-worker".into(),
            "--import-modules".into(),
            "commands".into(),
        ],
        env: vec![
            ("PYTHONUTF8".into(), "1".into()),
            ("PYTHONIOENCODING".into(), "utf-8".into()),
        ],
    };

    // StudyVault's LSAT domain backend — the frozen PyInstaller sidecar built
    // by scripts/build-lsat-binary.mjs into <dir>/lsat-backend/. Unlike the
    // open-notebook specs (which shell through `uv` against the dev `spike/`
    // checkout), this runs the self-contained binary directly, so it works in
    // a packaged install with no system Python. Binds 127.0.0.1:8100; the
    // backend resolves its SQLite bank under the OS app-data dir by default
    // (LSATLAB_DATA_DIR can override). PYTHONUTF8/IOENCODING keep the frozen
    // process's stdio safe on the Windows console.
    let lsat = SidecarSpec {
        name: "LSAT backend".into(),
        program: dir.join("lsat-backend").join("lsatlab-backend.exe"),
        args: vec![
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            "8100".into(),
        ],
        env: vec![
            ("LSATLAB_PORT".into(), "8100".into()),
            ("PYTHONUTF8".into(), "1".into()),
            ("PYTHONIOENCODING".into(), "utf-8".into()),
        ],
    };

    vec![surreal, api, worker, lsat]
}

/// Iterate the given launcher over `build_sidecar_specs(dir)`, logging
/// successes and failures the same way the prior inline supervisor did.
/// Returns the spawned children so the Tauri runtime can kill them on exit.
fn spawn_sidecars_with<L: SidecarLauncher>(launcher: &L, dir: &Path) -> Vec<Child> {
    let mut kids = Vec::new();
    for spec in build_sidecar_specs(dir) {
        match launcher.launch(&spec) {
            Ok(c) => {
                log::info!("sidecar: {} started (pid {})", spec.name, c.id());
                kids.push(c);
            }
            Err(e) => log::error!("sidecar: {} failed to start: {e}", spec.name),
        }
    }
    kids
}

fn spawn_sidecars() -> Vec<Child> {
    let dir = services_dir();
    spawn_sidecars_with(&ProcessLauncher, &dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use tempfile::tempdir;

    // ---- pathdiff_to_string ----

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

    // ---- cfa_list_pdfs ----

    #[test]
    fn list_pdfs_errors_for_missing_directory() {
        let result = cfa_list_pdfs("Z:/quantvault-does-not-exist-xyzzy".into());
        assert!(result.is_err());
        let message = result.unwrap_err();
        assert!(message.contains("Not a directory"));
    }

    #[test]
    fn list_pdfs_walks_recursively_and_filters_to_pdfs() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("a.pdf"), b"%PDF-1.4 stub").unwrap();
        fs::write(root.join("notes.txt"), b"ignore me").unwrap();
        fs::write(root.join("nested/b.pdf"), b"%PDF-1.4 stub b").unwrap();

        let entries = cfa_list_pdfs(root.to_string_lossy().to_string()).expect("walk");
        let names: Vec<_> = entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"a.pdf".to_string()));
        assert!(names.contains(&"b.pdf".to_string()));
        assert_eq!(entries.len(), 2);
        let nested = entries.iter().find(|e| e.name == "b.pdf").unwrap();
        assert_eq!(nested.relative, "nested/b.pdf");
    }

    #[test]
    fn list_pdfs_ignores_non_pdf_extensions_case_insensitively() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        fs::write(root.join("real.pdf"), b"pdf").unwrap();
        fs::write(root.join("UPPER.PDF"), b"pdf").unwrap();
        fs::write(root.join("decoy.pdf.txt"), b"nope").unwrap();
        fs::write(root.join("README.md"), b"nope").unwrap();

        let entries = cfa_list_pdfs(root.to_string_lossy().to_string()).expect("walk");
        let names: std::collections::HashSet<_> =
            entries.into_iter().map(|e| e.name).collect();
        assert!(names.contains("real.pdf"));
        assert!(names.contains("UPPER.PDF"));
        assert!(!names.contains("decoy.pdf.txt"));
        assert!(!names.contains("README.md"));
    }

    #[test]
    fn list_pdfs_recurses_more_than_one_level_deep() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        let deep = root.join("level1").join("level2");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.pdf"), b"pdf").unwrap();

        let entries = cfa_list_pdfs(root.to_string_lossy().to_string()).expect("walk");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative, "level1/level2/deep.pdf");
    }

    // ---- cfa_read_pdf_bytes ----

    #[test]
    fn read_pdf_bytes_refuses_non_pdf_paths() {
        let result = cfa_read_pdf_bytes_impl("/tmp/not-a-pdf.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("non-PDF"));
    }

    #[test]
    fn read_pdf_bytes_returns_bytes_verbatim_for_existing_pdf() {
        let tmp = tempdir().expect("tempdir");
        let pdf = tmp.path().join("doc.pdf");
        let payload: &[u8] = b"%PDF-1.4\n%payload bytes\xDE\xAD\xBE\xEF";
        fs::write(&pdf, payload).unwrap();

        let got = cfa_read_pdf_bytes_impl(pdf.to_str().unwrap()).expect("read");
        assert_eq!(got, payload);
    }

    #[test]
    fn read_pdf_bytes_errors_for_missing_path() {
        let tmp = tempdir().expect("tempdir");
        let ghost = tmp.path().join("ghost.pdf");
        let err = cfa_read_pdf_bytes_impl(ghost.to_str().unwrap()).unwrap_err();
        assert!(err.contains("does not exist"), "unexpected error: {err}");
    }

    #[test]
    fn read_pdf_bytes_errors_for_directory_path() {
        let tmp = tempdir().expect("tempdir");
        let dir_with_pdf_ext = tmp.path().join("folder.pdf");
        fs::create_dir(&dir_with_pdf_ext).unwrap();
        let err = cfa_read_pdf_bytes_impl(dir_with_pdf_ext.to_str().unwrap()).unwrap_err();
        assert!(err.contains("Not a regular file"), "unexpected error: {err}");
    }

    // ---- pick_folder_recv ----

    #[test]
    fn pick_folder_recv_returns_path_when_dialog_resolved() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(Some("C:/picked".to_string())).unwrap();
        let got = pick_folder_recv(rx).expect("recv");
        assert_eq!(got.as_deref(), Some("C:/picked"));
    }

    #[test]
    fn pick_folder_recv_returns_none_when_dialog_cancelled() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(None).unwrap();
        let got = pick_folder_recv(rx).expect("recv");
        assert!(got.is_none());
    }

    #[test]
    fn pick_folder_recv_errors_when_channel_closed() {
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        drop(tx);
        let err = pick_folder_recv(rx).unwrap_err();
        assert!(err.contains("channel error"), "unexpected: {err}");
    }

    // ---- services_dir_search ----

    #[test]
    fn services_dir_search_honors_env_override_when_present() {
        let tmp = tempdir().expect("tempdir");
        let override_dir = tmp.path().join("override");
        fs::create_dir_all(override_dir.join("bin")).unwrap();
        let cwd = tmp.path().join("cwd-no-spike");
        let exe = tmp.path().join("exe-no-resources");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&exe).unwrap();

        let got = services_dir_search(Some(&override_dir), &cwd, &exe);
        assert_eq!(got.as_deref(), Some(override_dir.as_path()));
    }

    #[test]
    fn services_dir_search_honors_env_override_even_when_missing() {
        // Operators sometimes set the override before scaffolding the dir; we
        // respect explicit intent so log lines point at the configured path.
        let tmp = tempdir().expect("tempdir");
        let override_dir = tmp.path().join("not-yet-created");
        let cwd = tmp.path();
        let exe = tmp.path();

        let got = services_dir_search(Some(&override_dir), cwd, exe);
        assert_eq!(got.as_deref(), Some(override_dir.as_path()));
    }

    #[test]
    fn services_dir_search_falls_back_to_spike_under_cwd() {
        let tmp = tempdir().expect("tempdir");
        let cwd = tmp.path().join("workdir");
        let spike = cwd.join("spike");
        fs::create_dir_all(spike.join("bin")).unwrap();
        let exe = tmp.path().join("exe");
        fs::create_dir_all(&exe).unwrap();

        let got = services_dir_search(None, &cwd, &exe).expect("found");
        assert_eq!(got, spike);
    }

    #[test]
    fn services_dir_search_falls_back_to_spike_one_level_up() {
        let tmp = tempdir().expect("tempdir");
        let parent = tmp.path().join("parent");
        let spike = parent.join("spike");
        fs::create_dir_all(spike.join("open-notebook")).unwrap();
        let cwd = parent.join("src-tauri");
        fs::create_dir_all(&cwd).unwrap();
        let exe = tmp.path().join("exe");
        fs::create_dir_all(&exe).unwrap();

        let got = services_dir_search(None, &cwd, &exe).expect("found");
        // Canonicalize both sides to compare the "../spike" candidate cleanly
        // — the function returns the unresolved join path on purpose.
        let got = fs::canonicalize(&got).unwrap();
        let want = fs::canonicalize(&spike).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn services_dir_search_falls_back_to_exe_resources_services() {
        let tmp = tempdir().expect("tempdir");
        let cwd = tmp.path().join("workdir-empty");
        fs::create_dir_all(&cwd).unwrap();
        let exe = tmp.path().join("exe");
        let services = exe.join("resources").join("services");
        fs::create_dir_all(services.join("bin")).unwrap();

        let got = services_dir_search(None, &cwd, &exe).expect("found");
        assert_eq!(got, services);
    }

    #[test]
    fn services_dir_search_recognizes_lsat_backend_only_layout() {
        // A packaged install may carry only the LSAT sidecar (no bin/ or
        // open-notebook/). The lsat-backend/ subdir alone must pin the layout.
        let tmp = tempdir().expect("tempdir");
        let cwd = tmp.path().join("workdir-empty");
        fs::create_dir_all(&cwd).unwrap();
        let exe = tmp.path().join("exe");
        let services = exe.join("resources").join("services");
        fs::create_dir_all(services.join("lsat-backend")).unwrap();

        let got = services_dir_search(None, &cwd, &exe).expect("found");
        assert_eq!(got, services);
    }

    #[test]
    fn services_dir_search_falls_back_to_macos_resources_layout() {
        let tmp = tempdir().expect("tempdir");
        let cwd = tmp.path().join("workdir-empty");
        fs::create_dir_all(&cwd).unwrap();
        let exe = tmp.path().join("MyApp.app").join("Contents").join("MacOS");
        fs::create_dir_all(&exe).unwrap();
        // macOS layout: exe at .app/Contents/MacOS, resources at
        // .app/Contents/Resources, so `exe_dir/../Resources/services` resolves
        // into the bundle's resource directory.
        let macos_services = exe.join("..").join("Resources").join("services");
        fs::create_dir_all(macos_services.join("open-notebook")).unwrap();

        let got = services_dir_search(None, &cwd, &exe).expect("found");
        let got = fs::canonicalize(&got).unwrap();
        let want = fs::canonicalize(macos_services).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn services_dir_search_returns_none_when_nothing_exists() {
        let tmp = tempdir().expect("tempdir");
        let cwd = tmp.path().join("empty-cwd");
        let exe = tmp.path().join("empty-exe");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&exe).unwrap();

        let got = services_dir_search(None, &cwd, &exe);
        assert!(got.is_none(), "expected None, got {got:?}");
    }

    // ---- is_port_listening ----

    #[test]
    fn is_port_listening_returns_false_for_unbound_port() {
        // Port 0 means "let the OS pick" on bind, but as a destination it's
        // never a listening socket. We use it as an unambiguously-not-up
        // probe target.
        assert!(!is_port_listening("127.0.0.1", 0, 100));
    }

    #[test]
    fn is_port_listening_returns_true_for_bound_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        // Keep `listener` alive for the probe.
        assert!(is_port_listening("127.0.0.1", port, 500));
        drop(listener);
    }

    #[test]
    fn is_port_listening_returns_false_for_unresolvable_host() {
        // Empty host fails to_socket_addrs; the helper swallows that as a
        // "not listening" signal rather than panicking.
        assert!(!is_port_listening("", 80, 50));
    }

    // ---- supervisor (build_sidecar_specs + spawn_sidecars_with) ----

    #[test]
    fn build_sidecar_specs_pins_program_paths_and_order() {
        let dir = PathBuf::from("C:/qv/services");
        let specs = build_sidecar_specs(&dir);

        assert_eq!(specs.len(), 4);
        assert_eq!(specs[0].name, "SurrealDB");
        assert_eq!(specs[1].name, "open-notebook API");
        assert_eq!(specs[2].name, "open-notebook worker");
        assert_eq!(specs[3].name, "LSAT backend");

        // SurrealDB binary lives under <dir>/bin/surreal2.exe.
        assert_eq!(specs[0].program, dir.join("bin").join("surreal2.exe"));
        // The open-notebook pair shells through `uv` on PATH.
        assert_eq!(specs[1].program, PathBuf::from("uv"));
        assert_eq!(specs[2].program, PathBuf::from("uv"));
        // The LSAT backend runs its frozen binary directly from <dir>/lsat-backend.
        assert_eq!(
            specs[3].program,
            dir.join("lsat-backend").join("lsatlab-backend.exe")
        );
        assert!(specs[3].args.iter().any(|a| a == "--port"));
        assert!(specs[3].args.iter().any(|a| a == "8100"));
        assert!(specs[3]
            .env
            .iter()
            .any(|(k, v)| k == "LSATLAB_PORT" && v == "8100"));
    }

    #[test]
    fn build_sidecar_specs_passes_credentials_and_db_path() {
        let dir = PathBuf::from("C:/qv/services");
        let specs = build_sidecar_specs(&dir);
        let surreal_args = &specs[0].args;
        assert!(surreal_args.iter().any(|a| a == "start"));
        assert!(surreal_args.iter().any(|a| a == "--user"));
        assert!(surreal_args.iter().any(|a| a == "root"));
        let db_arg = surreal_args.last().expect("rocksdb arg");
        assert!(db_arg.starts_with("rocksdb:"));
        assert!(db_arg.contains("surreal_data"));
    }

    #[test]
    fn build_sidecar_specs_worker_sets_utf8_env() {
        let dir = PathBuf::from("C:/qv/services");
        let specs = build_sidecar_specs(&dir);
        let worker_env = &specs[2].env;
        let utf8 = worker_env
            .iter()
            .find(|(k, _)| k == "PYTHONUTF8")
            .expect("PYTHONUTF8 set");
        assert_eq!(utf8.1, "1");
        let enc = worker_env
            .iter()
            .find(|(k, _)| k == "PYTHONIOENCODING")
            .expect("PYTHONIOENCODING set");
        assert_eq!(enc.1, "utf-8");
        // Other sidecars don't carry env overrides.
        assert!(specs[0].env.is_empty());
        assert!(specs[1].env.is_empty());
    }

    /// Mock launcher: records every spec it was asked to launch, decides
    /// success/failure based on the `fail_for` set. Never spawns a real child;
    /// for the success path we synthesize a `Child` by launching a trivially
    /// short-lived OS command and immediately reaping it.
    struct MockLauncher {
        calls: RefCell<Vec<SidecarSpec>>,
        fail_for: Vec<String>,
    }

    impl MockLauncher {
        fn new(fail_for: Vec<&str>) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                fail_for: fail_for.into_iter().map(String::from).collect(),
            }
        }
    }

    impl SidecarLauncher for MockLauncher {
        fn launch(&self, spec: &SidecarSpec) -> Result<Child, String> {
            self.calls.borrow_mut().push(spec.clone());
            if self.fail_for.iter().any(|n| n == &spec.name) {
                return Err(format!("mock: refusing to start {}", spec.name));
            }
            // Spawn a trivial real child so we exercise the `Child` plumbing
            // without depending on `surreal.exe`/`uv`. Use the OS's built-in
            // help/version invocation so it's available on every CI runner.
            #[cfg(windows)]
            let mut cmd = {
                let mut c = Command::new("cmd");
                c.args(["/C", "exit"]);
                c
            };
            #[cfg(not(windows))]
            let mut cmd = {
                let mut c = Command::new("true");
                c
            };
            cmd.spawn().map_err(|e| e.to_string())
        }
    }

    #[test]
    fn spawn_sidecars_with_invokes_launcher_for_every_spec() {
        let launcher = MockLauncher::new(vec![]);
        let mut kids = spawn_sidecars_with(&launcher, Path::new("C:/qv/services"));
        let calls = launcher.calls.borrow();
        let names: Vec<_> = calls.iter().map(|s| s.name.clone()).collect();
        assert_eq!(
            names,
            vec![
                "SurrealDB",
                "open-notebook API",
                "open-notebook worker",
                "LSAT backend"
            ]
        );
        assert_eq!(kids.len(), 4);
        // Lifecycle: reap the synthesized mock children so they don't linger.
        for c in kids.iter_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    #[test]
    fn spawn_sidecars_with_skips_failed_sidecars_but_continues() {
        let launcher = MockLauncher::new(vec!["SurrealDB"]);
        let mut kids = spawn_sidecars_with(&launcher, Path::new("C:/qv/services"));
        // All four specs were attempted, even though SurrealDB returned Err.
        assert_eq!(launcher.calls.borrow().len(), 4);
        // Only the three successful launches yield Child handles.
        assert_eq!(kids.len(), 3);
        for c in kids.iter_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
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
