//! NATIVE-8 — owned-port registry + sidecar identity handshake.
//!
//! Two related problems this module solves:
//!
//! 1. **Owned-port registry.** The supervisor must KNOW which ports + pids it
//!    owns ({service → port, pid}) so the boot-time stale-port sweep
//!    ([`crate::port_sweep`]) and the health probe can reason about ownership.
//!
//! 2. **Identity handshake.** A plain "is the port listening?" probe (the
//!    existing [`crate::is_port_listening`]) can be fooled: if a FOREIGN process
//!    is squatting an owned port (a leftover orphan, or an unrelated app that
//!    grabbed :8100), the TCP connect succeeds and the supervisor wrongly reports
//!    the sidecar "healthy". The fix: the health probe asks the listener to ECHO
//!    a service id + version (e.g. `GET /api/health` returns
//!    `{"service":"lsat-backend","version":"…"}`), and we only count it healthy
//!    if the echoed identity MATCHES what we expect for that service. A foreign
//!    squatter that returns the wrong (or no) identity is REJECTED.
//!
//! The identity-MATCH logic and the registry are pure + std-only, unit-tested
//! below. The actual HTTP fetch of `/api/health` is a thin I/O shim the
//! supervisor injects (so tests drive the match logic with synthetic payloads,
//! reusing the same Mock seams pattern as the launcher tests).

use std::collections::HashMap;

/// The identity the supervisor EXPECTS a given owned port to report. Built from
/// the sidecar spec when a port is claimed. A health probe's echoed identity must
/// match this for the port to count as "our sidecar, healthy".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedIdentity {
    /// Stable service id the sidecar echoes, e.g. "lsat-backend". Compared
    /// case-insensitively + trimmed so a cosmetic difference doesn't reject a
    /// genuine sidecar.
    pub service: String,
    /// Optional minimum/expected version string. `None` means "any version is
    /// acceptable as long as the service id matches" — used while the sidecars
    /// don't yet all echo a version. When `Some`, the echoed version must be
    /// present and equal (exact match; a future change can relax to semver-gte).
    pub version: Option<String>,
}

impl ExpectedIdentity {
    /// Build an expectation that accepts any version of `service`.
    pub fn any_version(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            version: None,
        }
    }
}

/// What a listening process actually echoed from its health endpoint. `None`
/// fields model a listener that answered but omitted the identity — which, under
/// the handshake, is treated as a FOREIGN/unknown process (rejected), not a
/// healthy sidecar.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EchoedIdentity {
    pub service: Option<String>,
    pub version: Option<String>,
}

impl EchoedIdentity {
    pub fn new(service: Option<String>, version: Option<String>) -> Self {
        Self { service, version }
    }
}

/// Result of matching an echoed identity against the expectation. Distinct
/// variants so the supervisor can log WHY a port was rejected (precise message)
/// rather than a flat "unhealthy".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityVerdict {
    /// Echoed identity matches the expected service (and version, if required).
    Match,
    /// The listener answered but echoed NO service id — a foreign process that
    /// doesn't speak our handshake. Rejected.
    MissingService,
    /// The listener echoed a DIFFERENT service id than expected. Rejected — a
    /// foreign process is squatting the owned port.
    ServiceMismatch { expected: String, got: String },
    /// Service matched but a required version was absent or different. Rejected
    /// conservatively (could be a stale/foreign build on the port).
    VersionMismatch {
        expected: String,
        got: Option<String>,
    },
}

impl IdentityVerdict {
    /// Whether this verdict counts the port as a healthy, OWNED sidecar.
    pub fn is_match(&self) -> bool {
        matches!(self, IdentityVerdict::Match)
    }
}

/// Pure identity-match: does what a listener `echoed` satisfy what we `expected`?
///
/// Rules (conservative — reject when in doubt so a foreign squatter is never
/// mistaken for our sidecar):
///   * service id is compared trimmed + case-insensitive;
///   * a missing echoed service id is always a rejection (`MissingService`);
///   * a different service id is `ServiceMismatch`;
///   * if the expectation requires a version, the echoed version must be present
///     and exactly equal, else `VersionMismatch`;
///   * if the expectation requires no version, any (or no) echoed version is fine
///     once the service id matches.
pub fn match_identity(expected: &ExpectedIdentity, echoed: &EchoedIdentity) -> IdentityVerdict {
    let got_service = match echoed.service.as_deref() {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => return IdentityVerdict::MissingService,
    };
    let exp_service = expected.service.trim();
    if !got_service.eq_ignore_ascii_case(exp_service) {
        return IdentityVerdict::ServiceMismatch {
            expected: exp_service.to_string(),
            got: got_service.to_string(),
        };
    }
    if let Some(exp_ver) = expected.version.as_deref() {
        match echoed.version.as_deref() {
            Some(got_ver) if got_ver.trim() == exp_ver.trim() => {}
            other => {
                return IdentityVerdict::VersionMismatch {
                    expected: exp_ver.to_string(),
                    got: other.map(|s| s.to_string()),
                };
            }
        }
    }
    IdentityVerdict::Match
}

/// Outcome of probing an owned port for identity (NATIVE-8), combining the
/// liveness signal with the identity handshake. The supervisor maps this to its
/// healthy/down decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortHealth {
    /// Port is listening AND echoed a matching identity — our healthy sidecar.
    Healthy,
    /// Port is not accepting connections — the sidecar is down.
    NotListening,
    /// Port is listening but a FOREIGN process answered (wrong/absent identity).
    /// Distinct from `NotListening` so the supervisor can log "foreign squatter
    /// on owned port" — the precise NATIVE-8 failure — rather than "down".
    Foreign(IdentityVerdict),
    /// Port is listening but the handshake is UNAVAILABLE (the sidecar doesn't
    /// echo an identity yet, or the probe couldn't run). Falls back to treating
    /// liveness as health — preserves today's behavior until backends adopt the
    /// handshake. Carries no rejection; it's an accepted "can't verify, alive".
    Unverified,
}

impl PortHealth {
    /// Whether this health state counts the sidecar as up. Both a verified match
    /// AND the unverified-but-listening fallback count as healthy; only
    /// `NotListening` and a `Foreign` squatter are "down".
    pub fn is_up(&self) -> bool {
        matches!(self, PortHealth::Healthy | PortHealth::Unverified)
    }
}

/// Seam over "ask the listener on this port to echo its identity". Production
/// fetches a small JSON health endpoint over loopback HTTP; tests supply a mock
/// that returns scripted echoes. Returning `None` models a listener that didn't
/// answer the identity request at all (→ `Unverified` fallback).
pub trait IdentityProbe {
    /// Fetch the echoed identity from the service listening on `port`, or `None`
    /// if no identity could be obtained (endpoint absent / unparseable / the
    /// sidecar doesn't speak the handshake yet).
    fn fetch_identity(&self, port: u16) -> Option<EchoedIdentity>;
}

/// Combine a liveness signal + an optional echoed identity into a [`PortHealth`]
/// verdict (NATIVE-8). Pure, so the supervisor's health decision is unit-testable
/// without a socket.
///
///   * not listening                       → `NotListening`
///   * listening, no identity echoed        → `Unverified` (accept; legacy net)
///   * listening, identity matches expected → `Healthy`
///   * listening, identity MISMATCHES       → `Foreign` (reject the squatter)
pub fn classify_port_health(
    listening: bool,
    expected: &ExpectedIdentity,
    echoed: Option<&EchoedIdentity>,
) -> PortHealth {
    if !listening {
        return PortHealth::NotListening;
    }
    match echoed {
        None => PortHealth::Unverified,
        Some(e) => {
            let verdict = match_identity(expected, e);
            if verdict.is_match() {
                PortHealth::Healthy
            } else {
                PortHealth::Foreign(verdict)
            }
        }
    }
}

/// The path the identity handshake fetches over loopback HTTP. The LSAT backend
/// already serves `GET /api/health`; SurrealDB + open-notebook may not, in which
/// case the probe gets no identity and the supervisor falls back to liveness
/// (`Unverified`) — preserving today's behavior until they adopt the handshake.
pub const IDENTITY_PATH: &str = "/api/health";

/// Extract a JSON string field's value from a flat JSON body WITHOUT a JSON
/// dependency (std-only). Conservative + tolerant: scans for `"key"` then the
/// next `:` then the next double-quoted string. Returns `None` if the key isn't
/// present or its value isn't a quoted string. Good enough for the handshake's
/// shallow `{"service": "...", "version": "..."}` shape; a malformed/foreign body
/// simply yields `None` (→ rejected or unverified, never a false match).
pub fn extract_json_string_field(body: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let key_pos = body.find(&needle)?;
    let after_key = &body[key_pos + needle.len()..];
    // Find the colon that separates key from value.
    let colon = after_key.find(':')?;
    let after_colon = &after_key[colon + 1..];
    // The value must be a quoted string. Skip leading whitespace, then require
    // the very next char to be the opening quote — otherwise this field's value
    // is NOT a string (e.g. `true`/a number) and we return None rather than
    // greedily skipping ahead to some LATER field's quoted value (which would
    // mis-attribute it). We don't handle escaped quotes — the identity fields are
    // simple ascii tokens, so a plain close-quote scan is sufficient + safe.
    let trimmed = after_colon.trim_start();
    let rest = trimmed.strip_prefix('"')?;
    let close = rest.find('"')?;
    Some(rest[..close].to_string())
}

/// Parse an echoed identity from a JSON health-endpoint body. Pulls the
/// `service` + `version` string fields (either may be absent). Pure + std-only so
/// it's unit-testable against fixture bodies.
pub fn parse_identity_body(body: &str) -> EchoedIdentity {
    EchoedIdentity::new(
        extract_json_string_field(body, "service"),
        extract_json_string_field(body, "version"),
    )
}

/// One entry in the owned-port registry: a service the supervisor launched, the
/// port it owns, the pid that holds it, and the identity it must echo to count
/// as healthy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedPort {
    pub service: String,
    pub port: u16,
    pub pid: u32,
    pub expected: ExpectedIdentity,
}

/// Registry of the ports + pids the supervisor owns (NATIVE-8). Keyed by service
/// name so a respawn can update the pid in place. Pure data structure — no I/O —
/// so the sweep + probe logic that consults it is fully unit-testable.
#[derive(Debug, Default, Clone)]
pub struct OwnedPortRegistry {
    by_service: HashMap<String, OwnedPort>,
}

impl OwnedPortRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim (or re-claim, on respawn) a port for a service. Overwrites any prior
    /// entry for the same service so the registry always reflects the live pid.
    pub fn claim(&mut self, entry: OwnedPort) {
        self.by_service.insert(entry.service.clone(), entry);
    }

    // The following lookups complete the registry's intended API and are
    // exercised by the unit tests below. `claim`/`owned_ports`/`len`/`new` are
    // consumed by the runtime supervisor today (seeding + logging the owned-port
    // map after startup); these reverse lookups are reserved for the respawn
    // pid-update + status-annotation wiring and a future explicit stop path, so
    // they're allow(dead_code) to keep the data structure coherent + fully tested
    // without fabricating a premature runtime caller.
    /// Release a service's claim (e.g. it was skipped or permanently stopped).
    #[allow(dead_code)]
    pub fn release(&mut self, service: &str) -> Option<OwnedPort> {
        self.by_service.remove(service)
    }

    /// Look up the claim for a service, if any.
    #[allow(dead_code)]
    pub fn get(&self, service: &str) -> Option<&OwnedPort> {
        self.by_service.get(service)
    }

    /// Whether `port` is owned by ANY tracked service.
    #[allow(dead_code)]
    pub fn owns_port(&self, port: u16) -> bool {
        self.by_service.values().any(|e| e.port == port)
    }

    /// The service that owns `port`, if any.
    #[allow(dead_code)]
    pub fn service_for_port(&self, port: u16) -> Option<&str> {
        self.by_service
            .values()
            .find(|e| e.port == port)
            .map(|e| e.service.as_str())
    }

    /// All distinct owned ports (for the boot-time stale-port sweep to consult).
    pub fn owned_ports(&self) -> Vec<u16> {
        let mut ports: Vec<u16> = self.by_service.values().map(|e| e.port).collect();
        ports.sort_unstable();
        ports.dedup();
        ports
    }

    /// Number of tracked services.
    pub fn len(&self) -> usize {
        self.by_service.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.by_service.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- match_identity ----

    #[test]
    fn identity_matches_when_service_equal_and_no_version_required() {
        let expected = ExpectedIdentity::any_version("lsat-backend");
        let echoed = EchoedIdentity::new(Some("lsat-backend".into()), Some("9.9".into()));
        assert_eq!(match_identity(&expected, &echoed), IdentityVerdict::Match);
        assert!(match_identity(&expected, &echoed).is_match());
    }

    #[test]
    fn identity_match_is_case_insensitive_and_trimmed() {
        let expected = ExpectedIdentity::any_version("LSAT-Backend");
        let echoed = EchoedIdentity::new(Some("  lsat-backend  ".into()), None);
        assert_eq!(match_identity(&expected, &echoed), IdentityVerdict::Match);
    }

    #[test]
    fn identity_rejects_missing_service_id() {
        // A foreign listener that answers but echoes no service id is rejected —
        // this is the squatter case the handshake exists to catch.
        let expected = ExpectedIdentity::any_version("lsat-backend");
        let none = EchoedIdentity::new(None, Some("1.0".into()));
        assert_eq!(
            match_identity(&expected, &none),
            IdentityVerdict::MissingService
        );
        let blank = EchoedIdentity::new(Some("   ".into()), None);
        assert_eq!(
            match_identity(&expected, &blank),
            IdentityVerdict::MissingService
        );
    }

    #[test]
    fn identity_rejects_a_foreign_service_squatting_the_port() {
        let expected = ExpectedIdentity::any_version("lsat-backend");
        let foreign = EchoedIdentity::new(Some("some-other-app".into()), Some("2.0".into()));
        match match_identity(&expected, &foreign) {
            IdentityVerdict::ServiceMismatch { expected, got } => {
                assert_eq!(expected, "lsat-backend");
                assert_eq!(got, "some-other-app");
            }
            other => panic!("expected ServiceMismatch, got {other:?}"),
        }
        assert!(!match_identity(&expected, &foreign).is_match());
    }

    #[test]
    fn identity_requires_exact_version_when_expected_pins_one() {
        let expected = ExpectedIdentity {
            service: "open-notebook".into(),
            version: Some("0.3.1".into()),
        };
        // Right service, right version → match.
        let ok = EchoedIdentity::new(Some("open-notebook".into()), Some("0.3.1".into()));
        assert_eq!(match_identity(&expected, &ok), IdentityVerdict::Match);

        // Right service, wrong version → reject.
        let wrong = EchoedIdentity::new(Some("open-notebook".into()), Some("0.2.0".into()));
        match match_identity(&expected, &wrong) {
            IdentityVerdict::VersionMismatch { expected, got } => {
                assert_eq!(expected, "0.3.1");
                assert_eq!(got.as_deref(), Some("0.2.0"));
            }
            other => panic!("expected VersionMismatch, got {other:?}"),
        }

        // Right service, NO version echoed but one required → reject.
        let missing = EchoedIdentity::new(Some("open-notebook".into()), None);
        match match_identity(&expected, &missing) {
            IdentityVerdict::VersionMismatch { got, .. } => assert!(got.is_none()),
            other => panic!("expected VersionMismatch, got {other:?}"),
        }
    }

    // ---- OwnedPortRegistry ----

    fn entry(service: &str, port: u16, pid: u32) -> OwnedPort {
        OwnedPort {
            service: service.into(),
            port,
            pid,
            expected: ExpectedIdentity::any_version(service),
        }
    }

    #[test]
    fn registry_claims_and_looks_up_by_service_and_port() {
        let mut reg = OwnedPortRegistry::new();
        assert!(reg.is_empty());
        reg.claim(entry("LSAT backend", 8100, 4242));
        reg.claim(entry("SurrealDB", 8000, 111));

        assert_eq!(reg.len(), 2);
        assert_eq!(reg.get("LSAT backend").unwrap().pid, 4242);
        assert!(reg.owns_port(8100));
        assert!(reg.owns_port(8000));
        assert!(!reg.owns_port(9999));
        assert_eq!(reg.service_for_port(8100), Some("LSAT backend"));
        assert_eq!(reg.service_for_port(1234), None);
    }

    #[test]
    fn registry_claim_overwrites_pid_on_respawn() {
        let mut reg = OwnedPortRegistry::new();
        reg.claim(entry("LSAT backend", 8100, 100));
        // Respawn: same service + port, new pid.
        reg.claim(entry("LSAT backend", 8100, 200));
        assert_eq!(reg.len(), 1, "respawn must not duplicate the service");
        assert_eq!(reg.get("LSAT backend").unwrap().pid, 200);
    }

    #[test]
    fn registry_release_removes_a_claim() {
        let mut reg = OwnedPortRegistry::new();
        reg.claim(entry("open-notebook API", 5055, 7));
        let removed = reg.release("open-notebook API");
        assert_eq!(removed.unwrap().port, 5055);
        assert!(reg.release("open-notebook API").is_none());
        assert!(reg.is_empty());
    }

    #[test]
    fn registry_owned_ports_is_sorted_and_deduped() {
        let mut reg = OwnedPortRegistry::new();
        reg.claim(entry("c", 8100, 1));
        reg.claim(entry("a", 8000, 2));
        reg.claim(entry("b", 5055, 3));
        assert_eq!(reg.owned_ports(), vec![5055, 8000, 8100]);
    }

    // ---- classify_port_health (NATIVE-8 combined verdict) ----

    #[test]
    fn classify_not_listening_is_down() {
        let exp = ExpectedIdentity::any_version("lsat-backend");
        let h = classify_port_health(false, &exp, None);
        assert_eq!(h, PortHealth::NotListening);
        assert!(!h.is_up());
    }

    #[test]
    fn classify_listening_without_identity_is_unverified_but_up() {
        // The legacy fallback: a sidecar that doesn't echo identity yet is still
        // counted up off pure liveness, so today's behavior is preserved.
        let exp = ExpectedIdentity::any_version("lsat-backend");
        let h = classify_port_health(true, &exp, None);
        assert_eq!(h, PortHealth::Unverified);
        assert!(h.is_up());
    }

    #[test]
    fn classify_listening_with_matching_identity_is_healthy() {
        let exp = ExpectedIdentity::any_version("lsat-backend");
        let echoed = EchoedIdentity::new(Some("lsat-backend".into()), Some("9.0".into()));
        let h = classify_port_health(true, &exp, Some(&echoed));
        assert_eq!(h, PortHealth::Healthy);
        assert!(h.is_up());
    }

    #[test]
    fn classify_foreign_squatter_is_rejected_not_treated_healthy() {
        // THE NATIVE-8 POINT: a foreign process listening on our owned port must
        // be rejected (Foreign), not counted healthy just because the TCP connect
        // succeeded.
        let exp = ExpectedIdentity::any_version("lsat-backend");
        let foreign = EchoedIdentity::new(Some("totally-other-app".into()), None);
        let h = classify_port_health(true, &exp, Some(&foreign));
        assert!(matches!(h, PortHealth::Foreign(_)));
        assert!(!h.is_up(), "a foreign squatter must NOT count as up");
    }

    // ---- IdentityProbe seam ----

    struct MockProbe {
        echo: Option<EchoedIdentity>,
    }
    impl IdentityProbe for MockProbe {
        fn fetch_identity(&self, _port: u16) -> Option<EchoedIdentity> {
            self.echo.clone()
        }
    }

    // ---- JSON field extraction (std-only handshake parser) ----

    #[test]
    fn extract_json_string_field_pulls_simple_values() {
        let body = r#"{"ok": true, "service": "lsat-backend", "version": "9.0.3"}"#;
        assert_eq!(
            extract_json_string_field(body, "service").as_deref(),
            Some("lsat-backend")
        );
        assert_eq!(
            extract_json_string_field(body, "version").as_deref(),
            Some("9.0.3")
        );
        // Absent key → None.
        assert_eq!(extract_json_string_field(body, "missing"), None);
        // Non-string value (bool) → None (we only pull quoted strings).
        assert_eq!(extract_json_string_field(body, "ok"), None);
    }

    #[test]
    fn extract_json_tolerates_whitespace_and_ordering() {
        let body = "{ \"version\" :\n  \"1.2\" , \"service\":\"surreal\" }";
        assert_eq!(
            extract_json_string_field(body, "service").as_deref(),
            Some("surreal")
        );
        assert_eq!(
            extract_json_string_field(body, "version").as_deref(),
            Some("1.2")
        );
    }

    #[test]
    fn parse_identity_body_builds_echoed_identity() {
        let body = r#"{"service":"lsat-backend","version":"9.0.3"}"#;
        let echoed = parse_identity_body(body);
        assert_eq!(echoed.service.as_deref(), Some("lsat-backend"));
        assert_eq!(echoed.version.as_deref(), Some("9.0.3"));

        // A foreign body with neither field → all-None echo → MissingService on
        // match → rejected. (Guards that a random listener can't pass.)
        let foreign = parse_identity_body(r#"{"hello":"world"}"#);
        assert!(foreign.service.is_none());
        let exp = ExpectedIdentity::any_version("lsat-backend");
        assert_eq!(
            match_identity(&exp, &foreign),
            IdentityVerdict::MissingService
        );
    }

    #[test]
    fn parse_lsat_backend_health_response_verifies_identity() {
        let body = r#"{"ok":true,"service":"lsat-backend","version":"0.9.0"}"#;
        let echoed = parse_identity_body(body);
        let exp = ExpectedIdentity::any_version("lsat-backend");
        assert_eq!(
            classify_port_health(true, &exp, Some(&echoed)),
            PortHealth::Healthy
        );
    }

    #[test]
    fn parse_legacy_lsat_health_without_identity_stays_unverified() {
        let body = r#"{"ok":true}"#;
        let echoed = parse_identity_body(body);
        let exp = ExpectedIdentity::any_version("lsat-backend");
        assert_eq!(
            classify_port_health(true, &exp, Some(&echoed)),
            PortHealth::Foreign(IdentityVerdict::MissingService)
        );
        assert_eq!(
            classify_port_health(true, &exp, None),
            PortHealth::Unverified
        );
    }

    #[test]
    fn parse_wrong_lsat_health_service_is_foreign() {
        let body = r#"{"ok":true,"service":"other-service","version":"0.9.0"}"#;
        let echoed = parse_identity_body(body);
        let exp = ExpectedIdentity::any_version("lsat-backend");
        assert!(matches!(
            classify_port_health(true, &exp, Some(&echoed)),
            PortHealth::Foreign(IdentityVerdict::ServiceMismatch { .. })
        ));
    }

    #[test]
    fn identity_probe_seam_drives_classification() {
        let exp = ExpectedIdentity::any_version("lsat-backend");
        // Probe returns a matching echo → Healthy.
        let probe = MockProbe {
            echo: Some(EchoedIdentity::new(Some("lsat-backend".into()), None)),
        };
        let echoed = probe.fetch_identity(8100);
        assert_eq!(
            classify_port_health(true, &exp, echoed.as_ref()),
            PortHealth::Healthy
        );

        // Probe returns nothing → Unverified (legacy liveness fallback).
        let silent = MockProbe { echo: None };
        assert_eq!(
            classify_port_health(true, &exp, silent.fetch_identity(8100).as_ref()),
            PortHealth::Unverified
        );
    }
}
