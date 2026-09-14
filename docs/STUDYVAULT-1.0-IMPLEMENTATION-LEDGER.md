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
- Working branch: `codex/studyvault-1.0`.
- Product version: `1.0.0` across the package, backend, and OpenAPI contracts.
- Target: personal, local-only, manually installed Apple Silicon Mac application.
- Desktop runtime: Electron 43. Tauri references are historical only.

## Delivered workstreams

| Workstream | Candidate status | Evidence and remaining boundary |
| --- | --- | --- |
| Shared workspace shell | **Verified** | Today, Learn, Practice, Review, Progress, and Library share one responsive shell, context selector, search manifest, and preserved deep links. Host navigation tests and the visual matrix pass. |
| OpenDesign remap | **Verified** | OpenDesign run `471d4423-a1a7-44d5-8d72-7e91bdfe69f1` completed successfully and its prototype, design system, brand specification, and Vizier configuration were retrieved and integrated. |
| Declutter pass | **Verified** | Four independent screenshot judges passed hierarchy, mobile layout, study focus, and visually apparent accessibility. Today is action-first; Tutor is a focused reader/tutor split; Review is queue-first; Progress is summary-first. |
| Time-budgeted planner | **Verified** | Shared domain goals and time allocations migrate legacy profiles. Deterministic plans expose scheduled and backlog workload, rationale, availability, duration, reprioritization, postponement, and regeneration. |
| Persistent study sessions | **Verified** | Stable session IDs, checkpoints, elapsed time, current activity, save recovery, and exactly-once completion are covered by host tests and owned above routed pages. |
| Source-linked tutor | **Verified** | `/library/tutor` connects source selection, reading, notes, annotations, cited local tutoring, unsupported-answer handling, cancellation, retry, and saved results. |
| Mistake remediation | **Verified** | Incorrect and low-confidence attempts create durable deduplicated remediation entries and recoverable packet jobs while preserving LSAT blind review. |
| Local model routing | **Current** | LM Studio is the fresh-install default with discovery, capability reporting, timeouts, retry, streaming cancellation, and recovery guidance. Ollama remains supported and deterministic study works without either provider. A live user model was not prescribed or downloaded. |
| Storage continuity | **Verified in automation** | Dexie, SQLite, and optional SurrealDB remain supported. Storage conformance, migrations, duplicate recovery, and the 30-store archive export/wipe/import drill pass. A destructive upgrade against the user's personal vault was not performed. |
| Electron foundation | **Current** | Electron tests, sidecar provenance, arm64 packaging, ad-hoc signing, clean-profile launch, restart, and profile-directory reuse pass. Physical sleep/wake and a packaged LSAT sidecar recovery drill remain native manual checks. |

## Acceptance evidence

| Gate | Command or artifact | Result |
| --- | --- | --- |
| Host + LSAT + Electron + build | `npm run verify:all` | **Verified** — lint has 0 errors; host 160 files / 1,692 pass / 2 skip; LSAT 60 files / 297 pass; Electron 59 pass / 1 platform skip; production build passes. |
| Backend | `uv run --group dev pytest -q` | **Verified** — completed at 100%; only upstream SWIG deprecation warnings. |
| Content | `npm run content:validate` | **Verified** — 0 errors, 0 active warnings; Levels I–III have 0% leading-token giveaway and pass diversity thresholds. |
| API contract | `npm run contract:check:client` | **Verified** — generated client is current and covers 230/230 backend paths. |
| Local-only boundaries | no-egress, sidecar-fetch, provenance, and version checks | **Verified** — 703 shipped files scanned, no new direct sidecar fetches, provenance 1/1, all versions `1.0.0`. |
| Backup and restore | `npm run vault-archive:drill` | **Verified** — export, wipe, and import reproduced the original 30-store archive. |
| Visual acceptance | Vizier `pr` matrix, run `run_b5d07646c530e966` | **Verified** — authoritative `pass`, score 100, 21/21 surfaces and 525/525 required checks, 0 new issues, 0 warnings, no waivers. Reviewed baseline: `run_d268883402d927c3`. |
| Accessibility | `npm run a11y:check` plus Vizier axe/keyboard/reduced-motion checks | **Verified** — desktop/mobile light and dark routes, synthetic source states, contrast fixtures, OS increased contrast, and forced-colors all pass. |
| Mutation floor | local host + backend mutation run | **Verified locally** — 12/12 mutants killed, score 100%. Final CI evidence remains pending. |
| Apple Silicon package | `release-debug/StudyVault-1.0.0-mac-arm64-adhoc.zip` | **Verified development artifact** — the extracted app is arm64, strict code-sign verification passes with an ad-hoc signature, and clean-profile launch and restart were observed. It is not Developer ID signed or notarized. |
| Full CI | GitHub workflow on the final revision | **Pending** — this working candidate has not been pushed. |

## Visual evidence

Final route captures live under `artifacts/ui/`. The desktop and mobile contact sheets show Today, Tutor, Review, and Progress at the approved first viewport. The immutable Vizier baseline set `studyvault-1.0` records every configured route at desktop, tablet, and mobile sizes with the review reason.

## Release boundary

StudyVault 1.0 remains a personal, local-only Mac daily driver. Accounts, cloud sync, payments, public distribution, and automatic updates are outside this release. The development app is ad-hoc signed and is not evidence of Developer ID signing or notarization. Physical sleep/wake, packaged sidecar recovery, and final GitHub CI must be reported separately if performed.
