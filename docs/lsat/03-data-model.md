# 03 — Data model (SQLite)

```
PrepTest        (id, name, source, date_admin, is_official)
Section         (id, preptest_id, type[LR|RC], order, time_limit_sec)
Passage         (id, section_id, text, type[RC only], topic)
Question        (id, section_id, passage_id?, stem, prompt,
                 correct_answer, difficulty(1-5), empirical_difficulty?,
                 q_type[Assumption|Strengthen|Weaken|Flaw|Inference|
                        Parallel|Principle|Method|MainPoint|...],
                 source[official|ai_generated|sample|research|reclor],
                 parent_question_id?, external_id?, content_hash?,
                 training_eligible?, training_role?[anchor|distill|both],
                 training_notes?)
AnswerChoice    (id, question_id, label[A-E], text, is_correct, trap_type?)
Explanation     (id, question_id, body, source[ai|user|official], per_choice_json)
Attempt         (id, question_id, session_id, mode[timed|blind_review|drill],
                 chosen_answer, br_answer?, is_correct, time_ms,
                 flagged, confidence, created_at)
StudySession    (id, type[section|full_exam|drill|review], started, ended,
                 scaled_score?, config_json)
ErrorLogEntry   (id, attempt_id, reason[misread|trap|concept|timing|careless],
                 user_note, ai_diagnosis)
SRSCard         (id, question_id, fsrs_state, due_date, lapses)
GenJob          (id, status, model, q_type, count, validation_report)
EmbeddingVector (question_id, embedding)   # sqlite-vec, for RAG / "similar misses"
```

## Key relationships & rules
- `Question.parent_question_id` ties an AI-generated drill to the real question it
  was modeled on. Enables the validation gate and keeps generated items honest in
  analytics.
- `Question.source` strictly separates `official` from `ai_generated`. **Score
  prediction and "real" accuracy stats use `official` only.** Other values:
  - `research` marks items imported from open datasets (AGIEval LR/RC,
    tasksource RC/LR) — treated like `sample` for the study loop but never as
    `official` for prediction.
  - `reclor` marks ReClor-imported items (the LSAT-derived half of the ReClor
    dataset, user-pulled with a non-commercial acknowledgement). Behaves like
    `research` (never feeds score prediction) and carries a separate tag so a
    future commercial build can filter the entire source out wholesale.
- `Question.external_id` records the source dataset row id (e.g.
  `agieval-lsat-lr:0042`) so re-imports skip rows already in the bank.
- `Question.content_hash` is a stable sha256 of normalized stem + sorted choice
  texts, used to dedup overlapping research datasets (AGIEval RC vs
  tasksource RC) and detect identical re-runs.
- `Question.empirical_difficulty` is the R7-shipped, attempt-derived difficulty
  recomputed by `audit.calibrate_difficulty` once an item has accumulated enough
  real attempts; large drift vs the original `difficulty` flags an item for
  review (Wave 5.5).
- **Training corpus flags** (Wave 1.6):
  - `Question.training_eligible` — user-marked as training-corpus quality
    (typically set in the PDF import wizard when the user is importing material
    they own, e.g. an official PrepTest PDF).
  - `Question.training_role` — `anchor` (preferred few-shot parent for Tier-B
    generation), `distill` (include in LoRA training set for Wave 6), or `both`.
  - `Question.training_notes` — free-text provenance ("PT 89, June 2024,
    official").
  These flags feed (a) parent-rotation preference inside the gen gate
  immediately (Wave 2.6) and (b) the LoRA training corpus when Wave 6 retrains.
- An `Attempt` stores both the **timed** choice and the **blind_review** choice
  (`br_answer`), which is what powers the 2×2 outcome routing and the timed-vs-BR
  gap chart.
- `AnswerChoice.trap_type` (AI-tagged: reversal, out-of-scope, degree, scope-shift,
  half-right, etc.) powers the Trap-analysis tab.
- `time_ms` is per-question, enabling the timing heatmap (not just per-section).
- `SRSCard.fsrs_state` stores FSRS scheduler state (stability, difficulty, etc.).
- `GenJob.validation_report` records why generated items passed/failed the
  R7-hardened gate: structural sanity, length-tell check, deterministic solve
  by the decorrelated `GEN_CRITIC_MODEL`, permutation-tolerant self-consistency,
  single-defensible-answer check, adversarial second-answer attack, per-q_type
  structural validators in `gen_validators.py` (assumption negation test,
  parallel form-match, paradox tension, etc.), and embedding dedup against the
  existing bank. Quarantined items are not served until manually approved.
  Wave 4.4 will normalize this from a JSON blob into a per-candidate
  `GenCandidate` table so verdicts become indexed rows instead of nested JSON.

## Question-type taxonomy (LR, initial)
Main Point · Necessary Assumption · Sufficient Assumption · Strengthen · Weaken ·
Flaw · Inference/Must-Be-True · Most Strongly Supported · Principle (apply/identify)
· Parallel Reasoning · Parallel Flaw · Method of Reasoning · Role/Function ·
Point at Issue · Paradox/Resolve · Evaluate.

## Question-type taxonomy (RC, initial)
Main Point/Primary Purpose · Author's Attitude · Specific Detail · Inference ·
Function/Role of a phrase · Structure/Organization · Analogy/Application ·
Strengthen/Weaken (RC) · Comparative-passage relationship.
