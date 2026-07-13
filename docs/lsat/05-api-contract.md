# 05 — API Contract (source of truth)

Backend serves at `http://127.0.0.1:8000`. All app routes are under `/api`.
FastAPI also exposes `/openapi.json` and `/docs`. Frontend should treat THIS file
as the contract; if backend's OpenAPI diverges, backend wins and this doc is updated.

CORS: allow `http://localhost:5173` (Vite) and `tauri://localhost`.

## Conventions
- IDs are integers. Timestamps are ISO-8601 strings (UTC).
- Money/score numbers are plain numbers. Booleans are JSON booleans.
- Errors: `{ "detail": "message" }` with appropriate HTTP status.
- Streaming endpoints use **Server-Sent Events** (`text/event-stream`).

## Enums
- `section_type`: `"LR" | "RC"`
- `question_source`: `"official" | "ai_generated" | "sample" | "research"`
- `attempt_mode`: `"timed" | "blind_review" | "drill"`
- `session_type`: `"section" | "full_exam" | "drill" | "review"`
- `confidence`: `"sure" | "likely" | "guess"`
- `error_reason`: `"misread" | "trap" | "concept" | "timing" | "careless"`
- `lr_type`: MainPoint, NecessaryAssumption, SufficientAssumption, Strengthen,
  Weaken, Flaw, Inference, MostStronglySupported, PrincipleApply, PrincipleIdentify,
  Parallel, ParallelFlaw, Method, Role, PointAtIssue, Paradox, Evaluate
- `rc_type`: MainPoint, Attitude, Detail, Inference, Function, Structure,
  Application, StrengthenWeaken, Comparative
- `trap_type`: reversal, out_of_scope, degree, scope_shift, half_right,
  opposite, too_strong, irrelevant_comparison, premise_restatement, none

## Core resource shapes

### Question (test-mode form — correct answer & explanation hidden)
```json
{
  "id": 12,
  "section_id": 3,
  "passage_id": null,
  "prompt": "Which one of the following most weakens the argument?",
  "stem": "Editorial: The city council claims ...",
  "q_type": "Weaken",
  "difficulty": 4,
  "source": "sample",
  "choices": [
    { "id": 60, "label": "A", "text": "..." },
    { "id": 61, "label": "B", "text": "..." }
  ]
}
```

### Question (review form — adds answer key & per-choice info)
```json
{
  "...": "all fields above, plus:",
  "correct_answer": "B",
  "choices": [
    { "id": 60, "label": "A", "text": "...", "is_correct": false, "trap_type": "out_of_scope" }
  ],
  "explanation": { "body": "...", "per_choice": { "A": "...", "B": "..." }, "source": "ai" }
}
```

## Endpoints

### Health
- `GET /api/health` → `{ "ok": true }`
- `GET /api/ai/health` → `{ "ollama": true, "models": ["qwen3:8b","qwen3:14b"], "explain_model": "qwen3:8b", "gen_model": "qwen3:14b" }`

### PrepTests & content
- `GET /api/preptests` → `[{ id, name, source, date_admin, is_official, section_count, completed_sections }]`
- `GET /api/preptests/{id}` → `{ id, name, ..., sections: [{ id, type, order, time_limit_sec, question_count }] }`
- `GET /api/sections/{id}` → test-mode: `{ id, preptest_id, type, time_limit_sec, passages: [{id,text,type,topic}], questions: [Question test-mode] }`
- `GET /api/questions/{id}?reveal=false` → Question (test-mode unless `reveal=true`)

### Import wizard (PDF → structured)
- `POST /api/import/parse` (multipart `file`) → `{ job_id, parsed: { name, sections: [{ type, questions: [...], passages: [...] }] }, warnings: [str] }`
  - Backend extracts text (pymupdf) then runs an AI structuring pass (offline model). Returns proposed structure for human review. Does NOT commit.
- `POST /api/import/commit` body `{ job_id, parsed }` (possibly edited) → `{ preptest_id }`

### Study sessions & attempts
- `GET /api/sessions` → `[{ id, type, started, ended, scaled_score, question_count }]` (most-recent-first)
- `POST /api/sessions` body `{ type, config }` → `{ id, type, started }`
- `POST /api/sessions/{id}/attempts` body `{ question_id, mode, chosen_answer, time_ms, flagged, confidence }` → `{ attempt_id }`
- `PATCH /api/attempts/{id}/blind-review` body `{ br_answer, confidence }` → `{ ok: true }`
- `POST /api/sessions/{id}/finish` → `{ scaled_score?, raw_correct, total }`
- `GET /api/sessions/{id}/results` → `{ session, items: [{ question (review form), attempt: { attempt_id, chosen_answer, br_answer, is_correct, br_correct, time_ms, flagged, confidence, outcome }}] }`
  - `outcome`: `"timed_ok" | "timing_problem" | "concept_gap" | "lucky"` (the 2×2 routing)

### AI
- `POST /api/ai/explain` body `{ question_id, chosen_answer }` → **SSE stream** of `data: {"token":"..."}` then `data: {"done":true,"explanation_id":N}`. Persists Explanation (per-choice + body). If a cached explanation exists, may stream it from cache.
- `POST /api/ai/diagnose` → `{ text, recommendation: { label, action: { type, payload } } }` (drives Dashboard AI Coach card). On-demand; reads recent attempts.

### Analytics
- `GET /api/analytics/dashboard` → `{ predicted_score, score_delta_30d, trend: [{date, score}], weakest_types: [{ q_type, accuracy, avg_time_ms, trend }], coach: { text, recommendation }, streak_days }`
- `GET /api/analytics/by-type?source=official|all` → `[{ q_type, section_type, attempts, accuracy, avg_time_ms, trend }]`
- `GET /api/analytics/timing/{session_id}` → `[{ question_order, time_ms, is_correct, difficulty }]`
- `GET /api/analytics/blind-review-gap` → `{ timed_accuracy, br_accuracy, gap, by_type: [...] }`
- `GET /api/analytics/traps` → `[{ trap_type, times_fell_for, pct }]`
- `GET /api/analytics/by-difficulty?source=official|all` → `[{ difficulty(1-5), attempts, accuracy, avg_time_ms }]` — for the difficulty curve.
- `GET /api/analytics/activity?days=120` → `[{ date, questions, minutes, correct, sessions }]` — per-day study activity, zero-filled & oldest→newest, for the contribution heatmap / study calendar. `days` clamped to [1, 730].

### SRS (FSRS)
- `GET /api/srs/due` → `{ due_count, cards: [Question test-mode + {card_id}] }`
- `POST /api/srs/{card_id}/review` body `{ rating: 1|2|3|4 }` (again/hard/good/easy) → `{ next_due, interval_days }`

### Drills
- `POST /api/drills` body `{ q_type?, section_type?, difficulty?, count, source: "real"|"ai"|"any", timed }` → creates a drill session → `{ session_id, questions: [Question test-mode] }`

### AI generation (Tier B, offline/batch + validation gate)
- `POST /api/gen/jobs` body `{ q_type, count }` → `{ job_id, status: "queued" }` (runs in background)
- `GET /api/gen/jobs/{id}` → `{ id, status: "queued|running|done|failed", produced, accepted, quarantined, validation_report }`
- `GET /api/gen/quarantine` → `[Question review form]` (items that failed/low-confidence; manual approve)
- `POST /api/gen/quarantine/{question_id}/approve` → `{ ok: true }`

### Error log
- `POST /api/attempts/{id}/error-log` body `{ reason, note }` → `{ id }`
- `GET /api/error-log` → `[{ id, question (review form), reason, note, ai_diagnosis, created_at }]`

## Round 5 backend additions (continuous-tutor wave)

### AI depth
- `POST /api/ai/explain` now also accepts `{ user_message?, focus_choice? }` for
  follow-up turns. SSE adds per-choice events `{ choice, text }` as they stream and
  a final `{ done, explanation_id, cached, per_choice }`. Follow-ups (`user_message`)
  are not persisted.
- `POST /api/ai/hint` body `{ question_id, mode }` → `{ hint }` (refused unless `mode=="study"`).
- `GET /api/ai/coach` → `{ available, text, recommendation, created_at }` (cached snapshot).
- `POST /api/ai/coach/refresh` → refreshes the snapshot now.
- `POST /api/ai/pregenerate` body `{ limit, sources? }` → `{ explained, remaining }`.

### Analytics v2
- `?days=N` is honored server-side on `dashboard`, `by-type`, `traps`,
  `blind-review-gap`, `by-difficulty`, `mastery`, `forecast`.
- `GET /api/analytics/mastery?source=&days=` → recency/difficulty-adjusted mastery.
- `GET /api/analytics/forecast?exam_date=&target_score=&days=` → projection + bands.
- `GET /api/analytics/report?days=` → bundled report payload.
- `GET /api/analytics/type/{q_type}?days=` → `{ overall, by_section, gap, traps, recent_misses }`.
- `GET /api/analytics/focus/{session_id}` → `{ score, components, n }`.

### Sessions, exams, study plan, reflection
- `GET /api/sessions` enriched with `duration_sec`, `br_accuracy`, `official_only_score`.
- `GET /api/preptests/{id}/progress` → per-section attempted/accuracy/BR%/best_score.
- `POST /api/exams` body `{ preptest_id }` → `{ session_id, sections }`; `GET /api/exams/{id}/results`.
- `GET|PUT /api/study/plan`, `GET /api/study/today` (server-driven Today plan + goal).
- `POST|GET /api/sessions/{id}/reflection` (reflection journal).

### Review / annotations / SRS
- `PUT|GET|DELETE /api/attempts/{id}/annotations` and `…/questions/{id}/annotations`
  (highlights/underlines/notes; body `{ highlights: [...] }`).
- `POST /api/srs/cards` body `{ question_ids }` → `{ created, skipped, card_ids }`.
- `PATCH|DELETE /api/error-log/{id}` (edit reason/note; delete). `ai_diagnosis` is
  auto-populated on create (background, best-effort).
- `GET /api/questions/{id}/similar?k=` → `[Question review form + similarity]`.

### Bank / generation / import / observability
- `GET /api/bank/audit`, `GET /api/bank/duplicates?threshold=`, `POST /api/bank/embed`,
  `GET /api/bank/similar/{id}`, `GET /api/bank/tag-review`, `POST /api/bank/bulk-tag`.
- `GET /api/gen/jobs` (list), `GET /api/gen/coverage`, `POST /api/gen/for-type`,
  `GET /api/gen/quarantine/{id}/triage`.
- `POST /api/drills/intent` body `{ text }` → a `DrillConfig`.
- `POST /api/import/reconcile` (answer-key); `GET /api/import/jobs[/{id}]`;
  `/import/parse` + `/commit` report `collision` and accept `replace`.
- `GET /api/settings`, `PUT /api/settings` (model routing; secrets stay in env).
  The returned `provider.capabilities` block exposes active realtime/offline
  provider capability rows and the full Ollama/LM Studio/Anthropic matrix,
  including sampling and structured-output degradations.
- `GET /api/observability/status` → `{ gen_queued, gen_running, worker_alive,
  last_coach_refresh_ms, explain_p50_ms, embed_coverage_pct, models }`.
  `models.capabilities`, `/api/ai/health.capabilities`, `/api/ready.ai.capabilities`,
  and `/api/observability/health-aggregated.provider_capabilities` share the same
  matrix so operators can distinguish missing models from unsupported provider
  features.

## Notes for implementers
- Test-mode responses MUST NOT leak `is_correct`/`correct_answer`/`explanation`.
- Score prediction & "official accuracy" use `source == "official"` only.
- AI-generated questions always carry `source: "ai_generated"` and `parent_question_id`.
- "Similar questions" uses local embeddings (`nomic-embed-text`) when the bank is
  embedded (`POST /api/bank/embed`); falls back to `[]` until then.
- Realtime AI (explain/diagnose/tag/hint) goes to Ollama at `http://localhost:11434`
  (explain=`qwen3:8b`, generate=`qwen3:14b`). Strip `<think>...</think>` from qwen3
  output. Offline Tier-B generation may optionally use a cloud model
  (`LSATLAB_GEN_PROVIDER=cloud`); it never serves realtime or score-affecting paths.
- Provider options are negotiated before generation and cache lookup. Unsupported
  knobs are omitted from both the provider request and deterministic cache key:
  for example, Anthropic does not support `seed`, so seed alone cannot make a
  warm cloud call cacheable.
