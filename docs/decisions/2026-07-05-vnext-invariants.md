# vNext Roadmap Invariants

> Status: Accepted for the 2026 vNext roadmap execution.
> Date: 2026-07-05.

This record closes Wave 0 for the vNext roadmap by making the product
invariants explicit before broad implementation starts.

## Decisions

1. **SurrealDB is optional until packaging proves otherwise.**
   RAG-less builds must report a degraded state, not a hard error. RAG-enabled
   builds may require SurrealDB/open-notebook, but release summaries and runtime
   health must agree on which sidecars are required.

2. **Encrypted backups are default-on; live at-rest encryption is staged behind
   migration proof.**
   Backup/export artifacts must become encrypted by default first. Live
   IndexedDB/SQLite/Surreal encryption becomes default-on after sentinel tests,
   restore ordering, and lock/unlock UX are proven.

3. **Network egress is fail-closed by default.**
   Updaters, cloud model providers, Hugging Face/model downloads, and any
   non-loopback route require explicit user opt-in and must be logged by egress
   class without prompt or source content.

4. **Windows is the release-blocking desktop platform; other built platforms
   still require smoke evidence.**
   Windows installer smoke is mandatory before publishing a Windows artifact.
   macOS/Linux artifacts, when built, require at least unpacked app or bundle
   health smoke before release attachment.

5. **The backend unified planner is learner-facing authoritative; host planning
   is the offline fallback.**
   The UI should show one primary plan. When the LSAT sidecar is unavailable,
   the host plan may take over with explicit degraded-mode status.

6. **Generated learning material starts quarantined.**
   Generated questions, flashcards, explanations, and summaries may enter review
   only after source provenance, quality gates, confidence, and eligibility state
   are recorded.

## Required Alignment

- CI and release gates must enforce these decisions as the corresponding waves
  land.
- Any exception needs a later decision record that names the invariant being
  changed and the verification gate replacing it.
