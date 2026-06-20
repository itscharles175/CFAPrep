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

// DATA-7: app-data relocation guard. Detects an LSAT SQLite store orphaned at the
// OLD OS app-data dir after a bundle-id / app-data-dir change and decides whether
// the LSAT sidecar should read from the recovered store (set via LSATLAB_DATA_DIR).
mod relocation;

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

/// Optional sidecars that were SKIPPED at startup because their backing resource
/// was absent (OPS-5) — e.g. a RAG-less build that omitted `<dir>/open-notebook`.
/// Retained separately from the launched `Sidecars` so `get_sidecar_status` can
/// surface them to the UI (as optional + not-present) without ever spawning
/// them. Populated once by ordered startup; behind a `Mutex` for the same
/// shared-access reason as `Sidecars`.
#[derive(Default)]
struct SkippedSidecars(Mutex<Vec<SidecarSpec>>);

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
    /// Alias of `port`, named to match `SidecarSpec::ready_port` so the UI can
    /// label the readiness gate explicitly (BA2). Carries the same value as
    /// `port`; both are emitted so existing consumers of `port` keep working.
    ready_port: Option<u16>,
    /// `true` when the readiness port is accepting connections. Sidecars with
    /// no `port` report `true` as long as their process handle is retained
    /// (we have no socket to probe, so liveness is the best signal available).
    healthy: bool,
    /// Whether this sidecar's readiness gate is satisfied (BA2). For a sidecar
    /// with a readiness port, mirrors `healthy` (port listening). For a
    /// port-less sidecar (the worker) it reports `true` as long as the process
    /// handle is tracked — same liveness fallback as `healthy`. Surfaced as a
    /// distinct field so the UI can speak in "ready" terms for the readiness
    /// panel without conflating it with the health-poll signal.
    ready: bool,
    /// Names of sidecars that had to be ready before this one started (BA2), so
    /// the UI can render the dependency chain alongside each row. Empty for
    /// sidecars with no dependencies (SurrealDB, the LSAT backend).
    depends_on: Vec<String>,
    /// OS process id of the live child, if one is currently tracked. `None` for
    /// a skipped optional sidecar (OPS-5) — it was never launched.
    pid: Option<u32>,
    /// Whether this sidecar is OPTIONAL (OPS-5). Additive field so a host UI can
    /// distinguish a down REQUIRED sidecar (a real problem) from an absent
    /// OPTIONAL one (an expected RAG-less build). `false` for SurrealDB + the
    /// LSAT backend; `true` for the open-notebook API + worker.
    optional: bool,
    /// Whether this sidecar's backing resource is present on disk (OPS-5).
    /// Additive field. `false` only for an optional sidecar that was skipped
    /// because its resource was absent (e.g. a build without RAG) — the UI can
    /// key off `optional && !present` to render "RAG unavailable" rather than an
    /// error. Always `true` for launched sidecars and for resource-less ones.
    present: bool,
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
    // audit (LOW) — the dialog callback fires on another thread, so receiving on
    // the async executor would park a Tauri async worker for the whole modal
    // lifetime. Hand the blocking recv to spawn_blocking so the runtime stays free.
    tauri::async_runtime::spawn_blocking(move || pick_folder_recv(rx))
        .await
        .map_err(|e| format!("Folder picker task error: {e}"))?
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

/// Total wall-clock budget for waiting on a dependency's readiness port during
/// ordered startup (BA2). Capped so a dependency that never comes up degrades
/// the dependent rather than hanging app launch forever.
const READINESS_WAIT_BUDGET: Duration = Duration::from_secs(30);

/// Gap between readiness probes while waiting on a dependency port. Short enough
/// that a fast-booting dependency unblocks its dependent promptly, long enough
/// that the poll loop doesn't busy-spin.
const READINESS_POLL_GAP: Duration = Duration::from_millis(400);

/// Per-probe TCP connect timeout used while waiting on a dependency port. Kept
/// short so each attempt fails fast and the poll cadence stays close to
/// `READINESS_POLL_GAP` even when the port is refusing connections.
const READINESS_PROBE_TIMEOUT_MS: u64 = 500;

/// Block until `port` on `127.0.0.1` is accepting connections, or until the
/// bounded `READINESS_WAIT_BUDGET` elapses — whichever comes first (BA2).
/// Returns `true` once the port is listening, `false` if the budget ran out.
///
/// Logs progress so a slow dependency is visible in the sidecar log viewer, and
/// — crucially — never blocks forever: a dependency that never binds is reported
/// as not-ready and the caller proceeds in a degraded state rather than wedging
/// app startup. The `label` is the dependent waiting on the port, used only for
/// log context.
///
/// `clock` returns "now"; injected so a unit test can drive the timeout branch
/// deterministically without sleeping out a real 30s budget. Production callers
/// pass `Instant::now`.
fn wait_for_port_ready(
    label: &str,
    port: u16,
    budget: Duration,
    clock: impl Fn() -> std::time::Instant,
) -> bool {
    let start = clock();
    let mut attempts: u32 = 0;
    loop {
        if is_port_listening("127.0.0.1", port, READINESS_PROBE_TIMEOUT_MS) {
            log::info!(
                "sidecar: readiness for {label}: port {port} is up (after {attempts} probe(s))"
            );
            return true;
        }
        attempts += 1;
        if clock().duration_since(start) >= budget {
            log::warn!(
                "sidecar: readiness for {label}: port {port} not up after {budget:?} \
                 ({attempts} probe(s)); proceeding degraded"
            );
            return false;
        }
        log::info!(
            "sidecar: readiness for {label}: waiting for port {port} (probe {attempts})"
        );
        std::thread::sleep(READINESS_POLL_GAP);
    }
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
    /// Names of sidecars that must be confirmed listening on their readiness
    /// port BEFORE this one is spawned (BA2). The ordered startup walks the
    /// `build_sidecar_specs` vec and, for each dependency named here that has a
    /// readiness port, blocks on a bounded wait until that port accepts a
    /// connection. SurrealDB has no deps; open-notebook's API depends on
    /// SurrealDB; the worker depends on the API; the LSAT backend is
    /// independent. A dependency with no readiness port (or one that never came
    /// up) is logged and skipped so a wedged dependency can't hang startup.
    depends_on: Vec<String>,
    /// Whether this sidecar is OPTIONAL (OPS-5). An optional sidecar whose
    /// backing resource is absent — its `resource_path` doesn't exist on disk —
    /// is logged and SKIPPED at startup rather than launched, and the app
    /// degrades gracefully (e.g. RAG/notebook features unavailable) instead of
    /// surfacing a failed-to-start error. Required sidecars (`optional: false`,
    /// the LSAT backend + SurrealDB) gate as before and are always attempted.
    /// This is the build-time RAG-less story: when `ONB_GIT_URL` was unset the
    /// release omits the open-notebook resource, so its directory is missing and
    /// the optional open-notebook sidecars self-skip on a real install.
    optional: bool,
    /// Filesystem path whose existence determines whether this sidecar's backing
    /// resource is present (OPS-5). For the open-notebook API + worker this is
    /// the `<services_dir>/open-notebook` directory the build bundles only when
    /// RAG is included; for the worker it is the same directory. `None` means
    /// "no resource gate" — the sidecar is considered always-present (SurrealDB,
    /// whose binary path is checked by the launcher itself, and the LSAT backend,
    /// a required sidecar guaranteed present by the release CI gate). Only
    /// consulted for `optional` sidecars; required sidecars ignore it.
    resource_path: Option<PathBuf>,
}

impl SidecarSpec {
    /// Whether this sidecar's backing resource is present on disk (OPS-5). A
    /// spec with no `resource_path` is always considered present (nothing to
    /// gate on); otherwise the path must exist. Used by the ordered-startup
    /// skip decision for optional sidecars and surfaced in the status payload.
    fn resource_present(&self) -> bool {
        match &self.resource_path {
            Some(p) => p.exists(),
            None => true,
        }
    }
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
        // The storage layer — nothing else can connect until it's up.
        depends_on: vec![],
        // SurrealDB is the storage backbone the open-notebook stack rides on, so
        // it's launched whenever a services dir resolves; its binary presence is
        // checked by the launcher. Not gated as optional here.
        optional: false,
        resource_path: None,
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
        // The API connects to SurrealDB on boot — wait for :8000 first.
        depends_on: vec!["SurrealDB".into()],
        // OPS-5: open-notebook (RAG) is OPTIONAL. The release bundles its
        // resource only when ONB_GIT_URL was set at build time; a RAG-less
        // build omits `<dir>/open-notebook`, so the supervisor skips this
        // sidecar and RAG/notebook features are simply unavailable.
        optional: true,
        resource_path: Some(onb.clone()),
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
        // The worker drains the same SurrealDB-backed command queue the API
        // serves; gate it behind the API (which itself gates behind SurrealDB)
        // so the whole open-notebook stack comes up in order.
        depends_on: vec!["open-notebook API".into()],
        // OPS-5: the worker is half of the open-notebook (RAG) stack, so it's
        // optional and gated on the same `<dir>/open-notebook` resource as the
        // API. A RAG-less build skips both together.
        optional: true,
        resource_path: Some(onb.clone()),
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
        // Self-contained: its own SQLite bank, no SurrealDB dependency, so it
        // starts independently (and in parallel with the SurrealDB stack).
        depends_on: vec![],
        // OPS-5: the LSAT backend is the REQUIRED sidecar — its source is
        // committed and the release CI gate (`Verify required sidecars are
        // present`) fails the build if the frozen binary is missing. So it's
        // never optional and carries no resource gate here.
        optional: false,
        resource_path: None,
    };

    vec![surreal, api, worker, lsat]
}

/// Outcome of one ordered-startup pass (OPS-5). Splits the specs into the ones
/// we actually launched (each paired with its live child) and the OPTIONAL ones
/// we skipped because their backing resource was absent — so a RAG-less build
/// can report "open-notebook skipped, RAG unavailable" to the UI without ever
/// having tried to spawn a non-existent binary.
struct SpawnOutcome {
    launched: Vec<SupervisedSidecar>,
    skipped: Vec<SidecarSpec>,
}

/// Iterate the given launcher over `build_sidecar_specs(dir)` in dependency
/// order (BA2), logging successes and failures the same way the prior inline
/// supervisor did. Returns the spawned children (each paired with the spec that
/// produced it, so the Tauri runtime can kill them on exit and the health-poll
/// task can respawn a crashed one from its retained recipe) alongside the
/// optional specs that were skipped for an absent resource (OPS-5).
///
/// OPS-5 graceful degrade: before gating + launching, each spec's optionality is
/// checked. An OPTIONAL sidecar whose `resource_path` is absent on disk (a
/// RAG-less build that didn't bundle `<dir>/open-notebook`) is logged and
/// SKIPPED — neither its dependency gate nor its launch runs — and recorded in
/// `SpawnOutcome::skipped`. The app then degrades gracefully (RAG/notebook
/// features off) instead of logging a launch error every poll. REQUIRED sidecars
/// (SurrealDB, the LSAT backend) are never skipped and gate/launch as before.
///
/// Ordering (BA2): the specs are walked front-to-back, and before each is
/// launched, every dependency named in its `depends_on` that exposes a
/// readiness port is confirmed listening via a bounded `wait_for_port_ready`.
/// Concretely this makes SurrealDB (:8000) ready before open-notebook's API
/// (:5055) connects, and the API ready before the worker drains its queue. The
/// LSAT backend declares no deps, so it starts without waiting. A dependency
/// that fails to launch — or never binds within the budget — is logged and the
/// dependent is started anyway in a degraded state, so one wedged sidecar can
/// never hang the whole launch.
///
/// `build_sidecar_specs` is the single source of truth for spec order, so the
/// `depends_on` graph must be consistent with it (a dependency must appear
/// earlier in the vec than its dependents); the production specs satisfy this.
///
/// `readiness_budget` caps how long each dependency gate may wait before the
/// dependent is started degraded. Production passes `READINESS_WAIT_BUDGET`
/// (~30s); tests pass a tiny budget so the mock-launcher path (whose specs
/// never actually bind their ports) doesn't pay the full wait.
///
/// BA8: each successfully-launched child has its stdout + stderr attached to
/// the shared `logs` ring buffer before being retained, so the log viewer sees
/// output from process start.
///
/// Since DATA-7, the production path (`spawn_sidecars`) builds + relocation-guards
/// the specs and calls `spawn_sidecars_with_specs` directly, so this `dir`-based
/// wrapper is exercised only by the supervisor unit tests — hence the
/// `allow(dead_code)` in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
fn spawn_sidecars_with<L: SidecarLauncher>(
    launcher: &L,
    dir: &Path,
    logs: &SidecarLogs,
    readiness_budget: Duration,
) -> SpawnOutcome {
    // Build the specs from the pure recipe, then run the (unchanged) ordered
    // startup. The production path (`spawn_sidecars`) instead builds the specs,
    // applies the DATA-7 relocation guard to them, and calls
    // `spawn_sidecars_with_specs` directly — so the only behavioural difference is
    // the LSAT spec's `LSATLAB_DATA_DIR` env. Tests still drive this entrypoint.
    let specs = build_sidecar_specs(dir);
    spawn_sidecars_with_specs(launcher, specs, logs, readiness_budget)
}

/// Ordered-startup core (BA2/OPS-5/BA8), parameterized by PRE-BUILT specs so the
/// production path can post-process them (DATA-7 relocation guard) before launch
/// without this function re-deriving them from a `dir`. `spawn_sidecars_with`
/// (the test entrypoint) builds the specs from `build_sidecar_specs` and delegates
/// here; behaviour is otherwise identical.
fn spawn_sidecars_with_specs<L: SidecarLauncher>(
    launcher: &L,
    specs: Vec<SidecarSpec>,
    logs: &SidecarLogs,
    readiness_budget: Duration,
) -> SpawnOutcome {
    // Index every spec's readiness port by name so a dependent can look up the
    // port it must wait on. Specs without a readiness port (the worker) map to
    // `None` and are skipped by the wait below.
    let ports_by_name: HashMap<String, Option<u16>> = specs
        .iter()
        .map(|s| (s.name.clone(), s.ready_port))
        .collect();

    let mut kids = Vec::new();
    let mut skipped = Vec::new();
    for spec in specs {
        // OPS-5: graceful degrade for optional sidecars. If an optional sidecar's
        // backing resource is absent (a RAG-less build with no
        // `<dir>/open-notebook`), skip it entirely — don't gate on its deps, don't
        // launch, don't error. Record it so the status payload can show the UI
        // that RAG is unavailable. Required sidecars never take this branch.
        if spec.optional && !spec.resource_present() {
            log::info!(
                "sidecar: {} is optional and its resource is absent ({}); \
                 skipping — feature unavailable, app continues degraded",
                spec.name,
                spec.resource_path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "<none>".into())
            );
            skipped.push(spec);
            continue;
        }

        // BA2: gate this sidecar behind its dependencies. For each named
        // dependency that has a readiness port, block (bounded) until that port
        // is listening. A dependency with no port, or one not in the spec set,
        // can't be probed — log and move on rather than wait on nothing.
        for dep in &spec.depends_on {
            match ports_by_name.get(dep) {
                Some(Some(dep_port)) => {
                    let label = format!("{} (dep of {})", dep, spec.name);
                    wait_for_port_ready(
                        &label,
                        *dep_port,
                        readiness_budget,
                        std::time::Instant::now,
                    );
                }
                Some(None) => {
                    log::info!(
                        "sidecar: {} depends on {} which has no readiness port; \
                         not gating on it",
                        spec.name,
                        dep
                    );
                }
                None => {
                    log::warn!(
                        "sidecar: {} declares unknown dependency {}; ignoring",
                        spec.name,
                        dep
                    );
                }
            }
        }

        match launcher.launch(&spec) {
            Ok(mut child) => {
                log::info!("sidecar: {} started (pid {})", spec.name, child.id());
                attach_log_capture(&spec.name, &mut child, logs);
                kids.push(SupervisedSidecar { spec, child });
            }
            Err(e) => log::error!("sidecar: {} failed to start: {e}", spec.name),
        }
    }
    SpawnOutcome {
        launched: kids,
        skipped,
    }
}

/// DATA-7: apply the app-data relocation guard to the LSAT backend spec.
///
/// `build_sidecar_specs` is pure (no I/O); this is where the filesystem-touching
/// relocation check lives. `new_dir` is the data dir the host already pinned for
/// the LSAT sidecar (via an `LSATLAB_DATA_DIR` env override) — `None` means "let
/// the backend resolve its own default", in which case the guard is a no-op
/// (old == new under that default, so nothing is ever orphaned). When a
/// `new_dir` is given AND a non-empty store is orphaned at the legacy
/// `%APPDATA%/LSATLab` location while `new_dir` has no store yet,
/// `relocation::resolve_lsat_data_dir` returns the OLD dir so the sidecar reads
/// the recovered bank in place — conservative: detect + set-env, never a move.
///
/// Mutates the passed `specs` in place: it sets/overrides the LSAT spec's
/// `LSATLAB_DATA_DIR` env to the resolved dir, matching the existing
/// env-pair-vec construction style. A no-op for non-LSAT specs and when nothing
/// needs relocating with an unset `new_dir`.
fn apply_lsat_relocation_env(specs: &mut [SidecarSpec], new_dir: Option<PathBuf>) {
    let resolved = match relocation::resolve_lsat_data_dir(new_dir) {
        Some(d) => d,
        None => return, // unset new dir → backend resolves its default; no-op.
    };
    let Some(lsat) = specs.iter_mut().find(|s| s.name == "LSAT backend") else {
        return;
    };
    let resolved_str = resolved.to_string_lossy().into_owned();
    // Log in the same style as the ordered-startup / OPS-5 messages so the
    // sidecar log viewer shows the relocation decision.
    log::info!(
        "sidecar: LSAT backend data dir resolved to {} (DATA-7 relocation guard)",
        resolved_str
    );
    // Set or override LSATLAB_DATA_DIR; keep the existing (key, value) env-pair
    // shape `build_sidecar_specs` uses.
    if let Some(pair) = lsat.env.iter_mut().find(|(k, _)| k == "LSATLAB_DATA_DIR") {
        pair.1 = resolved_str;
    } else {
        lsat.env.push(("LSATLAB_DATA_DIR".into(), resolved_str));
    }
}

fn spawn_sidecars(logs: &SidecarLogs) -> SpawnOutcome {
    let dir = services_dir();
    // DATA-7: only the host knows where app-data was relocated to; it pins the
    // LSAT data dir via the LSATLAB_DATA_DIR env. Detect an orphaned legacy store
    // relative to that pinned dir and, if found, point the sidecar at it. With no
    // override the backend resolves its own default and the guard is a no-op.
    let new_dir = std::env::var("LSATLAB_DATA_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut specs = build_sidecar_specs(&dir);
    apply_lsat_relocation_env(&mut specs, new_dir);
    spawn_sidecars_with_specs(&ProcessLauncher, specs, logs, READINESS_WAIT_BUDGET)
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
/// audit M15 — terminate a sidecar AND its descendants. open-notebook + the worker
/// are launched via `uv`, which forks Python grandchildren; a plain `child.kill()`
/// reaps only the direct `uv` process and orphans those grandchildren (they keep
/// holding ports/files). On Windows `taskkill /T` walks the whole tree by PID. On
/// other platforms we fall back to the direct kill (a full Unix tree-kill needs a
/// process-group spawn — tracked as a follow-up). Always follow with `child.wait()`
/// at the call site to reap the handle.
fn kill_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // /T = tree, /F = force. Best-effort: if the pid is already gone this
        // no-ops. We still call child.kill() below as a fallback / for the
        // direct handle.
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .output();
    }
    let _ = child.kill();
}

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
            // Reap the old handle (and its uv grandchildren, audit M15) so we
            // don't leak a zombie on Unix or orphan the Python workers on Windows.
            kill_child_tree(&mut slot.child);
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

/// Map one launched sidecar slot to its status row. Pure helper so the command
/// body (and a unit test) can build a row without a live Tauri State wrapper.
fn launched_sidecar_status(slot: &SupervisedSidecar) -> SidecarStatus {
    let healthy = probe_sidecar_healthy(&slot.spec);
    SidecarStatus {
        name: slot.spec.name.clone(),
        port: slot.spec.ready_port,
        ready_port: slot.spec.ready_port,
        healthy,
        // `probe_sidecar_healthy` already encodes the readiness gate:
        // port listening for socketed sidecars, liveness fallback (true)
        // for port-less ones. Reuse it so `ready` and `healthy` can't
        // drift apart.
        ready: healthy,
        depends_on: slot.spec.depends_on.clone(),
        pid: Some(slot.child.id()),
        optional: slot.spec.optional,
        // A launched sidecar's resource was present (else it'd have been
        // skipped) — or it has no resource gate at all.
        present: true,
    }
}

/// Map one SKIPPED optional sidecar spec (OPS-5) to its status row: never
/// launched, so not healthy / not ready / no pid, and explicitly
/// `optional: true, present: false` so the UI renders "feature unavailable"
/// (e.g. RAG) rather than a crash.
fn skipped_sidecar_status(spec: &SidecarSpec) -> SidecarStatus {
    SidecarStatus {
        name: spec.name.clone(),
        port: spec.ready_port,
        ready_port: spec.ready_port,
        healthy: false,
        ready: false,
        depends_on: spec.depends_on.clone(),
        pid: None,
        optional: spec.optional,
        present: false,
    }
}

/// Tauri command backing the UI health panel. Probes each managed sidecar's
/// readiness port and reports name / port / ready_port / healthy / ready /
/// depends_on / pid, plus the OPS-5 `optional` + `present` flags. Port-less
/// sidecars report healthy as long as their process handle is still tracked.
/// Skipped optional sidecars (OPS-5) are appended as not-present rows so a host
/// UI can show, e.g., "RAG unavailable (open-notebook not bundled)".
#[tauri::command]
fn get_sidecar_status(
    state: tauri::State<'_, Sidecars>,
    skipped: tauri::State<'_, SkippedSidecars>,
) -> Vec<SidecarStatus> {
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut out: Vec<SidecarStatus> = guard.iter().map(launched_sidecar_status).collect();
    drop(guard);

    let skipped_guard = match skipped.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    out.extend(skipped_guard.iter().map(skipped_sidecar_status));
    out
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

/// OPS-3 — one consolidated System-Health verdict over every supervised sidecar,
/// returned by `get_system_health_aggregated` so the host can draw a single
/// header badge without iterating the per-sidecar rows itself.
///
/// Serde field names are snake_case on the wire (matching the rest of the
/// supervisor payloads). The `status` is an ok/degraded/error roll-up; the
/// per-bucket counts let the host render a "n/m ready" sub-label. This speaks
/// only to PROCESS supervision — the LSAT backend's own internal health
/// (DB/worker/cloud) is layered in by the host from the backend's
/// `/observability/health-aggregated` endpoint.
#[derive(Serialize, Debug, PartialEq, Eq)]
struct SystemHealthAggregate {
    /// Rolled-up verdict: "ok" (all required sidecars ready), "degraded" (an
    /// OPTIONAL sidecar is down/absent but every REQUIRED one is ready), or
    /// "error" (at least one REQUIRED sidecar is down).
    status: String,
    /// Number of sidecars whose readiness gate is currently satisfied.
    ready: usize,
    /// Number of REQUIRED sidecars that are not ready (drives the "error" verdict).
    required_down: usize,
    /// Number of OPTIONAL sidecars that are down or were skipped for an absent
    /// resource (drives the "degraded" verdict; never an error on its own).
    optional_down: usize,
    /// Total number of sidecars tracked (launched + skipped-optional).
    total: usize,
    /// Names of the not-ready REQUIRED sidecars, for a precise host message.
    required_down_names: Vec<String>,
}

/// Roll a slice of sidecar status rows into a single verdict. Pure helper so the
/// command body and a unit test can classify rows without a live Tauri State.
fn aggregate_sidecar_health(rows: &[SidecarStatus]) -> SystemHealthAggregate {
    let total = rows.len();
    let ready = rows.iter().filter(|r| r.ready).count();
    let required_down_names: Vec<String> = rows
        .iter()
        .filter(|r| !r.ready && !r.optional)
        .map(|r| r.name.clone())
        .collect();
    let required_down = required_down_names.len();
    let optional_down = rows.iter().filter(|r| !r.ready && r.optional).count();
    let status = if required_down > 0 {
        "error"
    } else if optional_down > 0 {
        "degraded"
    } else {
        "ok"
    };
    SystemHealthAggregate {
        status: status.to_string(),
        ready,
        required_down,
        optional_down,
        total,
        required_down_names,
    }
}

/// Tauri command backing the OPS-3 System-Health header badge. Builds the same
/// per-sidecar rows as `get_sidecar_status` (launched + skipped-optional) and
/// rolls them into one ok/degraded/error verdict. Additive — leaves
/// `get_sidecar_status` untouched for the detailed table.
#[tauri::command]
fn get_system_health_aggregated(
    state: tauri::State<'_, Sidecars>,
    skipped: tauri::State<'_, SkippedSidecars>,
) -> SystemHealthAggregate {
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut rows: Vec<SidecarStatus> = guard.iter().map(launched_sidecar_status).collect();
    drop(guard);

    let skipped_guard = match skipped.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    rows.extend(skipped_guard.iter().map(skipped_sidecar_status));
    drop(skipped_guard);

    aggregate_sidecar_health(&rows)
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

    // ---- DATA-7 relocation guard wiring (apply_lsat_relocation_env) ----

    #[test]
    fn apply_lsat_relocation_env_noop_when_new_dir_unset() {
        // Unset new dir → backend resolves its own default; env is left as built.
        let mut specs = build_sidecar_specs(&PathBuf::from("C:/qv/services"));
        apply_lsat_relocation_env(&mut specs, None);
        let lsat = specs.iter().find(|s| s.name == "LSAT backend").unwrap();
        assert!(
            !lsat.env.iter().any(|(k, _)| k == "LSATLAB_DATA_DIR"),
            "no relocation env when new dir is unset"
        );
    }

    #[test]
    fn apply_lsat_relocation_env_sets_dir_when_new_dir_given() {
        // With a new dir given and no orphaned store, the LSAT spec is pinned to
        // that dir (conservative: detect + set-env, no move). Use a temp dir as
        // the populated NEW store so the guard resolves to it deterministically.
        let tmp = tempdir().unwrap();
        let new_dir = tmp.path().join("active");
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(new_dir.join("lsatlab.db"), b"active-bank").unwrap();

        let mut specs = build_sidecar_specs(&PathBuf::from("C:/qv/services"));
        apply_lsat_relocation_env(&mut specs, Some(new_dir.clone()));
        let lsat = specs.iter().find(|s| s.name == "LSAT backend").unwrap();
        let pair = lsat
            .env
            .iter()
            .find(|(k, _)| k == "LSATLAB_DATA_DIR")
            .expect("LSATLAB_DATA_DIR set");
        assert_eq!(pair.1, new_dir.to_string_lossy());
        // Non-LSAT specs are untouched.
        assert!(specs[0].env.iter().all(|(k, _)| k != "LSATLAB_DATA_DIR"));
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

    /// Create a temp services dir whose `open-notebook/` subdir exists, so the
    /// OPS-5 optional-skip check sees the RAG resource as PRESENT and the full
    /// four-spec fan-out is exercised (tests of the *absent* path live below).
    /// Returns the tempdir guard (kept alive by the caller) and its path.
    fn services_dir_with_onb() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempdir().expect("tempdir");
        let dir = tmp.path().join("services");
        fs::create_dir_all(dir.join("open-notebook")).unwrap();
        (tmp, dir)
    }

    #[test]
    fn spawn_sidecars_with_invokes_launcher_for_every_spec() {
        let launcher = MockLauncher::new(vec![]);
        let logs = SidecarLogs::default();
        // RAG resource present, so no optional sidecar is skipped — all four
        // specs are launched.
        let (_tmp, dir) = services_dir_with_onb();
        // Zero readiness budget: the mock launcher never binds the readiness
        // ports, so each dependency gate probes once and immediately proceeds
        // degraded rather than waiting out the full production budget. The
        // launch order is still dependency order.
        let mut outcome = spawn_sidecars_with(&launcher, &dir, &logs, Duration::ZERO);
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
        assert_eq!(outcome.launched.len(), 4);
        assert!(outcome.skipped.is_empty(), "nothing skipped when RAG present");
        // Each slot retains the spec that produced it (so a crash can be
        // respawned), paired with the live child.
        assert_eq!(outcome.launched[0].spec.name, "SurrealDB");
        // Lifecycle: reap the synthesized mock children so they don't linger.
        for s in outcome.launched.iter_mut() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    #[test]
    fn spawn_sidecars_with_skips_failed_sidecars_but_continues() {
        let launcher = MockLauncher::new(vec!["SurrealDB"]);
        let logs = SidecarLogs::default();
        let (_tmp, dir) = services_dir_with_onb();
        // Zero readiness budget for the same reason as the prior test: the mock
        // ports never bind, so the dependency gates degrade immediately. This
        // also exercises that a dependency which *failed to launch* (SurrealDB
        // here) doesn't block its dependents past the budget.
        let mut outcome = spawn_sidecars_with(&launcher, &dir, &logs, Duration::ZERO);
        // All four specs were attempted, even though SurrealDB returned Err.
        assert_eq!(launcher.calls.borrow().len(), 4);
        // Only the three successful launches yield Child handles.
        assert_eq!(outcome.launched.len(), 3);
        assert!(outcome.skipped.is_empty());
        for s in outcome.launched.iter_mut() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    #[test]
    fn spawn_sidecars_with_skips_optional_onb_when_resource_absent() {
        // OPS-5 graceful degrade: with no `<dir>/open-notebook` resource (a
        // RAG-less build), the two optional open-notebook sidecars are SKIPPED —
        // never launched — while the required SurrealDB + LSAT backend still come
        // up. The skipped specs are returned so the status payload can report it.
        let launcher = MockLauncher::new(vec![]);
        let logs = SidecarLogs::default();
        let tmp = tempdir().expect("tempdir");
        let dir = tmp.path().join("services-no-rag"); // open-notebook/ absent
        let mut outcome = spawn_sidecars_with(&launcher, &dir, &logs, Duration::ZERO);

        // Only the required sidecars were launched, in order.
        let launched_names: Vec<_> =
            outcome.launched.iter().map(|s| s.spec.name.clone()).collect();
        assert_eq!(launched_names, vec!["SurrealDB", "LSAT backend"]);
        // The launcher was never even asked to start the optional pair.
        let attempted: Vec<_> =
            launcher.calls.borrow().iter().map(|s| s.name.clone()).collect();
        assert_eq!(attempted, vec!["SurrealDB", "LSAT backend"]);
        // The optional open-notebook API + worker were recorded as skipped.
        let skipped_names: Vec<_> = outcome.skipped.iter().map(|s| s.name.clone()).collect();
        assert_eq!(
            skipped_names,
            vec!["open-notebook API", "open-notebook worker"]
        );
        assert!(outcome.skipped.iter().all(|s| s.optional));

        for s in outcome.launched.iter_mut() {
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
            depends_on: vec![],
            optional: false,
            resource_path: None,
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
            depends_on: vec![],
            optional: false,
            resource_path: None,
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
            depends_on: vec![],
            optional: false,
            resource_path: None,
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
            depends_on: vec![],
            optional: false,
            resource_path: None,
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
            depends_on: vec![],
            optional: false,
            resource_path: None,
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
        // Guards the JSON contract the UI consumes: name/port/ready_port/
        // healthy/ready/depends_on/pid plus the OPS-5 optional/present flags.
        let status = SidecarStatus {
            name: "open-notebook API".into(),
            port: Some(5055),
            ready_port: Some(5055),
            healthy: false,
            ready: false,
            depends_on: vec!["SurrealDB".into()],
            pid: Some(1234),
            optional: true,
            present: true,
        };
        let json = serde_json::to_value(&status).expect("serialize");
        assert_eq!(json["name"], "open-notebook API");
        assert_eq!(json["port"], 5055);
        assert_eq!(json["ready_port"], 5055);
        assert_eq!(json["healthy"], false);
        assert_eq!(json["ready"], false);
        assert_eq!(json["depends_on"][0], "SurrealDB");
        assert_eq!(json["pid"], 1234);
        assert_eq!(json["optional"], true);
        assert_eq!(json["present"], true);
    }

    // ---- aggregate_sidecar_health (OPS-3) ----

    fn status_row(name: &str, ready: bool, optional: bool) -> SidecarStatus {
        SidecarStatus {
            name: name.into(),
            port: Some(8000),
            ready_port: Some(8000),
            healthy: ready,
            ready,
            depends_on: vec![],
            pid: if ready { Some(1) } else { None },
            optional,
            present: ready,
        }
    }

    #[test]
    fn aggregate_health_is_ok_when_all_ready() {
        let rows = vec![
            status_row("SurrealDB", true, false),
            status_row("LSAT backend", true, false),
            status_row("open-notebook API", true, true),
        ];
        let agg = aggregate_sidecar_health(&rows);
        assert_eq!(agg.status, "ok");
        assert_eq!(agg.ready, 3);
        assert_eq!(agg.total, 3);
        assert_eq!(agg.required_down, 0);
        assert_eq!(agg.optional_down, 0);
        assert!(agg.required_down_names.is_empty());
    }

    #[test]
    fn aggregate_health_is_degraded_when_only_optional_down() {
        // An absent/optional sidecar (e.g. a RAG-less build) must NOT escalate to
        // "error" — required sidecars are all up.
        let rows = vec![
            status_row("SurrealDB", true, false),
            status_row("LSAT backend", true, false),
            status_row("open-notebook API", false, true),
        ];
        let agg = aggregate_sidecar_health(&rows);
        assert_eq!(agg.status, "degraded");
        assert_eq!(agg.optional_down, 1);
        assert_eq!(agg.required_down, 0);
    }

    #[test]
    fn aggregate_health_is_error_when_a_required_sidecar_is_down() {
        let rows = vec![
            status_row("SurrealDB", true, false),
            status_row("LSAT backend", false, false),
            status_row("open-notebook API", false, true),
        ];
        let agg = aggregate_sidecar_health(&rows);
        assert_eq!(agg.status, "error");
        assert_eq!(agg.required_down, 1);
        assert_eq!(agg.required_down_names, vec!["LSAT backend".to_string()]);
        // Optional-down still counted, but the verdict is driven by the required one.
        assert_eq!(agg.optional_down, 1);
    }

    #[test]
    fn aggregate_health_empty_is_ok() {
        let agg = aggregate_sidecar_health(&[]);
        assert_eq!(agg.status, "ok");
        assert_eq!(agg.total, 0);
        assert_eq!(agg.ready, 0);
    }

    #[test]
    fn build_sidecar_specs_marks_onb_optional_and_lsat_required() {
        // OPS-5: open-notebook API + worker are optional and gated on the
        // `<dir>/open-notebook` resource; SurrealDB + the LSAT backend are
        // required with no resource gate.
        let dir = PathBuf::from("C:/qv/services");
        let specs = build_sidecar_specs(&dir);
        let onb = dir.join("open-notebook");

        assert!(!specs[0].optional, "SurrealDB is required");
        assert_eq!(specs[0].resource_path, None);

        assert!(specs[1].optional, "open-notebook API is optional");
        assert_eq!(specs[1].resource_path.as_deref(), Some(onb.as_path()));

        assert!(specs[2].optional, "open-notebook worker is optional");
        assert_eq!(specs[2].resource_path.as_deref(), Some(onb.as_path()));

        assert!(!specs[3].optional, "LSAT backend is required");
        assert_eq!(specs[3].resource_path, None);
    }

    #[test]
    fn resource_present_gates_on_path_existence_only_for_resourced_specs() {
        // A spec with no resource_path is always present. A spec with a
        // resource_path is present iff that path exists on disk.
        let tmp = tempdir().expect("tempdir");
        let existing = tmp.path().join("open-notebook");
        fs::create_dir_all(&existing).unwrap();
        let missing = tmp.path().join("does-not-exist");

        let no_gate = SidecarSpec {
            name: "SurrealDB".into(),
            program: PathBuf::from("x"),
            args: vec![],
            env: vec![],
            ready_port: Some(8000),
            depends_on: vec![],
            optional: false,
            resource_path: None,
        };
        assert!(no_gate.resource_present());

        let present = SidecarSpec {
            resource_path: Some(existing),
            ..no_gate.clone()
        };
        assert!(present.resource_present());

        let absent = SidecarSpec {
            resource_path: Some(missing),
            ..no_gate.clone()
        };
        assert!(!absent.resource_present());
    }

    #[test]
    fn skipped_sidecar_status_reports_optional_and_absent() {
        // OPS-5: a skipped optional sidecar maps to a not-present, not-healthy
        // row with no pid so the UI can render "feature unavailable".
        let spec = SidecarSpec {
            name: "open-notebook API".into(),
            program: PathBuf::from("uv"),
            args: vec![],
            env: vec![],
            ready_port: Some(5055),
            depends_on: vec!["SurrealDB".into()],
            optional: true,
            resource_path: Some(PathBuf::from("C:/qv/services/open-notebook")),
        };
        let status = skipped_sidecar_status(&spec);
        assert_eq!(status.name, "open-notebook API");
        assert_eq!(status.ready_port, Some(5055));
        assert!(!status.healthy);
        assert!(!status.ready);
        assert_eq!(status.pid, None);
        assert!(status.optional);
        assert!(!status.present);
        assert_eq!(status.depends_on, vec!["SurrealDB".to_string()]);
    }

    #[test]
    fn build_sidecar_specs_pins_readiness_ports() {
        let specs = build_sidecar_specs(Path::new("C:/qv/services"));
        assert_eq!(specs[0].ready_port, Some(8000)); // SurrealDB
        assert_eq!(specs[1].ready_port, Some(5055)); // open-notebook API
        assert_eq!(specs[2].ready_port, None); // worker (no socket)
        assert_eq!(specs[3].ready_port, Some(8100)); // LSAT backend
    }

    // ---- ordered startup / readiness gates (BA2) ----

    #[test]
    fn build_sidecar_specs_declares_dependency_chain() {
        let specs = build_sidecar_specs(Path::new("C:/qv/services"));
        // SurrealDB is the root of the storage stack — no dependencies.
        assert!(specs[0].depends_on.is_empty(), "SurrealDB has no deps");
        // The API waits on SurrealDB.
        assert_eq!(specs[1].depends_on, vec!["SurrealDB".to_string()]);
        // The worker waits on the API (transitively on SurrealDB).
        assert_eq!(specs[2].depends_on, vec!["open-notebook API".to_string()]);
        // The LSAT backend is self-contained — independent of the stack.
        assert!(specs[3].depends_on.is_empty(), "LSAT backend has no deps");
    }

    #[test]
    fn build_sidecar_specs_dependencies_appear_before_dependents() {
        // The ordered startup walks the vec front-to-back, so every dependency
        // must be listed earlier than the sidecar that depends on it. Guard
        // that invariant directly off the spec set.
        let specs = build_sidecar_specs(Path::new("C:/qv/services"));
        let index_of = |name: &str| specs.iter().position(|s| s.name == name);
        for (i, spec) in specs.iter().enumerate() {
            for dep in &spec.depends_on {
                let dep_idx = index_of(dep)
                    .unwrap_or_else(|| panic!("dependency {dep} not in spec set"));
                assert!(
                    dep_idx < i,
                    "{} (idx {i}) depends on {dep} (idx {dep_idx}) which must come first",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn wait_for_port_ready_returns_true_once_port_is_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        // The port is already listening, so the first probe succeeds and the
        // helper returns immediately without consuming the budget.
        let ready = wait_for_port_ready(
            "test-dep",
            port,
            Duration::from_secs(5),
            std::time::Instant::now,
        );
        assert!(ready, "a bound port should be reported ready");
        drop(listener);
    }

    #[test]
    fn wait_for_port_ready_gives_up_after_budget_without_hanging() {
        // Port 0 is never a listening destination, so the helper can only exit
        // via the budget. Drive the clock so the first elapsed check already
        // exceeds the budget: the loop probes once, then returns false — proving
        // a never-up dependency degrades instead of hanging startup forever.
        let calls = std::cell::Cell::new(0u32);
        let base = std::time::Instant::now();
        let clock = || {
            let n = calls.get();
            calls.set(n + 1);
            // First call (loop entry `start`) returns `base`; every subsequent
            // call returns far past the budget so the elapsed check trips.
            if n == 0 {
                base
            } else {
                base + Duration::from_secs(3600)
            }
        };
        let ready = wait_for_port_ready("never-up", 0, Duration::from_secs(30), clock);
        assert!(!ready, "an unreachable port must time out, not hang");
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
            get_sidecar_logs,
            get_system_health_aggregated
        ])
        .manage(Sidecars::default())
        .manage(SkippedSidecars::default())
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
            // BA2: ordered startup gates each sidecar behind its dependencies'
            // readiness ports with a bounded (~30s/dep) wait, so this can block
            // for a noticeable stretch when a dependency is slow to bind. Run it
            // off the setup thread so the webview opens immediately and the
            // sidecars come up in dependency order behind it; the `Sidecars`
            // state is populated once startup finishes. The health supervisor
            // (started below) sweeps on an interval and harmlessly no-ops while
            // the state is still empty, so there's no race in starting it first.
            let startup_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let outcome = spawn_sidecars(&logs);
                // OPS-5: record any optional sidecars that were skipped for an
                // absent resource so `get_sidecar_status` can report "feature
                // unavailable" (e.g. RAG-less build) to the UI.
                if !outcome.skipped.is_empty() {
                    let names: Vec<&str> =
                        outcome.skipped.iter().map(|s| s.name.as_str()).collect();
                    log::info!(
                        "sidecar: ordered startup skipped {} optional sidecar(s) for absent \
                         resources: {}",
                        outcome.skipped.len(),
                        names.join(", ")
                    );
                }
                if let Some(skipped_state) = startup_handle.try_state::<SkippedSidecars>() {
                    *skipped_state.0.lock().unwrap() = outcome.skipped;
                }
                if let Some(state) = startup_handle.try_state::<Sidecars>() {
                    *state.0.lock().unwrap() = outcome.launched;
                    log::info!("sidecar: ordered startup complete");
                }
            });
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
                        // audit M15 — kill the whole tree so uv-spawned Python
                        // grandchildren don't survive as orphans holding ports.
                        kill_child_tree(&mut supervised.child);
                        let _ = supervised.child.wait();
                        log::info!("sidecar: {} terminated on exit", supervised.spec.name);
                    }
                }
            }
        });
}
