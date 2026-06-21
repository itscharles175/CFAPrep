//! NATIVE-1 — boot-time STALE-PORT SWEEP.
//!
//! Before the supervisor spawns its sidecars, sweep every OWNED sidecar port and
//! kill any leftover process squatting it. This is the recovery path for an
//! orphan that survived a prior hard-kill on a platform WITHOUT the Job Object
//! net (or before the Job Object existed): a stale SurrealDB / `uv` tree / frozen
//! LSAT backend still holding :8000 / :5055 / :8100 would otherwise make the
//! fresh launch fail to bind.
//!
//! Design for testability + safety:
//!   * The port→pid discovery and the kill are behind a [`PortSweeper`] trait so
//!     the sweep ORCHESTRATION (which ports, in what order, skip-if-free) is
//!     unit-tested with a mock that never touches the real process table.
//!   * The production [`SystemSweeper`] discovers the squatting pid per-platform
//!     (Windows: parse `netstat -ano`; Unix: `lsof -ti`) and kills the whole tree.
//!   * SAFE BY DEFAULT: a port with NO listener is skipped (nothing to kill); we
//!     never kill our OWN pid (the app), and the sweep is best-effort — a failure
//!     to discover or kill is logged, not fatal, so boot always proceeds.

use std::collections::HashSet;

/// Outcome of one port's sweep, returned so the orchestrator (and tests) can see
/// exactly what happened on each owned port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SweepAction {
    /// No process was listening on the port — nothing to do.
    Free,
    /// A squatter was found and a kill was issued for its pid(s).
    Killed { port: u16, pids: Vec<u32> },
    /// A squatter was found but the kill failed (logged; boot proceeds anyway).
    KillFailed { port: u16, pids: Vec<u32> },
    /// The port was skipped because its only listener is OUR OWN process (self).
    SkippedSelf { port: u16, pid: u32 },
}

/// Seam over the OS-specific "who holds this port?" + "kill this pid" operations.
/// Production uses [`SystemSweeper`]; tests use a mock.
pub trait PortSweeper {
    /// Return the pid(s) currently LISTENING on `port` (empty when the port is
    /// free). May return several on platforms where multiple pids share a socket.
    fn pids_on_port(&self, port: u16) -> Vec<u32>;

    /// Force-kill `pid` (and, in the production impl, its descendant tree).
    /// Returns whether the kill is believed to have succeeded.
    fn kill(&self, pid: u32) -> bool;
}

/// Sweep the given owned `ports` using `sweeper`, never killing `self_pid` (the
/// app's own process). Pure orchestration — fully unit-testable via a mock
/// `PortSweeper`. Returns one [`SweepAction`] per port, in input order.
///
/// For each port: discover its listener pid(s); if none, `Free`; if the ONLY
/// listener is `self_pid`, `SkippedSelf` (never suicide); otherwise kill every
/// foreign pid and report `Killed` / `KillFailed`.
pub fn sweep_ports<S: PortSweeper>(sweeper: &S, ports: &[u16], self_pid: u32) -> Vec<SweepAction> {
    let mut out = Vec::with_capacity(ports.len());
    let mut seen = HashSet::new();
    for &port in ports {
        // Skip a duplicated port (the registry already dedups, but be defensive).
        if !seen.insert(port) {
            continue;
        }
        let pids = sweeper.pids_on_port(port);
        if pids.is_empty() {
            out.push(SweepAction::Free);
            continue;
        }
        // Never kill ourselves. If the only holder is us, skip; otherwise filter
        // self out of the kill set and kill the rest.
        let foreign: Vec<u32> = pids.iter().copied().filter(|&p| p != self_pid).collect();
        if foreign.is_empty() {
            out.push(SweepAction::SkippedSelf {
                port,
                pid: self_pid,
            });
            continue;
        }
        let mut all_ok = true;
        for &pid in &foreign {
            let ok = sweeper.kill(pid);
            if !ok {
                all_ok = false;
            }
        }
        if all_ok {
            out.push(SweepAction::Killed {
                port,
                pids: foreign,
            });
        } else {
            out.push(SweepAction::KillFailed {
                port,
                pids: foreign,
            });
        }
    }
    out
}

/// Production [`PortSweeper`] backed by the OS. Discovers squatters via the
/// platform's standard tooling and force-kills the tree.
pub struct SystemSweeper;

impl PortSweeper for SystemSweeper {
    fn pids_on_port(&self, port: u16) -> Vec<u32> {
        #[cfg(windows)]
        {
            windows_pids_on_port(port)
        }
        #[cfg(not(windows))]
        {
            unix_pids_on_port(port)
        }
    }

    fn kill(&self, pid: u32) -> bool {
        #[cfg(windows)]
        {
            // /T = kill tree, /F = force. Best-effort.
            std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            // SIGKILL the pid. (A full tree-kill on Unix needs a process group;
            // the squatter is typically the listener itself, so the direct kill
            // frees the port — matching the supervisor's existing Unix kill path.)
            std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }
}

/// Parse the LISTENING pid(s) for `port` from `netstat -ano` output (Windows).
/// Pulled out as a pure string parser so it's unit-testable without invoking
/// netstat. Matches rows whose local address ends in `:<port>` and whose state
/// is LISTENING, returning the trailing PID column.
#[cfg(windows)]
fn parse_netstat_listening_pids(output: &str, port: u16) -> Vec<u32> {
    let needle = format!(":{port}");
    let mut pids = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // netstat -ano TCP rows: Proto  Local  Foreign  State  PID
        if cols.len() < 5 {
            continue;
        }
        if !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        let local = cols[1];
        if !local.ends_with(&needle) {
            continue;
        }
        if !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            if pid != 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

#[cfg(windows)]
fn windows_pids_on_port(port: u16) -> Vec<u32> {
    let out = match std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    parse_netstat_listening_pids(&text, port)
}

/// Parse `lsof -ti :<port> -sTCP:LISTEN` output (Unix): one pid per line.
#[cfg(not(windows))]
fn parse_lsof_pids(output: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in output.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if pid != 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

#[cfg(not(windows))]
fn unix_pids_on_port(port: u16) -> Vec<u32> {
    let out = match std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port}"), "-sTCP:LISTEN"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    parse_lsof_pids(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Mock sweeper: returns scripted pids per port and records every kill.
    struct MockSweeper {
        pids: std::collections::HashMap<u16, Vec<u32>>,
        kill_fail_for: Vec<u32>,
        killed: RefCell<Vec<u32>>,
    }

    impl MockSweeper {
        fn new() -> Self {
            Self {
                pids: std::collections::HashMap::new(),
                kill_fail_for: Vec::new(),
                killed: RefCell::new(Vec::new()),
            }
        }
        fn with_port(mut self, port: u16, pids: Vec<u32>) -> Self {
            self.pids.insert(port, pids);
            self
        }
        fn failing_kill_for(mut self, pid: u32) -> Self {
            self.kill_fail_for.push(pid);
            self
        }
    }

    impl PortSweeper for MockSweeper {
        fn pids_on_port(&self, port: u16) -> Vec<u32> {
            self.pids.get(&port).cloned().unwrap_or_default()
        }
        fn kill(&self, pid: u32) -> bool {
            self.killed.borrow_mut().push(pid);
            !self.kill_fail_for.contains(&pid)
        }
    }

    #[test]
    fn sweep_reports_free_for_unoccupied_ports() {
        let sweeper = MockSweeper::new();
        let actions = sweep_ports(&sweeper, &[8000, 8100], 999);
        assert_eq!(actions, vec![SweepAction::Free, SweepAction::Free]);
        assert!(sweeper.killed.borrow().is_empty(), "nothing to kill");
    }

    #[test]
    fn sweep_kills_a_foreign_squatter() {
        let sweeper = MockSweeper::new().with_port(8100, vec![4242]);
        let actions = sweep_ports(&sweeper, &[8100], 999);
        assert_eq!(
            actions,
            vec![SweepAction::Killed {
                port: 8100,
                pids: vec![4242]
            }]
        );
        assert_eq!(*sweeper.killed.borrow(), vec![4242]);
    }

    #[test]
    fn sweep_never_kills_our_own_pid() {
        // The only listener on the port is US — must skip, never suicide.
        let self_pid = 1234;
        let sweeper = MockSweeper::new().with_port(8000, vec![self_pid]);
        let actions = sweep_ports(&sweeper, &[8000], self_pid);
        assert_eq!(
            actions,
            vec![SweepAction::SkippedSelf {
                port: 8000,
                pid: self_pid
            }]
        );
        assert!(sweeper.killed.borrow().is_empty());
    }

    #[test]
    fn sweep_filters_self_out_but_kills_other_holders() {
        let self_pid = 1234;
        // Port held by both us and a foreign pid: kill only the foreign one.
        let sweeper = MockSweeper::new().with_port(8000, vec![self_pid, 5555]);
        let actions = sweep_ports(&sweeper, &[8000], self_pid);
        assert_eq!(
            actions,
            vec![SweepAction::Killed {
                port: 8000,
                pids: vec![5555]
            }]
        );
        assert_eq!(*sweeper.killed.borrow(), vec![5555]);
    }

    #[test]
    fn sweep_reports_kill_failure_without_panicking() {
        let sweeper = MockSweeper::new()
            .with_port(8100, vec![4242])
            .failing_kill_for(4242);
        let actions = sweep_ports(&sweeper, &[8100], 999);
        assert_eq!(
            actions,
            vec![SweepAction::KillFailed {
                port: 8100,
                pids: vec![4242]
            }]
        );
    }

    #[test]
    fn sweep_dedups_repeated_ports() {
        let sweeper = MockSweeper::new().with_port(8100, vec![7]);
        let actions = sweep_ports(&sweeper, &[8100, 8100], 999);
        // Second occurrence is skipped → only one action, one kill.
        assert_eq!(
            actions,
            vec![SweepAction::Killed {
                port: 8100,
                pids: vec![7]
            }]
        );
        assert_eq!(sweeper.killed.borrow().len(), 1);
    }

    // ---- platform parsers ----

    #[cfg(windows)]
    #[test]
    fn netstat_parser_extracts_listening_pid_for_port() {
        let sample = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:8100         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:8100         127.0.0.1:51000       ESTABLISHED     9999
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
";
        // Only the LISTENING row on :8100 should match (not the ESTABLISHED one,
        // not the :445 row).
        assert_eq!(parse_netstat_listening_pids(sample, 8100), vec![4242]);
        assert!(parse_netstat_listening_pids(sample, 5055).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn netstat_parser_does_not_match_port_as_substring() {
        // :81000 must NOT match a query for port 100 via substring; the `:`
        // anchor guards against that.
        let sample = "  TCP    127.0.0.1:81000        0.0.0.0:0              LISTENING       55\n";
        assert!(parse_netstat_listening_pids(sample, 100).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn lsof_parser_extracts_one_pid_per_line() {
        let sample = "4242\n9999\n4242\n\n";
        assert_eq!(parse_lsof_pids(sample), vec![4242, 9999]);
    }
}
