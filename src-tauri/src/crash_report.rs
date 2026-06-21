//! NATIVE-4 — local-only crash reporting + last-resort sidecar reaping.
//!
//! FULLY OFFLINE: a crash report is written to a local file under the app's log
//! directory; nothing is ever sent anywhere. Two jobs:
//!
//!   1. Install a panic hook that, on ANY Rust panic, appends a timestamped
//!      entry (panic message + location + the previous hook's output) to a
//!      `crash.log` under the app log dir — so a hard fault leaves a local
//!      breadcrumb instead of vanishing.
//!   2. As a last-resort net, the hook invokes a reaper callback the supervisor
//!      supplies, which kills the tracked sidecars — covering the window where
//!      the Rust process panics but the OS-level Job Object / PDEATHSIG hasn't
//!      yet fired.
//!
//! The pure pieces — the crash-log path resolution and the entry formatting —
//! are unit-tested below. The hook INSTALLATION is a thin wrapper the supervisor
//! calls once at setup (runtime-exercised, not unit-tested, since installing a
//! global panic hook in a unit test would clobber the harness's own).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Crash-log filename under the app log dir. Appended to, never truncated, so a
/// history of crashes survives across launches.
pub const CRASH_LOG_FILENAME: &str = "crash.log";

/// Resolve the crash-log file path given the app's log directory. Pure: just
/// joins the filename. Kept as a function (not an inline join) so callers + tests
/// agree on the exact layout and a future relocation is one edit.
pub fn crash_log_path(log_dir: &Path) -> PathBuf {
    log_dir.join(CRASH_LOG_FILENAME)
}

/// Format one crash-log entry. Pure + deterministic given its inputs, so the
/// exact on-disk shape is unit-testable. `timestamp` is an already-formatted
/// string (the caller passes a real wall-clock stamp in production, a fixed one
/// in tests) to keep this free of clock/`SystemTime` formatting concerns.
///
/// Shape (stable — the local log viewer / a support bundle parses it):
/// ```text
/// ==== CRASH 2026-06-20T12:34:56Z ====
/// thread 'main' panicked: <message>
/// location: <file:line:col or "unknown">
/// reaped sidecars: <n>
/// ====================================
/// ```
pub fn format_crash_entry(
    timestamp: &str,
    thread_name: &str,
    message: &str,
    location: Option<&str>,
    reaped: usize,
) -> String {
    let loc = location.unwrap_or("unknown");
    format!(
        "==== CRASH {ts} ====\n\
         thread '{thread}' panicked: {msg}\n\
         location: {loc}\n\
         reaped sidecars: {reaped}\n\
         ====================================\n",
        ts = timestamp,
        thread = thread_name,
        msg = message,
        loc = loc,
        reaped = reaped,
    )
}

/// Append `entry` to the crash log at `path`, creating the parent dir + file as
/// needed. Best-effort: returns the I/O result so a caller can log a failure, but
/// the panic hook ignores it (a failure to write the breadcrumb must never mask
/// the original panic). Extracted so it's testable against a temp dir.
pub fn append_crash_entry(path: &Path, entry: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(entry.as_bytes())
}

/// A reaper the panic hook calls as a last resort. Returns the number of
/// sidecars reaped (for the log entry). The supervisor supplies one that kills
/// every tracked child; tests supply a counting stub.
pub type Reaper = Box<dyn Fn() -> usize + Send + Sync + 'static>;

/// Holds the panic-hook context (where to write, how to reap) behind a mutex so
/// the global hook closure can reach it. Set once at install.
struct HookState {
    log_dir: PathBuf,
    reaper: Reaper,
}

static HOOK_STATE: Mutex<Option<HookState>> = Mutex::new(None);

/// Install the crash-report panic hook (NATIVE-4). Idempotent-safe to call once
/// at app setup. Chains the previous hook so default behavior (stderr backtrace
/// in dev) is preserved, then writes a local crash entry and runs the
/// last-resort reaper.
///
/// `now` produces the timestamp string (injected so the formatting stays
/// testable elsewhere; production passes an RFC3339-ish UTC stamp). The hook
/// itself is runtime-exercised — not unit-tested — because replacing the global
/// hook would interfere with the test harness.
pub fn install_crash_hook(log_dir: PathBuf, reaper: Reaper, now: fn() -> String) {
    {
        let mut guard = HOOK_STATE.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(HookState { log_dir, reaper });
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Run the previous hook first so the dev backtrace still prints.
        previous(info);

        let timestamp = now();
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let message = panic_message(info.payload());
        let location = info.location().map(|l| l.to_string());

        let guard = HOOK_STATE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(state) = guard.as_ref() {
            // Last-resort reaping: kill tracked sidecars before we write the
            // entry, so the reaped count is accurate.
            let reaped = (state.reaper)();
            let entry =
                format_crash_entry(&timestamp, &thread, &message, location.as_deref(), reaped);
            let path = crash_log_path(&state.log_dir);
            // Ignore the write result: a failed breadcrumb must not mask the panic.
            let _ = append_crash_entry(&path, &entry);
        }
    }));
}

/// Extract a human-readable message from a panic payload (handles the common
/// `&str` / `String` payload shapes; falls back to a generic note). Takes the
/// payload as `&(dyn Any + Send)` rather than naming `PanicHookInfo` so it
/// compiles on the declared MSRV (the `PanicHookInfo` name only stabilized in
/// 1.81); `Any::downcast_ref` is stable since 1.0. Also unit-testable in isolation.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn crash_log_path_joins_filename_under_log_dir() {
        let dir = Path::new("C:/logs/studyvault");
        assert_eq!(
            crash_log_path(dir),
            Path::new("C:/logs/studyvault").join(CRASH_LOG_FILENAME)
        );
    }

    #[test]
    fn format_crash_entry_is_stable_and_includes_all_fields() {
        let entry = format_crash_entry(
            "2026-06-20T12:34:56Z",
            "main",
            "something blew up",
            Some("src/lib.rs:42:7"),
            3,
        );
        assert!(entry.contains("==== CRASH 2026-06-20T12:34:56Z ===="));
        assert!(entry.contains("thread 'main' panicked: something blew up"));
        assert!(entry.contains("location: src/lib.rs:42:7"));
        assert!(entry.contains("reaped sidecars: 3"));
        assert!(entry.ends_with("====================================\n"));
    }

    #[test]
    fn format_crash_entry_handles_unknown_location() {
        let entry = format_crash_entry("t", "worker", "boom", None, 0);
        assert!(entry.contains("location: unknown"));
        assert!(entry.contains("reaped sidecars: 0"));
    }

    #[test]
    fn append_crash_entry_creates_dirs_and_appends() {
        let tmp = tempdir().unwrap();
        // Nested, not-yet-existing log dir so we exercise create_dir_all.
        let path = tmp
            .path()
            .join("nested")
            .join("logs")
            .join(CRASH_LOG_FILENAME);

        append_crash_entry(&path, "first\n").unwrap();
        append_crash_entry(&path, "second\n").unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        // Appended, not truncated: both entries present in order.
        assert_eq!(contents, "first\nsecond\n");
    }

    #[test]
    fn append_then_format_round_trips_a_readable_entry() {
        let tmp = tempdir().unwrap();
        let path = crash_log_path(tmp.path());
        let entry = format_crash_entry("2026-01-01T00:00:00Z", "main", "kapow", None, 4);
        append_crash_entry(&path, &entry).unwrap();
        let back = fs::read_to_string(&path).unwrap();
        assert_eq!(back, entry);
        assert!(back.contains("reaped sidecars: 4"));
    }

    #[test]
    fn panic_message_extracts_str_and_string_payloads() {
        // &str payload (the common `panic!("literal")` shape).
        let s: &str = "boom";
        assert_eq!(panic_message(&s), "boom");
        // String payload (e.g. `panic!("{}", x)`).
        let owned: String = "dynamic boom".to_string();
        assert_eq!(panic_message(&owned), "dynamic boom");
        // Non-string payload → the generic note (never panics in the hook).
        let other: i32 = 42;
        assert_eq!(panic_message(&other), "<non-string panic payload>");
    }
}
