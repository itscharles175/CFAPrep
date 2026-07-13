# 04 — Roadmap

Each phase is independently usable; later phases build on a proven base. The risky
AI generation is built last, on top of a working engine — mirroring the Jarvis
project's spike-first approach.

## Phase 0 — Spike (de-risk the stack glue)
Goal: prove Tauri + FastAPI sidecar + SQLite + Ollama all talk to each other.
- One hardcoded question rendered in the React Test-Mode screen.
- Take it; backend records an Attempt in SQLite.
- Hit Ollama `qwen3:8b` and **stream** a per-choice explanation into the UI via SSE.
- Measure TTFT and tokens/sec to confirm realtime explanation is comfortable.
Exit criteria: end-to-end take→explain works; streaming feels live.

## Phase 1 — Core engine (already more useful than most paid apps)
- Full data model (03-data-model.md).
- **Import wizard:** PDF → AI structuring → human-verify split view → commit →
  answer-key reconcile.
- Take a **section timed** (Test Mode: timer, flag, eliminator, highlighter, nav).
- **Blind Review** flow + 2×2 outcome routing.
- **Reveal + per-choice AI explanation** (Tier A).
Exit criteria: import a real PrepTest, take a section timed, blind-review it, get
AI explanations.

## Phase 2 — Analytics + error log
- By-type, timing heatmap, timed-vs-BR gap, difficulty curve, trap analysis.
- Wrong-answer journal with AI diagnosis.
- Dashboard with score trend + weakest types + AI Coach card.
Exit criteria: practice produces actionable diagnosis, not just a percentage.

## Phase 3 — SRS + drills
- FSRS scheduling; missed questions become due cards.
- Type-targeted drilling from the **real** bank first.
Exit criteria: closed learning loop — miss → review → resurface → master.

## Phase 4 — AI generation (the risky part, last)
- Offline/batch **Tier-B drill generation** with the full validation gate.
- Quarantine + manual-approve queue for low-confidence items.
- **Score predictor** using published raw→scaled tables for owned tests.
Exit criteria: generated drills pass the gate and are clearly segregated from
official content; predictor tracks real performance.

## Phase 5 — Polish
- Full timed **exam mode** (multi-section, real timing, section breaks).
- Themes, keyboard-map customization, export/backup.
- Optional: expose backend as an MCP tool so Jarvis can report study stats.

## Risks & mitigations
- **AI question quality (Tier B):** mitigated by offline bigger model + validation
  gate + quarantine; real questions remain the anchor.
- **PDF parsing variance across PrepTest layouts:** mitigated by the human-verify
  step; never auto-commit a parse.
- **VRAM (12 GB):** realtime path pinned to qwen3:8b (100% GPU); big models only
  offline where slowness is acceptable.
- **Scope creep:** Logic Games, writing sample, multi-user explicitly out of v1.
