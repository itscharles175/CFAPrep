# StudyVault 1.0 — Finish-Line Roadmap

> **Target:** a polished personal Mac daily driver for CFA, LSAT, Quant, and
> Excel. **Runtime:** Electron. **Data:** local-only Dexie, SQLite, and optional
> SurrealDB. **Model routing:** LM Studio first with Ollama compatibility; core
> study remains available without either provider.

This is the active roadmap. Use
[STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md](STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md)
for evidence and status. Older roadmap files document prior decisions and ideas;
their checked boxes do not prove current implementation or acceptance.

## 1. Recover the baseline

- Reproduce host, LSAT frontend, backend, Electron, content, contract, offline,
  restore, accessibility, visual, and packaging checks.
- Repair the scheduled backend mutation environment so its pytest preflight can
  run, then meet both mutation floors.
- Refresh the GitNexus index and use impact/change analysis for source edits.
- Fix inaccurate answer counts, hidden save failures, context-insensitive CFA
  shortcuts, and routed session loss while preserving recoverable user data.

## 2. Remap the workspace

- Integrate the complete OpenDesign bundle into a single persistent shell with
  six primary destinations: Today, Learn, Practice, Review, Progress, and
  Library.
- Add a persistent domain, CFA level/pathway, and study-goal selector. Keep
  settings, local-model setup, vault maintenance, and diagnostics in utilities.
- Preserve existing deep links and specialized domain tools through the route
  manifest. Consolidate duplicated shell, overlay, notification, and provider
  ownership.
- Apply the shared editorial design system to populated, loading, empty, error,
  provider-unavailable, and recovery states in light and dark themes.

## 3. Complete the adaptive loop

- Build a deterministic, time-budgeted daily plan from goals, available minutes,
  due reviews, weak objectives, and resumable sessions. Support reorder,
  postpone, regeneration, and visible selection rationale.
- Persist stable session IDs and checkpoints above routed pages. Resume after
  navigation or restart, preserve exam timing rules, and record completed
  attempts exactly once with retryable save failures.
- Connect sources, reading, annotations, notes, cited tutor conversations, and
  generated practice. Open citations at their locators and surface unsupported
  answers or missing coverage.
- Turn incorrect and low-confidence attempts into deduplicated remediation work
  that feeds the next plan and Progress while retaining LSAT blind review and
  CFA assessment behavior.
- Finish LM Studio discovery, health, capability routing, streaming,
  cancellation, and recovery while retaining Ollama and AI-free paths.

## 4. Accept the release candidate

- Pass host and LSAT typechecks/tests, backend coverage, Electron tests,
  production builds, content and contract gates, offline checks, mutation floors,
  and backup/restore scenarios on one final revision.
- Exercise fresh setup and existing-data upgrade across every domain, including
  interrupted generation, failed saves, absent local services, and offline use.
- Pass keyboard, focus, contrast, reduced-motion, responsive, and long-reading
  checks.
- Complete Vizier `ui_check` with the `standard` profile and an authoritative
  `gate.verdict` of `pass` against the actual routes and startup command.
- Build and launch the Apple Silicon package; verify restart, sleep/wake, sidecar
  recovery, and persistence. Record signing and notarization status accurately.

## Release boundary

StudyVault 1.0 is local-only and manually installed. Accounts, cloud sync,
payments, public distribution, and automatic updates remain outside this
release. A passing web build or unpacked Electron directory does not prove the
packaged Mac application, signing, notarization, native persistence, or visual
acceptance.
