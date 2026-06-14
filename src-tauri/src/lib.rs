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
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;

/// One supervised sidecar: its declarative spec (retained so a crashed process
/// can be respawned from the same recipe) paired with the live `Child` handle.
struct SupervisedSidecar {
    spec: SidecarSpec,
    child: Child,
}

/// Managed supervisor state. Holds every sidecar we launched alongside the spec
/// that produced it, so the health-poll task (BA1) can respawn a crashed one
/// without re-deriving the recipe. Behind a `Mutex` because the background poll
/// task and the Tauri exit handler both touch it.
#[derive(Default)]
struct Sidecars(Mutex<Vec<SupervisedSidecar>>);

/// Max log lines retained per sidecar in the in-memory ring buffer. Once a
/// sidecar's buffer reaches this length, each new line evicts the oldest, so
/// memory stays bounded no matter how chatty (or long-lived) a sidecar is.
const LOG_RING_CAPACITY: usize = 500;

/// In-memory rolling log buffer (BA8). One bounded `VecDeque<String>` per
/// sidecar name, holding the most recent `LOG_RING_CAPACITY` lines captured
/// from that child's stdout + stderr. Wrapped in an `Arc<Mutex<..>>` so the
/// per-stream reader threads (one stdout + one stderr thread per child, plus
/// fresh ones on every respawn) can all append concurrently, and so the
/// `get_sidecar_logs` Tauri command can snapshot a buffer for the UI.
///
/// Managed as Tauri state. `Arc` (not just a bare `Mutex`) because the reader
/// threads outlive any single borrow of the managed state: they hold their own
/// clone of the handle for the lifetime of the child.
#[derive(Default, Clone)]
struct SidecarLogs(Arc<Mutex<HashMap<String, VecDeque<String>>>>);

impl SidecarLogs {
    /// Append one captured line to `name`'s ring buffer, evicting the oldest
    /// line once the buffer is at capacity. Lock poisoning is recovered from
    /// rather than panicking — a wedged reader thread must not be able to take
    /// down sibling capture or the log command.
    fn push_line(&self, name: &str, line: String) {
        let mut guard = match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let buf = guard.entry(name.to_string()).or_default();
        if buf.len() >= LOG_RING_CAPACITY {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    /// Snapshot the current buffer for `name` as a `Vec<String>` (oldest →
    /// newest). Returns an empty vec for a sidecar we've captured nothing from.
    fn snapshot(&self, name: &str) -> Vec<String> {
        let guard = match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .get(name)
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// Take the piped stdout/stderr off a freshly-spawned child and stream each
/// line into the shared ring buffer under `name`. Spawns one detached reader
/// thread per stream; each reads to EOF (child exit / stream close) and then
/// ends on its own. A child launched without `Stdio::piped()` (e.g. the test
/// mock launcher) simply has `None` streams here, so this is a safe no-op for
/// those — capture only engages for the real `ProcessLauncher`.
///
/// Used by both the initial spawn (`spawn_sidecars_with`) and the BA1 respawn
/// path (`supervise_once`), so a respawned child re-attaches fresh capture.
fn attach_log_capture(name: &str, child: &mut Child, logs: &SidecarLogs) {
    if let Some(stdout) = child.stdout.take() {
        spawn_stream_reader(name.to_string(), stdout, logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_stream_reader(name.to_string(), stderr, logs.clone());
    }
}

/// Spawn a detached thread that reads `stream` line-by-line and appends each to
/// `logs` under `name`. Generic over the reader so a unit test can drive it
/// with an in-memory cursor instead of a real pipe. Lines that fail to decode
/// (I/O error mid-read) end the loop quietly — partial capture beats crashing.
fn spawn_stream_reader<R: std::io::Read + Send + 'static>(
    name: String,
    stream: R,
    logs: SidecarLogs,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            match line {
                Ok(text) => logs.push_line(&name, text),
                Err(_) => break,
            }
        }
    });
}

/// How often the background supervisor probes each sidecar's readiness port.
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(7);

/// Per-probe TCP connect timeout. Kept well under the poll interval so a slow
/// or wedged port never stalls the supervisor loop for a full cycle.
const HEALTH_PROBE_TIMEOUT_MS: u64 = 750;

/// Status snapshot for one supervised sidecar, returned by the
/// `get_sidecar_status` command so the UI can render a health panel.
#[derive(Serialize, Debug, PartialEq, Eq)]
struct SidecarStatus {
    name: String,
    /// Readiness port probed by the supervisor, or `None` for sidecars that
    /// expose no listening socket (e.g. the open-notebook worker).
    port: Option<u16>,
    /// `true` when the readiness port is accepting connections. Sidecars with
    /// no `port` report `true` as long as their process handle is retained
    /// (we have no socket to probe, so liveness is the best signal available).
    healthy: bool,
    /// OS process id of the live child, if one is currently tracked.
    pid: Option<u32>,
}

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
    /// Local TCP port the supervisor probes to decide if this sidecar is up
    /// (SurrealDB 8000, open-notebook API 5055, LSAT backend 8100). `None` for
    /// processes that expose no listening socket — the worker, which the
    /// supervisor can only watch by process liveness, not by port.
    ready_port: Option<u16>,
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
        // BA8: capture the child's stdout + stderr through pipes so the
        // supervisor can stream each into the in-memory log ring buffer. The
        // caller (`spawn_sidecars_with` / `supervise_once`) takes these handles
        // off the returned child via `attach_log_capture`; if it didn't, the
        // pipes would fill and eventually block the child — so piping here is
        // always paired with a reader on the spawn path.
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.spawn().map_err(|e| e.to_string())
    }
}

/// Append the platform executable suffix to a bare binary stem (`.exe` on
/// Windows, nothing elsewhere). Keeps the sidecar specs portable — the build
/// scripts already emit per-platform names; this matches them at launch.
fn exe(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Build the sidecar specs the supervisor manages, parameterized by the
/// resolved services directory. Pure — does no I/O — so tests can assert that
/// the program paths, args, and env match what we expect for a given `dir`.
fn build_sidecar_specs(dir: &Path) -> Vec<SidecarSpec> {
    let onb = dir.join("open-notebook");
    let env_file = onb.join(".env");
    let db = dir.join("surreal_data").join("db");

    let surreal = SidecarSpec {
        name: "SurrealDB".into(),
        program: dir.join("bin").join(exe("surreal2")),
        args: vec![
            "start".into(),
            "--user".into(),
            "root".into(),
            "--pass".into(),
            "root".into(),
            format!("rocksdb:{}", db.display()),
        ],
        env: vec![],
        // SurrealDB defaults to binding 127.0.0.1:8000.
        ready_port: Some(8000),
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
        // open-notebook's FastAPI app listens on 127.0.0.1:5055.
        ready_port: Some(5055),
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
        // The worker is a background queue consumer with no listening socket;
        // the supervisor can only watch it by process liveness.
        ready_port: None,
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
        program: dir.join("lsat-backend").join(exe("lsatlab-backend")),
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
        // The frozen LSAT backend binds 127.0.0.1:8100.
        ready_port: Some(8100),
    };

    vec![surreal, api, worker, lsat]
}

/// Iterate the given launcher over `build_sidecar_specs(dir)`, logging
/// successes and failures the same way the prior inline supervisor did.
/// Returns each spawned child paired with the spec that produced it, so the
/// Tauri runtime can kill them on exit and the health-poll task can respawn a
/// crashed one from its retained recipe.
///
/// BA8: each successfully-launched child has its stdout + stderr attached to
/// the shared `logs` ring buffer before being retained, so the log viewer sees
/// output from process start.
fn spawn_sidecars_with<L: SidecarLauncher>(
    launcher: &L,
    dir: &Path,
    logs: &SidecarLogs,
) -> Vec<SupervisedSidecar> {
    let mut kids = Vec::new();
    for spec in build_sidecar_specs(dir) {
        match launcher.launch(&spec) {
            Ok(mut child) => {
                log::info!("sidecar: {} started (pid {})", spec.name, child.id());
                attach_log_capture(&spec.name, &mut child, logs);
                kids.push(SupervisedSidecar { spec, child });
            }
            Err(e) => log::error!("sidecar: {} failed to start: {e}", spec.name),
        }
    }
    kids
}

fn spawn_sidecars(logs: &SidecarLogs) -> Vec<SupervisedSidecar> {
    let dir = services_dir();
    spawn_sidecars_with(&ProcessLauncher, &dir, logs)
}

/// Probe one sidecar's readiness port. Sidecars with no `ready_port` (the
/// worker) have no socket to check, so we report them healthy here — the
/// supervisor falls back to process-liveness for those. Extracted as a pure
/// helper so the poll loop reads clearly and stays unit-testable.
fn probe_sidecar_healthy(spec: &SidecarSpec) -> bool {
    match spec.ready_port {
        Some(port) => is_port_listening("127.0.0.1", port, HEALTH_PROBE_TIMEOUT_MS),
        None => true,
    }
}

/// One supervision sweep over the managed sidecars: probe each one's readiness
/// port and respawn any found down using its retained spec. Returns the names
/// that were respawned (for logging / tests). Pulled out of the async loop so
/// it can be driven directly in a unit test with a mock launcher.
///
/// BA8: a respawned child gets fresh log capture attached (its stdout/stderr
/// pipes are new), so the ring buffer keeps streaming across a restart.
fn supervise_once<L: SidecarLauncher>(
    launcher: &L,
    sidecars: &Mutex<Vec<SupervisedSidecar>>,
    logs: &SidecarLogs,
) -> Vec<String> {
    let mut respawned = Vec::new();
    let mut guard = match sidecars.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for slot in guard.iter_mut() {
        // A sidecar that exposes a readiness port is "down" when that port is
        // not accepting connections. Port-less sidecars (the worker) are only
        // probed for process liveness via `try_wait`.
        let port_down = slot
            .spec
            .ready_port
            .map(|port| !is_port_listening("127.0.0.1", port, HEALTH_PROBE_TIMEOUT_MS))
            .unwrap_or(false);
        let process_exited = matches!(slot.child.try_wait(), Ok(Some(_)));

        if port_down || process_exited {
            let name = slot.spec.name.clone();
            log::warn!(
                "sidecar: {name} appears down (port_down={port_down}, exited={process_exited}); respawning"
            );
            // Reap the old handle so we don't leak a zombie on Unix.
            let _ = slot.child.kill();
            let _ = slot.child.wait();
            match launcher.launch(&slot.spec) {
                Ok(mut child) => {
                    log::info!("sidecar: {name} respawned (pid {})", child.id());
                    // Re-attach capture: the new child has fresh stdout/stderr
                    // pipes, so its output keeps flowing into the ring buffer.
                    attach_log_capture(&name, &mut child, logs);
                    slot.child = child;
                    respawned.push(name);
                }
                Err(e) => log::error!("sidecar: {name} respawn failed: {e}"),
            }
        }
    }
    respawned
}

/// Background supervisor: every `HEALTH_POLL_INTERVAL`, sweep the managed
/// sidecars and respawn any that have fallen over. Spawned onto Tauri's async
/// runtime during setup; runs for the lifetime of the app.
///
/// Each cycle's wait + probe is handed to `spawn_blocking` so the (blocking)
/// `sleep` and synchronous TCP/`try_wait` probes never park an async executor
/// worker. This keeps the supervisor dependency-free — no direct `tokio` timer
/// dep — while still living on Tauri's runtime as required.
fn spawn_health_supervisor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let app = app.clone();
            let join = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(HEALTH_POLL_INTERVAL);
                if let Some(state) = app.try_state::<Sidecars>() {
                    // BA8: hand the supervisor the shared log store so a
                    // respawned child re-attaches capture. The store is always
                    // managed alongside `Sidecars`; default to an empty one if
                    // somehow absent rather than skip the sweep.
                    let logs = app
                        .try_state::<SidecarLogs>()
                        .map(|s| s.inner().clone())
                        .unwrap_or_default();
                    supervise_once(&ProcessLauncher, &state.0, &logs);
                }
            });
            // If the blocking task itself fails to join (runtime shutting down),
            // stop the loop rather than spin.
            if join.await.is_err() {
                break;
            }
        }
    });
}

/// Tauri command backing the UI health panel. Probes each managed sidecar's
/// readiness port and reports name / port / healthy / pid. Port-less sidecars
/// report healthy as long as their process handle is still tracked.
#[tauri::command]
fn get_sidecar_status(state: tauri::State<'_, Sidecars>) -> Vec<SidecarStatus> {
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard
        .iter()
        .map(|slot| SidecarStatus {
            name: slot.spec.name.clone(),
            port: slot.spec.ready_port,
            healthy: probe_sidecar_healthy(&slot.spec),
            pid: Some(slot.child.id()),
        })
        .collect()
}

/// Tauri command backing the UI log viewer (BA8). Returns the most recent
/// captured stdout/stderr lines (up to `LOG_RING_CAPACITY`) for the named
/// sidecar, oldest first. An unknown name — or a sidecar that hasn't emitted
/// anything yet — yields an empty vec rather than an error, so the viewer can
/// poll any name without special-casing.
#[tauri::command]
fn get_sidecar_logs(name: String, logs: tauri::State<'_, SidecarLogs>) -> Vec<String> {
    logs.snapshot(&name)
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

        // SurrealDB binary lives under <dir>/bin/surreal2(.exe).
        assert_eq!(specs[0].program, dir.join("bin").join(exe("surreal2")));
        // The open-notebook pair shells through `uv` on PATH.
        assert_eq!(specs[1].program, PathBuf::from("uv"));
        assert_eq!(specs[2].program, PathBuf::from("uv"));
        // The LSAT backend runs its frozen binary directly from <dir>/lsat-backend.
        assert_eq!(
            specs[3].program,
            dir.join("lsat-backend").join(exe("lsatlab-backend"))
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
        let logs = SidecarLogs::default();
        let mut kids = spawn_sidecars_with(&launcher, Path::new("C:/qv/services"), &logs);
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
        // Each slot retains the spec that produced it (so a crash can be
        // respawned), paired with the live child.
        assert_eq!(kids[0].spec.name, "SurrealDB");
        // Lifecycle: reap the synthesized mock children so they don't linger.
        for s in kids.iter_mut() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    #[test]
    fn spawn_sidecars_with_skips_failed_sidecars_but_continues() {
        let launcher = MockLauncher::new(vec!["SurrealDB"]);
        let logs = SidecarLogs::default();
        let mut kids = spawn_sidecars_with(&launcher, Path::new("C:/qv/services"), &logs);
        // All four specs were attempted, even though SurrealDB returned Err.
        assert_eq!(launcher.calls.borrow().len(), 4);
        // Only the three successful launches yield Child handles.
        assert_eq!(kids.len(), 3);
        for s in kids.iter_mut() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    // ---- health supervisor (probe_sidecar_healthy + supervise_once) ----

    #[test]
    fn probe_sidecar_healthy_reports_portless_sidecar_as_healthy() {
        // The worker has no readiness port; with no socket to probe we treat it
        // as healthy at the probe level (liveness is checked separately).
        let worker = SidecarSpec {
            name: "open-notebook worker".into(),
            program: PathBuf::from("uv"),
            args: vec![],
            env: vec![],
            ready_port: None,
        };
        assert!(probe_sidecar_healthy(&worker));
    }

    #[test]
    fn probe_sidecar_healthy_follows_the_port_state() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let up_port = listener.local_addr().unwrap().port();
        let up = SidecarSpec {
            name: "up".into(),
            program: PathBuf::from("x"),
            args: vec![],
            env: vec![],
            ready_port: Some(up_port),
        };
        assert!(probe_sidecar_healthy(&up), "bound port should read healthy");
        drop(listener);

        // Port 0 is never a listening destination — unambiguously down.
        let down = SidecarSpec {
            name: "down".into(),
            program: PathBuf::from("x"),
            args: vec![],
            env: vec![],
            ready_port: Some(0),
        };
        assert!(!probe_sidecar_healthy(&down), "port 0 should read down");
    }

    #[test]
    fn supervise_once_respawns_a_sidecar_whose_process_has_exited() {
        // Build one supervised slot around a spec with no readiness port (so
        // the only down-signal is process exit) wrapping an already-finished
        // child. `supervise_once` must detect the exit and relaunch from the
        // retained spec via the mock launcher.
        let launcher = MockLauncher::new(vec![]);
        let spec = SidecarSpec {
            name: "ephemeral".into(),
            program: PathBuf::from("x"),
            args: vec![],
            env: vec![],
            ready_port: None,
        };
        // Spawn a trivial child and let it finish so try_wait() reports exited.
        let mut child = launcher.launch(&spec).expect("initial launch");
        let _ = child.wait();

        let state: Mutex<Vec<SupervisedSidecar>> =
            Mutex::new(vec![SupervisedSidecar { spec, child }]);

        let logs = SidecarLogs::default();
        let respawned = supervise_once(&launcher, &state, &logs);
        assert_eq!(respawned, vec!["ephemeral".to_string()]);
        // The launcher was called once more for the respawn (initial launch
        // above used the same mock, so total calls == 2).
        assert_eq!(launcher.calls.borrow().len(), 2);

        // Clean up the respawned child.
        let mut guard = state.lock().unwrap();
        for slot in guard.iter_mut() {
            let _ = slot.child.kill();
            let _ = slot.child.wait();
        }
    }

    #[test]
    fn supervise_once_leaves_a_healthy_portless_sidecar_alone() {
        // A long-lived port-less child that is still running must not be
        // respawned. We use a child that blocks so try_wait() reports running.
        let launcher = MockLauncher::new(vec![]);
        let spec = SidecarSpec {
            name: "long-lived".into(),
            program: PathBuf::from("x"),
            args: vec![],
            env: vec![],
            ready_port: None,
        };
        let child = spawn_long_lived_child();
        let state: Mutex<Vec<SupervisedSidecar>> =
            Mutex::new(vec![SupervisedSidecar { spec, child }]);

        let logs = SidecarLogs::default();
        let respawned = supervise_once(&launcher, &state, &logs);
        assert!(
            respawned.is_empty(),
            "a running port-less sidecar should not be respawned"
        );
        // No respawn launch happened.
        assert_eq!(launcher.calls.borrow().len(), 0);

        let mut guard = state.lock().unwrap();
        for slot in guard.iter_mut() {
            let _ = slot.child.kill();
            let _ = slot.child.wait();
        }
    }

    /// Spawn a child that stays alive (so `try_wait` reports "still running")
    /// until killed. Cross-platform: a sleep on each OS.
    fn spawn_long_lived_child() -> Child {
        #[cfg(windows)]
        {
            // `ping` with a count loops for a few seconds without extra deps.
            Command::new("cmd")
                .args(["/C", "ping", "127.0.0.1", "-n", "30"])
                .spawn()
                .expect("spawn long-lived child")
        }
        #[cfg(not(windows))]
        {
            Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn long-lived child")
        }
    }

    // ---- get_sidecar_status mapping (via probe helper) ----

    #[test]
    fn sidecar_status_serializes_expected_shape() {
        // Guards the JSON contract the UI consumes: name/port/healthy/pid.
        let status = SidecarStatus {
            name: "SurrealDB".into(),
            port: Some(8000),
            healthy: false,
            pid: Some(1234),
        };
        let json = serde_json::to_value(&status).expect("serialize");
        assert_eq!(json["name"], "SurrealDB");
        assert_eq!(json["port"], 8000);
        assert_eq!(json["healthy"], false);
        assert_eq!(json["pid"], 1234);
    }

    #[test]
    fn build_sidecar_specs_pins_readiness_ports() {
        let specs = build_sidecar_specs(Path::new("C:/qv/services"));
        assert_eq!(specs[0].ready_port, Some(8000)); // SurrealDB
        assert_eq!(specs[1].ready_port, Some(5055)); // open-notebook API
        assert_eq!(specs[2].ready_port, None); // worker (no socket)
        assert_eq!(specs[3].ready_port, Some(8100)); // LSAT backend
    }

    // ---- SidecarLogs ring buffer (BA8) ----

    #[test]
    fn sidecar_logs_snapshot_is_empty_for_unknown_name() {
        let logs = SidecarLogs::default();
        assert!(logs.snapshot("never-seen").is_empty());
    }

    #[test]
    fn sidecar_logs_keeps_lines_in_order_and_keyed_by_name() {
        let logs = SidecarLogs::default();
        logs.push_line("SurrealDB", "starting".into());
        logs.push_line("SurrealDB", "listening on 8000".into());
        logs.push_line("LSAT backend", "boot".into());

        assert_eq!(
            logs.snapshot("SurrealDB"),
            vec!["starting".to_string(), "listening on 8000".to_string()]
        );
        // A second sidecar's buffer is independent.
        assert_eq!(logs.snapshot("LSAT backend"), vec!["boot".to_string()]);
    }

    #[test]
    fn sidecar_logs_evicts_oldest_past_capacity() {
        let logs = SidecarLogs::default();
        // Push one more than the cap; the very first line must be evicted while
        // the buffer length stays pinned at the capacity.
        for i in 0..(LOG_RING_CAPACITY + 1) {
            logs.push_line("worker", format!("line {i}"));
        }
        let snap = logs.snapshot("worker");
        assert_eq!(snap.len(), LOG_RING_CAPACITY);
        // Oldest ("line 0") evicted; window is now line 1 ..= line CAP.
        assert_eq!(snap.first().unwrap(), "line 1");
        assert_eq!(snap.last().unwrap(), &format!("line {LOG_RING_CAPACITY}"));
    }

    #[test]
    fn spawn_stream_reader_captures_lines_into_the_buffer() {
        use std::io::Cursor;
        let logs = SidecarLogs::default();
        // Drive the reader with an in-memory stream instead of a real pipe; the
        // reader thread reads to EOF then exits. Join via the snapshot once the
        // shared buffer reflects all three lines.
        let stream = Cursor::new(b"first\nsecond\nthird\n".to_vec());
        spawn_stream_reader("api".to_string(), stream, logs.clone());

        // The reader runs on its own thread; poll the snapshot briefly until it
        // has drained the cursor (bounded so a regression fails fast).
        let mut snap = logs.snapshot("api");
        for _ in 0..100 {
            if snap.len() == 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
            snap = logs.snapshot("api");
        }
        assert_eq!(
            snap,
            vec!["first".to_string(), "second".to_string(), "third".to_string()]
        );
    }

    #[test]
    fn get_sidecar_logs_command_returns_named_buffer() {
        // Exercises the command's pure path (snapshot lookup) without bringing
        // up a Tauri State wrapper — the command body is a thin forward.
        let logs = SidecarLogs::default();
        logs.push_line("SurrealDB", "hello".into());
        assert_eq!(logs.snapshot("SurrealDB"), vec!["hello".to_string()]);
        assert!(logs.snapshot("absent").is_empty());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            cfa_list_pdfs,
            cfa_pick_folder,
            cfa_read_pdf_bytes,
            get_sidecar_status,
            get_sidecar_logs
        ])
        .manage(Sidecars::default())
        .manage(SidecarLogs::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // BA8: capture sidecar stdout/stderr into the managed log ring
            // buffer from launch. The store is shared with the health
            // supervisor so respawned children re-attach capture.
            let logs = app
                .try_state::<SidecarLogs>()
                .map(|s| s.inner().clone())
                .unwrap_or_default();
            let kids = spawn_sidecars(&logs);
            if let Some(state) = app.try_state::<Sidecars>() {
                *state.0.lock().unwrap() = kids;
            }
            // BA1: start the background health supervisor that polls each
            // sidecar's readiness port and respawns any that fall over.
            spawn_health_supervisor(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building QuantVault desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Sidecars>() {
                    for mut supervised in state.0.lock().unwrap().drain(..) {
                        let _ = supervised.child.kill();
                        log::info!("sidecar: {} terminated on exit", supervised.spec.name);
                    }
                }
            }
        });
}
