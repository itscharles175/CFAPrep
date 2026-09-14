# StudyVault 1.0 — Implementation and Acceptance Ledger

This document is the current source of truth for the StudyVault 1.0 finish-line round. Historical wave and polish roadmaps remain design records; their checkboxes are not release evidence.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Verified** | The named behavior or check passed against this working candidate or its named artifact. |
| **Current** | The capability is implemented, with a remaining native or external acceptance step stated explicitly. |
| **Pending** | Implementation or acceptance evidence is still required. |
| **Blocked** | A named failure prevents acceptance. |

## Candidate

- Baseline: `4b4f055f78f44d752a4053d18321fe0c75bb046c`.
- Working branch: `dev`.
- Product version: `1.0.0` across the package, backend, and OpenAPI contracts.
- Target: personal, local-only, manually installed Apple Silicon Mac application.
- Desktop runtime: Electron 43. Tauri references are historical only.

## Delivered workstreams

| Workstream | Candidate status | Evidence and remaining boundary |
| --- | --- | --- |
| Shared workspace shell | **Verified** | Today, Learn, Practice, Review, Progress, and Library share one responsive shell, context selector, search manifest, and preserved deep links. Each curriculum remembers its workspace route, switches atomically, and retains a single active primary destination. |
| OpenDesign remap | **Verified** | OpenDesign run `471d4423-a1a7-44d5-8d72-7e91bdfe69f1` completed successfully and its prototype, design system, brand specification, and Vizier configuration were retrieved and integrated. |
| Declutter pass | **Verified** | Four independent screenshot judges passed hierarchy, mobile layout, study focus, and visually apparent accessibility. Today is action-first; Tutor is a focused reader/tutor split; Review is queue-first; Progress is summary-first. |
| Time-budgeted planner | **Verified** | Shared domain goals and time allocations migrate legacy profiles. Deterministic plans expose scheduled and backlog workload, rationale, availability, duration, reprioritization, postponement, and regeneration. |
| Persistent study sessions | **Verified** | Stable session IDs, checkpoints, elapsed time, current activity, save recovery, and exactly-once completion are covered by host tests and owned above routed pages. |
| Source-linked tutor | **Verified** | `/library/tutor` connects source selection, reading, notes, annotations, cited local tutoring, unsupported-answer handling, cancellation, retry, and saved results. |
| Mistake remediation | **Verified** | Incorrect and low-confidence attempts create durable deduplicated remediation entries and recoverable packet jobs while preserving LSAT blind review. |
| Local model routing | **Current** | LM Studio is the personal-release default with loopback discovery and capability-aware selection of already-loaded chat, critic, and embedding models. Ollama remains supported and deterministic study works without either provider. No model is prescribed or downloaded. |
| Storage continuity | **Verified in automation** | Dexie, SQLite, and optional SurrealDB remain supported. Storage conformance, migrations, duplicate recovery, and the 30-store archive export/wipe/import drill pass. A destructive upgrade against the user's personal vault was not performed. |
| Electron foundation | **Current** | The candidate implements the unified title bar, Mac menus and Dock routing, validated window restoration, typed lifecycle/navigation events, Keychain-gated LSAT startup, loopback-only egress, a native arm64 watchdog, and durable owned-sidecar recovery. Exact signed-package, installed-app, performance, and physical sleep/wake acceptance remain pending. |

## Acceptance evidence

| Gate | Command or artifact | Result |
| --- | --- | --- |
| Host + LSAT + Electron + build | `npm run verify:all` | **Verified** — lint has 0 errors; host 167 files / 1,744 pass / 2 skip; LSAT 64 files / 305 pass; Electron 74 pass / 1 platform skip; production build passes. |
| Backend | `uv run --group dev pytest -q` | **Verified** — completed at 100%; only upstream SWIG deprecation warnings. |
| Content | `npm run content:validate` | **Verified** — 0 errors, 0 active warnings; Levels I–III have 0% leading-token giveaway and pass diversity thresholds. |
| API contract | `npm run contract:check:client` | **Verified** — generated client is current and covers 230/230 backend paths. |
| Local-only boundaries | no-egress, sidecar-fetch, provenance, and version checks | **Verified** — 703 shipped files scanned, no new direct sidecar fetches, provenance 1/1, all versions `1.0.0`. |
| Backup and restore | `npm run vault-archive:drill` | **Verified** — export, wipe, and import reproduced the original 30-store archive. |
| Visual acceptance | final Vizier `standard` matrix | **Pending** — historical runs remain useful comparison evidence, but an authoritative `standard` pass must be produced from the final clean commit. |
| UI polish follow-up | Vizier `pr` delta, run `run_0957c0b455e9623c` | **Verified** — Today, Review, Progress, and Tutor pass at desktop, tablet, and mobile: score 100, 12/12 surfaces, 300/300 required checks, 0 issues, and 0 warnings. Four independent agents reviewed motion, interaction, visual hierarchy, and accessibility/performance before remediation. |
| Assessment and Vault final polish | Vizier `pr` delta, run `run_a10d580395b0ab93` | **Verified** — the complete configured matrix passes authoritatively at score 100: 21/21 route surfaces, 525/525 required checks, 0 issues, 0 warnings, and no waivers. CFA assessment chrome is focus-first, the empty Vault leads with import, CFA dashboard typography and surfaces are normalized, and active navigation is unambiguous. |
| Accessibility | `npm run a11y:check` plus Vizier axe/keyboard/reduced-motion checks | **Verified** — desktop/mobile light and dark routes, synthetic source states, contrast fixtures, OS increased contrast, and forced-colors all pass. |
| Mutation floor | local host + backend mutation run | **Verified locally** — 12/12 mutants killed, score 100%. Final CI evidence remains pending. |
| Apple Silicon package | final `release-personal/` app, ZIP, and DMG | **Pending** — historical development artifacts do not prove this candidate. The final exact arm64 bundle must be fused, ad-hoc signed, strictly verified, captured, performance-tested, and installed at `/Applications/StudyVault.app`. |
| Full CI | GitHub workflow on the final revision | **Pending** — this working candidate has not been pushed. |

## Visual evidence

The current renderer review is recorded in `final-curriculum-review-v2` and corrected onboarding evidence in `final-curriculum-review-v3` under the Codex visualization workspace. Independent Terra and Luna judges passed curriculum continuity, compact layouts, onboarding, global Review/Progress scope, and truthful offline/sample states after the final breadcrumb-ellipsis correction. Native title-bar and traffic-light evidence must come from the exact signed app.

## Release boundary

StudyVault 1.0 remains a personal, local-only Mac daily driver. Accounts, cloud sync, payments, public distribution, and automatic updates are outside this release. The final personal app will be ad-hoc signed; this is neither Developer ID signing nor notarization. Physical sleep/wake, exact packaged sidecar recovery, installed-app checks, and final GitHub CI must be reported only when their evidence exists.
