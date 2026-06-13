# 22 — Grand Cross-Stack Roadmap

> **Status: planning + Wave-1 in progress.** A unifying, deliberately *expansive* roadmap across
> the whole stack, synthesized from a 7-domain audit of the live codebase (AI/ML, pedagogy, product,
> analytics, content, frontend/native, reliability/devex). It extends — does not replace — the
> per-area roadmaps (04 phases, 13 stack-upgrade, 16 R7, 17–21 UI). Every item is grounded in real
> modules. **Wave 1 in progress:** C1 percentile, C2 required-slope, C3 efficiency quadrant,
> C4 lucky-rate, H1 sqlite-vec backend, H2 FTS5 search, H8 OOM error type + keep-alive routing,
> A9 per-task model routing, G6 local crash capture. Other items remain unscheduled until a wave is
> committed.

## Guardrails (from [00-vision.md](00-vision.md) — non-negotiable)

Everything below is held to the locked vision. Re-stated so no item drifts:

- **Single self-studier. Offline-first, privacy-first desktop app.** No accounts/auth, multi-tenancy,
  cloud sync, hosted/Postgres backend, Docker-for-deploy, or mobile/web SaaS. These are *features*.
- **Realtime AI (explain/diagnose/tag) + embeddings + score prediction run strictly on the local
  machine.** The optional Anthropic **cloud** path serves *only* offline Tier-B generation/validation
  behind the R7 budget ledger — never realtime, never scoring. No new item depends on cloud.
- **Imported real PrepTests are the quality anchor.** AI content is `ai_generated`, gated, segregated,
  never feeds score prediction; `official` content never exports.
- **LR + RC only** (Logic Games retired). No writing-sample, no cloud TTS/ASR.
- **12 GB GPU:** realtime pinned to a small model; big models offline only.

## How to read this

Eight **tracks** (A–H), each a curated table (`V`=value H/M/L, `E`=effort S/M/L/XL). Five
**flagships** are the cross-cutting north-stars that tie tracks together. Five **waves** sequence the
work so foundations land before the things that depend on them. The roadmap is intentionally larger
than any single round — pick waves/flagships to schedule.

---

## ★ The five flagships (cross-cutting north-stars)

1. **The Retrieval-Grounded Tutor** — turn the explainer + coach from answer-checkers into a tutor
   that *remembers your misses*. Infra: real vector search (`sqlite-vec`) + keyword search (FTS5) →
   RAG-grounded explanations and coach → a staged **Socratic dialogue** with prediction-elicitation.
   Spans **A** (+ H-infra, C-insight, F-review).
2. **The Adaptive Ability Engine** — a unified IRT/Elo ability estimate driving ZPD-targeted item
   selection, difficulty-calibrated generation, learning-curve "*when will I master Flaw?*"
   projection, and a utility-optimized daily plan. Spans **B** (+ D, C).
3. **RC Parity** — RC is in-vision but the bank is LR-leaning. Two-column parse → a real RC passage
   corpus → RC-aware tagging → passage-first RC generation → RC semantic validators. Spans **E** (+ D).
4. **Trustworthy Diagnostics & Readiness** — "diagnostics, not vanity metrics," fully delivered:
   silent-regression alerts, careless-vs-concept decomposition, lucky-rate surveillance, percentile +
   required-slope forecasting, and an honest exam-day readiness simulation. Spans **C** (+ B).
5. **The Native Companion & Content Cockpit** — make it feel like a desktop product you trust: an
   always-on-top timer, tray SRS badge + scheduled notifications, multi-window study, and a
   content-health cockpit (near-dup clusters, coverage map, audit trail). Spans **G** + **E**.

---

## Track A — Retrieval & the AI Tutor

*Grounded in `ai.py`, `coach.py`, `embeddings.py`, `pregenerate.py`, `generation.py`, `eval.py`.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| A1 | **Passage into RC explanations** — route full passage text (char-budgeted) into `_explain_prompt`; today RC explains reason only over the stem. | H/S | `ai.py:_explain_prompt`, `embeddings.question_text` |
| A2 | **Trap-keyed miss RAG** — retrieve the user's recent errors sharing the current question's `trap_type` and inject as instructive parallels. | H/M | `embeddings.context_notes_for_question`, `AnswerChoice.trap_type` |
| A3 | **Coach RAG grounding** — feed the coach top-k excerpts of the user's *own past explanations* for its `recent_misses` (cite, don't summarize). | H/M | `coach.build_coach_context`, `Explanation` |
| A4 | **Socratic multi-turn dialogue** — persist a per-question conversation (nudge→eliminate→confirm→explain); reuse the `coach_chat` history pattern + a `QuestionConversation` table. | H/M | `ai.hint`, `ai.stream_explanation` |
| A5 | **Prediction elicitation before reveal** — capture "which do you think & why," then contrast it with the credited reasoning. Highest-leverage metacognition move. | H/S | A4; `ai._explain_prompt` (`chosen`) |
| A6 | **Argument-map extraction** — offline step emits `{premises, gap, conclusion}` JSON per explanation for an interactive structure view. | M/M | `pregenerate.py`, new `Explanation.argument_map_json` |
| A7 | **Opt-in "show reasoning"** — expose qwen3 `<think>` traces in a collapsible block instead of always stripping. | M/S | `ai._ThinkFilter` |
| A8 | **Explanation quality score + warm pool** — score cached explanations (`eval.score_explanation`), re-gen low-quality on idle, pre-warm weak-type questions first. | M/M | `pregenerate.py`, `eval.py`, `coach` weak types |
| A9 | **Per-task model routing + better embed model** — small fast model for tagging, keep diagnose 8B, explain 14B; bump embed to `nomic-embed-text-v1.5`. | M/S | `config`, `tagging._model_call`, `EMBED_MODEL_VERSION` |
| A10 | **Speculative decoding (opt-in)** — Ollama draft model for faster explain streaming, gated on VRAM headroom. | M/S | `llm/ollama.py`; ⚠ 12 GB VRAM constraint |
| A11 | **On-device LoRA tag/explain fine-tune** — once active-learning has ~200 confirmed tags. | M/XL | ⚠ borderline: advanced opt-in, separate training env; fully local |

**North-star (A): A1+A2+A3 (RAG) → A4+A5 (Socratic).** Built on existing `context_notes`/`history`/`focus_choice` seams; depends on H1 (sqlite-vec) for scale.

---

## Track B — Adaptive Learning Engine (pedagogy)

*Grounded in `srs.py`, `analytics.py` (mastery), `routers/drills.py`, `study_plan.py`, `bank_bootstrap.py`, `pedagogy.py`.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| B1 | **IRT/Elo ability (θ) model** — a unified cross-type ability estimate from attempt history + item difficulty; Elo as the lightweight O(1) online variant. | H/M | extends `analytics.mastery`; `Question.empirical_difficulty` |
| B2 | **ZPD-calibrated drill difficulty** — replace the four hand-tuned accuracy→band thresholds with a data-driven 60–85% target from `by_difficulty()`. | H/S | `drills._target_difficulty`, `analytics.by_difficulty` |
| B3 | **Max-information (CAT-style) selection** — score candidates by `P(1−P)` against θ; turns spread-select into an information-maximizing pass. | H/S | B1; `drills._spread_select` |
| B4 | **Interleaved multi-type drills** — mix the 2–3 weakest types in one block (Kornell & Bjork). `DrillBody.q_type=None` already hints at it. | H/S | `drills.create_drill`, `study_plan._weighted_targets` |
| B5 | **Confidence-calibration analytics** — per-type reliability curve from captured BR confidence; surface over/under-confidence. | H/S | `analytics.confidence_calibration`, `type_analytics` |
| B6 | **Error-taxonomy → remediation playlists** — map `ErrorLogEntry.reason` clusters to auto-built `Playlist`s featuring the relevant trap. | H/M | `analytics.error_reason_trends`, `Playlist`, `trap_type` |
| B7 | **Per-type learning curves + plateau detection** — power-law fit per type → trials-to-mastery, "stuck" flags. | H/M | extends `analytics.mastery`/`_split_trend` |
| B8 | **"When will I master X?" timeline** — combine B7 slope + posterior + cadence to project mastery dates. | H/M | B7, B1, `analytics.activity` |
| B9 | **Skill/prerequisite graph + mastery gating** — static LR/RC skill DAG gates harder types until prerequisites' CI-lower-bound clears. | H/M | `study_plan._weighted_targets`, `mastery.lower_bound` |
| B10 | **Utility-optimized daily plan** — replace the greedy task loop with a knapsack/utility packer over due-SRS + weak-types + deficits under the time budget. | H/M | `study_plan.daily_plan` |
| B11 | **Multi-week macro schedule** — exam-date countdown plan (remediation → timed+BR → simulations → taper) from forecast slope + gap + leech depth. | H/M | `analytics.forecast`, `pedagogy.concept_gap_queue`, `srs.leeches` |
| B12 | **Pacing & fatigue coaching** — per-type time budgets vs LSAT norms, session-scoped "bleeder" card, fatigue-aware alerts. | H/S | `analytics.pacing`/`timing`/`fatigue` |
| B13 | **Lapse-weighted recency exclusion + expand-contract concept-gap spacing** — smarter than the flat recency window / vanilla FSRS for high-stakes cards. | M/S | `drills._recently_seen_qids`, `srs`, `SRSCard.lapses` |
| B14 | **Reflection-prompt personalization + rest-day detector** — BR outcomes generate the metacognitive prompts; fatigue signature suggests a light day. | M/S | `pedagogy.route_outcomes`, `Reflection`, `analytics.activity` |

**North-star (B): B7+B2 (learning-curve + ZPD)** and **B10+B6+B14 (close the outcome→plan loop)** — pure analytics, no new model calls.

---

## Track C — Diagnostics, Forecasting & Readiness

*Grounded in `analytics.py`, `scoring.py`, `forecast.ts`, `readiness.ts`, reporting libs.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| C1 | **Percentile mapping on the forecast** — a baked LSAC concordance table → `projected_percentile` + band. | H/S | `scoring._CURVE` companion table |
| C2 | **Required-slope inversion** — "you need +1.8/wk, trending +0.6 → gap large"; feasibility flag. | H/S | `analytics.forecast` (3 arithmetic lines) |
| C3 | **Time-vs-accuracy efficiency quadrant** — label each type mastered / costly-right / cheap-wrong / struggling. | H/S | `analytics.by_type`, `pacing`, timing budgets |
| C4 | **Lucky-rate surveillance** — per-type fragile-knowledge rate from the 2×2 (timed-right/BR-wrong). | H/S | `analytics.blind_review_gap`/`blind_review_outcome` |
| C5 | **Careless-vs-concept decomposition** — cross `ErrorLogEntry.reason` × BR outcome × q_type. | H/M | `error_reason_trends`, `blind_review_outcome` |
| C6 | **Silent-regression alerts** — z-test rolling-7d vs 30d per type; fire when a type quietly degrades. | H/M | `analytics.by_type`, `AnalyticsAlerts` |
| C7 | **What-if impact calculator** — "+X on Assumption → projected scaled +Y" interactive slider. | H/M | `by_type`, `scoring.predict_scaled` |
| C8 | **Exam-day readiness simulation** — honest checklist (forecast vs target, BR gap, calibration, triage, SRS backlog) → binary `exam_ready`. | H/S | `forecast`, `blind_review_gap`, `pacing`, `study_plan` |
| C9 | **Exam-date-aware readiness model (backend)** — move `readiness.ts` to the backend; scale thresholds by days-to-exam. | H/M | `readiness.ts`, `study_plan`, `forecast` |
| C10 | **Per-section (LR/RC) forecasts** — parallel WLS fits → section-level projected scores + bands. | H/M | `_forecast_points`, `section-type-trends.tsx` |
| C11 | **Session debrief card + printable** — post-session 4-panel (focus, outcome funnel, vs-baseline, new traps). | H/M | `focus_quality`, `outcome-funnel`, `PrintReport` |
| C12 | **Pre-exam readiness PDF + per-type vs published norms** — last-day focus guide; "is 62% Flaw good?" context. | H/M-S | `weeklyReport.ts`, `mastery`, `scoring` norm table |
| C13 | **Kalman/state-space trend (opt)** — responsive level tracking + honest time-varying bands. | M/L | replaces `_wls` while keeping the honesty-first envelope |
| C14 | **Position/fatigue curve + trap-drift velocity + elimination depth** — finer diagnostics over existing event data. | M/M | `pacing`, `traps`, `elimination_insight`, `AttemptChoiceEvent` |

**North-star (C): C6+C5 (catch the invisible + explain the why)** and **C1+C2 (make the forecast a decision tool)** — almost all additive, official-only, zero schema churn.

---

## Track D — Generation & the Validation Gate (Tier-B quality)

*Grounded in `generation.py`, `gen_validators.py`, `eval.py`, `jobs.py`, `models.GenJob/GenCandidate`.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| D1 | **Type-complete LR validators** — add Flaw, Evaluate, Role, Method, PrincipleApply, PointAtIssue (today 7 of ~15 typed; the rest no-op pass). Flaw is the most dangerous gap. | H/M | `gen_validators._VALIDATORS` + critic seam |
| D2 | **RC semantic validators** — MainPoint coherence, Detail-basis, Inference-support; today RC has only the readability gate. | H/M | `generation` RC path, `gen_validators` |
| D3 | **Distractor-plausibility scoring** — critic rates each wrong choice as a trap; quarantine degenerate-distractor items. | H/M | `validate_candidate`, `_TRAP_HELP` |
| D4 | **Per-distractor type-specific defensibility probe** — negate/strengthen each distractor under the type's own criterion. | H/M | `gen_validators`, `_critique_prompt` |
| D5 | **IRT-calibrated difficulty check** — sanity-check the generator's claimed difficulty against nearest real-bank neighbors. | M/S | `embeddings.similar_questions`, `empirical_difficulty` |
| D6 | **Confidence-weighted gate (soft-reject queue)** — store a `gate_score`; near-miss candidates go to human review, not auto-quarantine. | M/M | `validate_candidate`, `GenCandidate.gate_scores` |
| D7 | **Passage-first RC generation** — generate+validate a passage once, then 3–4 varied RC questions against it; build a real RC `Passage` library (→ E5). | H/L | `generation.run_job`, `_ensure_ai_section`, `Passage` |
| D8 | **Stimulus reuse + difficulty-stratified jobs** — multiple question types over one LR stimulus; easy/med/hard variants for a real ramp. | M/M | `run_job`, `_gen_prompt` |
| D9 | **Eval harness as a real benchmark** — expand the golden corpus (3/type incl. error cases), add `stimulus_faithfulness`, persist `EvalRun`, weekly idle eval + drift alert, A/B on model switch. | H/M | `eval.GOLDEN_SET`/`run_eval`, idle hook |
| D10 | **Gate property + mutation tests** — Hypothesis over candidate dicts; `mutmut` on `validate_candidate` (highest-risk function in the repo). | H/M | `test_golden_regression.py` (5 fixed cases today) |
| D11 | **Prompt/program self-optimization** — eval-guided auto-tune of the explain system prompt; richer gate-failure coaching note. | M/M | `eval.run_eval`, `generation._coaching_note` |
| D12 | **Gate-time reasoning-trace persistence** — keep the critic's "why rejected" so the quarantine queue is actionable. | M/S | `validate_candidate`, `GenCandidate` |

**North-star (D): D1+D2+D3 (type-complete + RC + distractor)** — the quality moat for every future generation job; the critic seam already exists.

---

## Track E — Content Bank & RC Parity

*Grounded in `import_pdf.py`, `import_dataset.py`, `dataset_normalizers.py`, `bank_bootstrap.py`, `bank_export.py`, `embeddings.py`, `tagging.py`, `models.py`.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| E1 | **Two-column RC layout parse** — `get_text("blocks")` → cluster by x-midpoint; fixes the existing `TODO(multi-column)` and older-PrepTest RC import. | H/S | `import_pdf._page_text` |
| E2 | **Answer-key PDF parse** — extract a tabular key page automatically; removes the highest-friction transcription step. | H/S | `reconcile_answer_key`, `commit_issues` |
| E3 | **Bulk re-reconcile + flag-for-key-review** — fix a mis-keyed committed PrepTest without re-import; re-evaluate `Attempt.is_correct`; audit-logged. | H/M | `reconcile_answer_key`, `AuditLog` |
| E4 | **RC passage corpus** — extract/embed/cluster unique research passages, set `Passage.topic`/`type`; gives RC tagging + generation a real foundation. | H/M | `Passage` (topic/type null today), `dataset_normalizers` |
| E5 | **RC-aware tagging** — RC heuristics + an RC model prompt that includes the passage; today research RC lands at the "Detail" fallback. | H/M | `tagging._RC_PROMPT_PATTERNS` |
| E6 | **Trap-type tagging for official questions** — run a trap-only pass on the quality anchor so trap analytics work on real PrepTests. | H/S | `tagging.batch_tag(only_research=False)` |
| E7 | **Richer LR heuristics + confidence bands** — push heuristic coverage ~60→80%, add a per-question confidence score for the review queue. | H/S | `tagging._LR_PROMPT_PATTERNS`, `tag_confidence` |
| E8 | **Content-health cockpit** — near-duplicate clusters (union-find over cosine ≥0.93), length-tell/lexical-leak audit on the whole bank, `q_type×difficulty×source` coverage map, tag-confidence + passage-coverage health. | H/M | `embeddings.similar_questions`, `gen_validators` leak, `bank_stats` |
| E9 | **Wire AuditLog + content versioning** — the table exists but nothing writes to it; recompute `content_hash` on edit, power undo. | M/S | `AuditLog` (unused), `commit_structure` |
| E10 | **Coverage-gap → planned-GenJob bridge** — idle hook runs `plan_generation_jobs` daily, enqueues `planned` jobs for user approval (closes the loop with D). | M/S | `bank_bootstrap.plan_generation_jobs`, `GenStatus.planned` |
| E11 | **Broaden ingestion + source registry + drift validation** — LogiQA 2.0 / RACE / DREAM; per-source quality + license; promote `validate_rows` to a blocking pre-import check. | H-M/S | `import_dataset.DATASETS`, `validate_rows` (currently uncalled) |
| E12 | **Per-row provenance scoring + per-source difficulty bias** — weighted trust feeding selection/anchors; correct AGIEval's easiness bias. | M/M | new `Question.provenance_score`, `empirical_difficulty` |
| E13 | **JSONL / DOCX import + heuristic RC section detection** — power-user bulk import; the heuristic structurer stops hardcoding `LR`. | M/S | `read_jsonl`, `_ai_structure`, `_heuristic_structure` |

**North-star (E): E4+E5+E1+D7 (RC end-to-end)** and **E8+E9+E11-drift (the content-trust cockpit)** — both built almost entirely from data already present.

---

## Track F — Study Experience & Authoring (product)

*Grounded in routers (`sessions`, `exam_routes`, `drills`, `playlist_routes`, `content`, `annotation_routes`, `error_log`, `mcp_server`) + the pages/components.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| F1 | **"Why did I pick this?" in Blind Review** — in-place trap explanation (`focus_choice=chosen`) without leaving the BR queue. | H/M | `BlindReview/revealed-block`, `ai_routes` (focus_choice exists) |
| F2 | **Per-choice rationale capture at reveal** — short "why I picked this" stored on the attempt; rich training signal for the coach. | H/M | `sessions.blind_review`, additive `Attempt.br_note` |
| F3 | **Cloze + pattern flashcards from concept-gaps** — auto-build fill-in cards from the concept-gap queue and error clusters; render in SRS. | H/L | `pedagogy.concept_gap_queue`, `srs`, `Srs.tsx` |
| F4 | **Inline question editor** — edit q_type/difficulty/curator-note on any bank row (audit-logged); closes the mis-tag loop without Jarvis. | H/M | `Bank.tsx`, `audit.record_edit`, `content` PATCH |
| F5 | **Hand-write a question + edit/override explanation** — manual entry (`source=research`) via the normalizer path; user-authored explanations (`ExplanationSource.user`). | H/M | `import_dataset`, `Explanation`, `ai_routes` PATCH |
| F6 | **DB-backed notebook + full-text search + LR "rules & tells" wiki** — move notes to the `Annotation` model, add search, build a personal pattern reference linked to q_types. | H/M | `annotation_routes` (scope/ref_id/data_json), FTS5 (H) |
| F7 | **Annotation tags/filters + cross-question links** — "see also Q42 (same trap)"; opaque `data_json` so zero schema change. | M/S | `annotations-hub`, `Explanation` sidebar |
| F8 | **Exam-mode polish** — experimental (unscored) section at a random position; combined per-section scaled **report** with curve origin + experimental flag; resumable break timer; kiosk lock. | H/M | `exams.create_exam`/`exam_results`, `Exam.tsx` |
| F9 | **Reflection rituals (pre-intent + post-debrief) + Zen mode** — make reflection first-class; distraction-free single-question view (reuse `theme-focus`). | H/M-S | `Reflection`, `Ceremony`, `section-runner` |
| F10 | **Command palette depth + macros + keybinding editor** — page-scoped actions, saved drill macros, remappable exam keys. | M/M | `command-palette` (register API), `keyboardMap` |
| F11 | **MCP/Jarvis expansion** — `get_session_detail`, `search_annotations`, `get_error_patterns`, `create_playlist` (guarded-write, provenance-safe). | H/M | `mcp_server` (read + guarded-write pattern) |
| F12 | **Share/export AI-only flashcard deck (Anki TSV)** — `ai_generated`/`research` only; firewall already blocks `official`. | M/M | `bank_export` firewall, `QuestionSource` |

**North-star (F): F1+F2+F3 (close the BR loop to "why")** and **F6 (a durable, searchable knowledge base)** — the studier's compounding asset.

---

## Track G — Native Companion & Frontend/UX

*Grounded in `src-tauri/{lib.rs,tauri.conf.json,capabilities}`, `lib/tauri.ts`, the design system, visx viz, `error-boundary.tsx`, perf libs.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| G1 | **Always-on-top detached timer window** — floating `SectionClock` on any screen; `WebviewWindow` + storage-event sync already proven by `PassagePopout`; capability already granted. ⚑ build-verify. | H/M | `lib/tauri.ts:89`, `capabilities/default.json` |
| G2 | **Tray SRS-due badge + scheduled OS notifications** — native nudge that makes the habit stick; `notify()` already wired, `useSrsDue` has the count. ⚑ build-verify. | H/M-L | `lib.rs` tray, `lib/tauri.ts:119`, `prefs` |
| G3 | **Multi-window: pop-out coach + branded passage popout** — second-monitor study; reuse single-instance/tray event model + `Titlebar`. ⚑ build-verify. | M/L-S | `lib.rs:297`, `tauri.ts:89`, `PassagePopout` |
| G4 | **Native app menu + `lsatlab://` deep-link** — File/View/Window/Help with shortcuts; notification/tray taps deep-link into a route. ⚑ build-verify. | M/M | `lib.rs:9`, `tauri.conf.json` protocols |
| G5 | **In-app update UI + release channels + CI pubkey guard** — `SystemNotice` update banner w/ progress + notes; assert the placeholder pubkey can't ship. | H-M/S-M | `tauri.conf.json` updater, `system-notice`, `release.yml` |
| G6 | **Local crash capture → Diagnostics** — `ErrorBoundary.componentDidCatch` persists last crash to localStorage; surface in `DiagnosticsPanel` + open-log-folder. Fully local. | H/S | `error-boundary.tsx`, `diagnostics-panel`, `tauri.ts` |
| G7 | **Perf at 10k items** — memoize CommandPalette + Analytics contexts (hottest re-renders), lazy `cmdk`/markdown via Suspense, `VirtualList.scrollToIndex`. | H-M/S | `command-palette`, `Analytics.tsx`, `virtual-list` |
| G8 | **Interactive viz + a11y depth** — KPI cross-filter, chart annotations/draw-on, `role=grid` + keyboard nav on heatmaps, Sankey ARIA, SRS-flip live region. | H-M/S | `KpiRow`, `chart-kit`, `ContributionHeatmap`, viz/* |
| G9 | **Design-system maturation** — density tokens reach tables, `DialogFooter` primitive + `--card-pad`, high-contrast glass/Mica fallback, a 5th dark-reading theme, accent picker. | M/S | `list-row`, `dialog`, `index.css`, `appearance-settings` |
| G10 | **Print stylesheets fixed** — print-safe chart widths (visx `ParentSize` renders 0×0 in print today), `@page` rules, BR-worksheet preview + native save. | H-M/S | `PrintReport`, `br-worksheet-export`, `index.css` |
| G11 | **First-run polish** — static "Starting…" frame before React mounts (kills the blank flash on a slow sidecar), NSIS start-menu/desktop shortcuts. ⚑ build-verify. | M/S | `index.html`, `lib.rs:501`, `tauri.conf.json` nsis |
| G12 | **Motion choreography + bundle trim** — `domMax`→`domAnimation` + scoped layout groups (~12 KB), Analytics first-reveal stagger, in-page `layoutId` morphs, motion tokens everywhere. | M/M | `motion-provider`, `motion.ts`, `animated-list` |

**North-star (G): G1 (always-on-top timer)** — the feature that most makes it a native product; **G6 (local crash capture)** — 5 lines that turn invisible crashes into diagnostics.

---

## Track H — Reliability, Scale & DevEx (the foundation)

*Grounded in `db.py`, `migrations.py`, `jobs.py`, `observability.py`, `doctor.py`, `backup.py`, `embeddings.py`, tests/CI, `llm/base.py`.*

| ID | Initiative | V/E | Notes & grounding |
|----|-----------|-----|-------------------|
| H1 | **`sqlite-vec` ANN index** — replace O(n) Python cosine (≈120 ms at 12k) via the existing `VectorStore` protocol; stable Windows wheel now. Unblocks RAG (A) + dedup (E) at scale. | H/M | `embeddings.py` (`VectorStore`/`SQLiteVectorStore`), m010 blob |
| H2 | **FTS5 search over questions + notes/explanations** — the missing keyword-recall mode; always-compiled, trigger-synced virtual table. Powers F6 + coach recall. | H/M | new migration; `Question`/`AnswerChoice`/`ErrorLogEntry`/`Explanation` |
| H3 | **Pagination on every list endpoint (keyset)** — sessions/error-log/preptests/quarantine/vectors are unbounded; keyset cursors compose with existing `order_by(id)`. | H/M | `routers/*`, `import_routes` (has the limit pattern) |
| H4 | **Composite-index audit + EXPLAIN-plan harness** — `attempt(question_id, created_at)`; pytest assertions on the 5 hottest queries to catch index regressions. | M/S | `migrations` m004/m011, `analytics`, `embeddings` |
| H5 | **Schema-snapshot + up-from-old-DB migration tests** — golden DDL fixture + a committed old-schema `.db` that runs forward; catches the #1 desktop breakage (fresh-passes, upgrade-breaks). | H/S-M | `test_migrations.py`, `_ADDITIVE_COLUMNS`, `run_migrations` |
| H6 | **Job queue: cancel + priority + per-job progress + cron scheduler** — `queued→cancelled`, `priority` ordering, a single-job/SSE progress endpoint, a `ScheduledTask` registry for idle maintenance. | M/S-M | `jobs.py`, `GenJob/GenStatus`, `main.make_idle_hook` |
| H7 | **GenJob archival/pruning** — retire old terminal jobs so the polled `ix_genjob_status` scan + queue views stay fast. | M/S | `jobs._next_queued_id`, `GenJob` |
| H8 | **Model warm/unload + OOM resilience** — explicit Ollama `keep_alive` pin/unload around study vs generation; detect OOM as a distinct non-retryable error (today all 5xx retried). | H/S | `llm/ollama.py`, `llm/base.is_transient`, `time_llm_call` |
| H9 | **Local diagnostics dashboard endpoint** — expose `doctor.build_report` (cached) as `/api/observability/diagnostics`: DB size, backup age, migration status, queue depth, p50, spend. | H/S | `doctor`, `observability`, `backup` |
| H10 | **Backup/restore UX** — one-click restore + Tauri sidecar-restart signal (+ `reset_cache`), hash-skip unchanged daily backups, keep-N + age retention. | H/M | `backup.restore_backup`/`maybe_backup`/`_prune` |
| H11 | **Structured logging + slow-query MetricSample + per-request SQL count** — opt-in JSON logs, durable slow-request rows, N+1 detector header in dev. | M/S | `observability.setup_logging`/`request_logging_middleware` |
| H12 | **CI matrix + sidecar smoke depth + e2e infra + coverage→80% branch** — macOS pytest leg; smoke hits `/observability/status` not just `/docs`; e2e for backup/restore/settings; raise the gate. | M/S-M | `ci.yml`, `release.yml` |
| H13 | **Self-heal + periodic integrity audit** — idle-hook orphan sweep, repair null-vector / stuck-ParseJob states before they persist; benchmarking harness (TTFT/tok-s/gate throughput). | M/M | `backup.orphan_report`, `embeddings`, `MetricSample` |
| H14 | **Migration dry-run + `user_version` PRAGMA + incremental embed backfill cursor** — preview pending migrations; authoritative schema version in the DB header; resumable backfill. | M-L/S | `migrations.run_migrations`, `backup.pragma_report`, `embeddings.backfill` |
| H15 | **Optional local DB encryption at rest (SQLCipher)** — opt-in passphrase via OS keychain; serves "privacy-first." ⚠ PyInstaller bundling complexity. | M/L | `config.DB_URL`, `sidecar_main`; borderline-effort |

**North-star (H): H1+H2 (vector + FTS, one migration ticket — unblocks the tutor & cockpit)** and **H5 (migration upgrade-path tests — cheapest insurance against the worst desktop bug).**

---

## Recommended sequencing (waves)

Foundations first; each wave makes the next cheaper. Items can be cherry-picked, but the dependency arrows hold.

### Wave 1 — Foundations & free wins (unblock everything)
`H1` sqlite-vec · `H2` FTS5 · `H3` pagination · `H4` index/plan harness · `H5` migration upgrade tests · `H8` model warm-unload + OOM · `H9` diagnostics endpoint · `D9` eval harness + `D10` gate property/mutation tests · `A9` better embed model + per-task routing · `G6` crash capture · `G7` perf memoization · **C1/C2/C3/C4** (percentile, required-slope, efficiency quadrant, lucky-rate — all analytics-only, S). *Mostly local, low-risk, high-leverage.*

### Wave 2 — The tutor + the adaptive core (Flagships 1 & 2)
`A1`+`A2`+`A3` RAG grounding → `A4`+`A5` Socratic dialogue · `F1`+`F2`+`F3` close the BR loop · `B1` IRT/Elo → `B2`+`B3` ZPD/CAT selection · `B5` calibration · `B6` error→remediation · `B7`+`B8` learning curves + mastery timeline · `C5` careless/concept · `C6` regression alerts · `C7` what-if · `C8` readiness simulation.

### Wave 3 — RC parity + generation quality + content cockpit (Flagship 3)
`E1` two-column parse · `E4` RC corpus · `E5` RC tagging · `D7` passage-first RC generation · `D1`+`D2`+`D3` type-complete + RC + distractor validators · `E8` content-health cockpit · `E9` AuditLog/versioning · `E2`+`E3` answer-key parse + bulk reconcile · `F4`+`F5` inline editor + authoring · `E10` coverage→gen bridge · `D5`/`D8` difficulty calibration/stratification.

### Wave 4 — Native companion + study-experience depth (Flagship 5)
`G1` always-on-top timer · `G2` tray badge + notifications · `G3` multi-window · `G4` app menu + deep-link · `G5` update UI · `F6` notebook + wiki + search · `F8` exam-mode polish · `F9` reflection rituals + zen · `F10` palette/keyboard · `F11` MCP expansion · `B10`+`B11` study-plan optimizer + macro schedule · `C9`/`C10`/`C11` readiness model + per-section forecast + debrief · `F12` share decks.

### Wave 5 — Scale, hardening & polish
`H6`+`H7` job queue + archival · `H10` backup/restore UX + retention · `H11`+`H13` logging/self-heal/benchmark · `H12` CI/e2e/coverage · `H14` migration dry-run + user_version · `A6`/`A7`/`A8` argument maps + reasoning + quality pool · `D11`/`D12` prompt self-opt + trace persistence · `E11`+`E12`+`E13` broaden ingestion + provenance + JSONL/DOCX · `C13`/`C14` Kalman + finer diagnostics · `G8`/`G9`/`G10`/`G11`/`G12` viz/a11y/design-system/print/first-run/motion · `B9` skill graph · `B12`/`B13`/`B14` pacing/spacing/reflection · `A10`/`A11` speculative decode / LoRA (opt-in) · `H15` DB encryption (opt-in) · `G-build` items verified on a packaged Win11 build.

---

## Non-goals (reaffirmed — these stay out)

User accounts / auth · multi-tenancy · cloud sync · hosted/Postgres backend · Docker-for-deploy ·
gunicorn multi-worker · cloud error tracking (Sentry) · mobile/web clients · **Logic Games** · cloud
LLM in the realtime / Tier-A / scoring path · cloud TTS/ASR · writing-sample practice. If the product
ever pivots to SaaS these reopen — but that is a product decision, out of scope here.

## Risks & mitigations

- **AI quality drift / over-trusting generation** — the gate (D1–D6, D9–D10) is the moat; keep
  `ai_generated` segregated and out of scoring; eval harness + mutation tests guard regressions.
- **Adaptivity overfitting on thin data** — IRT/Elo (B1) and forecasts (C) must stay honesty-first:
  wide bands, low-confidence floors, CI-lower-bound ranking; never present false precision.
- **`sqlite-vec`/SQLCipher native-bundling on Windows + PyInstaller** — gate H1/H15 behind the clean
  `VectorStore`/config seams with graceful fallback to today's pure-Python paths; verify in the
  sidecar smoke + a packaged build.
- **Native features unverifiable in a headless dev loop** (⚑ items: G1–G5, G11) — schedule a
  packaged-build smoke pass; keep web fallbacks so the app still runs in dev.
- **Scope creep / cloud-creep** — the cloud path stays offline-Tier-B-only and opt-in; no Wave item
  depends on it. RAG/embeddings/scoring remain local.
- **Migration safety** — H5 (up-from-old-DB tests) must precede any non-additive schema change
  (B1 θ store, F2 `br_note`, E12 provenance score, A4 conversation table, A6 argument-map column).

## Verification (how each wave is proven)

- **Automated:** extend the existing ~498-pytest / 167-vitest / 33-e2e harness — gate property+mutation
  (D10), schema-snapshot + up-from-old-DB (H5), pagination + EXPLAIN-plan budgets (H3/H4), backup
  round-trip + restore e2e (H10/H12), embedding/RAG similarity sanity (H1), eval-score regression
  (D9). Lift coverage to 80% branch (H12).
- **Local-first invariants (must hold every wave):** no realtime/scoring path reaches the cloud;
  `official` content never appears in any export; AI content never enters score prediction; the app
  renders fully with the backend down. (These already have tests in `test_audit_fixes.py` /
  `test_bank_export.py` — extend them.)
- **Manual / live:** `./start-dev.ps1` against live Ollama/LMStudio for the tutor + generation paths;
  a packaged Win11 build for every ⚑ native item (timer/tray/notifications/menu/CSP/Mica/updater).
- **Pedagogy reality-check:** the adaptive engine (B) and diagnostics (C) are validated against the
  owner's own study data over weeks — does mastery projection track reality, do regression alerts fire
  on real dips, does the readiness sim call exam-readiness honestly.
