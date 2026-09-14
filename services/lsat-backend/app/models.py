"""SQLModel schema for LSAT Lab, matching docs/03-data-model.md and the API contract.

Enums are stored as plain strings (str-Enums) so SQLite stays readable and the JSON
shapes match the contract exactly.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import Column, JSON
from sqlmodel import Field, SQLModel

from .db_field_crypto import EncryptedText


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- Enums (values match docs/05-api-contract.md) ---------------------------
class SectionType(str, Enum):
    LR = "LR"
    RC = "RC"


class QuestionSource(str, Enum):
    official = "official"
    ai_generated = "ai_generated"
    sample = "sample"
    # Imported from open research datasets (AGIEval, tasksource, etc.).
    # Kept distinct so score prediction (official-only) is not contaminated and
    # the bank can be redistributed safely (only ai_generated and sample are).
    research = "research"
    # ReClor (Yu et al., ICLR 2020). License is non-commercial / personal
    # research only, so it lives in its own bucket. Behaves like ``research``
    # for the study loop (never feeds score prediction) but a future commercial
    # build can filter the entire source out wholesale by this value.
    reclor = "reclor"


class AttemptMode(str, Enum):
    timed = "timed"
    blind_review = "blind_review"
    drill = "drill"


class SessionType(str, Enum):
    section = "section"
    full_exam = "full_exam"
    drill = "drill"
    review = "review"


class Confidence(str, Enum):
    sure = "sure"
    likely = "likely"
    guess = "guess"


class ErrorReason(str, Enum):
    misread = "misread"
    trap = "trap"
    concept = "concept"
    timing = "timing"
    careless = "careless"


class ExplanationSource(str, Enum):
    ai = "ai"
    user = "user"
    official = "official"


class GenStatus(str, Enum):
    planned = "planned"   # part of a previewed plan; the worker ignores it
    queued = "queued"     # ready to run; the durable worker drains these
    running = "running"
    done = "done"
    failed = "failed"
    cancelled = "cancelled"


class ImportRunStatus(str, Enum):
    planned = "planned"
    validating = "validating"
    committing = "committing"
    done = "done"
    failed = "failed"
    rolled_back = "rolled_back"


# Allowed q_type values (informational; validated softly).
LR_TYPES = [
    "MainPoint", "NecessaryAssumption", "SufficientAssumption", "Strengthen",
    "Weaken", "Flaw", "Inference", "MostStronglySupported", "PrincipleApply",
    "PrincipleIdentify", "Parallel", "ParallelFlaw", "Method", "Role",
    "PointAtIssue", "Paradox", "Evaluate",
]
RC_TYPES = [
    "MainPoint", "Attitude", "Detail", "Inference", "Function", "Structure",
    "Application", "StrengthenWeaken", "Comparative",
]
TRAP_TYPES = [
    "reversal", "out_of_scope", "degree", "scope_shift", "half_right",
    "opposite", "too_strong", "irrelevant_comparison", "premise_restatement",
    "none",
]


# --- Tables -----------------------------------------------------------------
class PrepTest(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    source: str = "official"  # provenance label
    date_admin: Optional[str] = None
    is_official: bool = True
    # 3.5 — the real published raw->scaled conversion table for THIS test, when
    # the user owns it: {"raw_to_scaled": {"45": 152, ...}}. None falls back to
    # the generic representative curve in scoring.py.
    scale_table_json: Optional[dict] = Field(
        default=None, sa_column=Column(JSON, nullable=True)
    )


class Section(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    preptest_id: int = Field(foreign_key="preptest.id", index=True)
    type: SectionType
    order: int = 0
    time_limit_sec: int = 2100  # 35 min default


class Passage(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    section_id: int = Field(foreign_key="section.id", index=True)
    text: str
    type: Optional[str] = None  # RC passage flavor, e.g. "single" | "comparative"
    topic: Optional[str] = None


class Question(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    section_id: Optional[int] = Field(default=None, foreign_key="section.id", index=True)
    passage_id: Optional[int] = Field(default=None, foreign_key="passage.id", index=True)
    stem: str
    prompt: str
    correct_answer: str  # "A".."E"
    difficulty: int = 3  # 1-5
    q_type: str
    source: QuestionSource = QuestionSource.official
    parent_question_id: Optional[int] = Field(default=None, foreign_key="question.id")
    # Generated items live here until approved; not served while quarantined.
    quarantined: bool = False
    approved: bool = True  # official/sample are approved by definition
    # Provenance for research-dataset imports (e.g. "agieval-lsat-lr:0042"). Lets
    # re-imports skip rows already in the bank.
    external_id: Optional[str] = Field(default=None, index=True)
    # Stable hash of (stem, sorted choice texts). Used to dedup across sources
    # (AGIEval RC vs tasksource RC overlap) and to detect identical re-runs.
    content_hash: Optional[str] = Field(default=None, index=True)
    # Confidence of the auto-tagger: "high" (heuristic) | "medium" (model) |
    # "low" (fallback). Drives the tag-review queue. None = never tagged.
    tag_confidence: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    # D5: soft-delete tombstone. Non-null = retired from future selection
    # (drills / coverage / embeddings) without breaking attempt/SRS foreign keys
    # or rewriting historical analytics.
    deleted_at: Optional[datetime] = None
    # 5.4 — bumped whenever tags/difficulty/approval are edited (audit trail).
    updated_at: Optional[datetime] = None
    # 2.8 — difficulty re-estimated from observed live accuracy; leaves the
    # model-asserted `difficulty` intact. None until enough attempts exist.
    empirical_difficulty: Optional[float] = None
    # Bank-expansion plan Wave 1.6 — user-marked "training corpus" flags.
    # ``training_eligible`` items become (a) preferred few-shot parents for
    # Tier-B generation (Wave 2.6) and (b) part of the LoRA training set
    # (Wave 6). Set in the PDF import wizard or via the dataset import flag.
    training_eligible: bool = Field(default=False, index=True)
    # "anchor" (parent rotation only) | "distill" (LoRA only) | "both" (default
    # when ``training_eligible=True``). Stored as a string for forward
    # compatibility with future roles (e.g. "eval-set").
    training_role: Optional[str] = None
    # Free-text provenance for the human ("PT 89, June 2024, official").
    training_notes: Optional[str] = None


class AnswerChoice(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    label: str  # A-E
    text: str
    is_correct: bool = False
    trap_type: Optional[str] = None


class Explanation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    body: str
    source: ExplanationSource = ExplanationSource.ai
    per_choice_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # 2.6 — provenance + self-check signals on the explanation itself:
    #   model_used: which model produced it
    #   confidence: "high" | "medium" | "low"
    #   answer_checked: the asserted correct letter was verified == correct_answer
    model_used: Optional[str] = None
    confidence: Optional[str] = None
    answer_checked: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class StudySession(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    type: SessionType
    started: datetime = Field(default_factory=utcnow)
    ended: Optional[datetime] = None
    scaled_score: Optional[int] = None
    config_json: dict = Field(default_factory=dict, sa_column=Column(JSON))


class Attempt(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    session_id: int = Field(foreign_key="studysession.id", index=True)
    mode: AttemptMode = AttemptMode.timed
    chosen_answer: Optional[str] = None
    br_answer: Optional[str] = None
    is_correct: bool = False
    br_correct: Optional[bool] = None
    time_ms: int = 0
    flagged: bool = False
    confidence: Optional[Confidence] = None
    # 5.2 — client-generated idempotency token so offline replay / retries cannot
    # create duplicate attempts. Unique-when-present (migration 7).
    client_attempt_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utcnow)


class ErrorLogEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    attempt_id: int = Field(foreign_key="attempt.id", index=True)
    reason: ErrorReason
    user_note: Optional[str] = Field(
        default=None,
        sa_column=Column(EncryptedText("ErrorLogEntry.user_note")),
    )
    ai_diagnosis: Optional[str] = Field(
        default=None,
        sa_column=Column(EncryptedText("ErrorLogEntry.ai_diagnosis")),
    )
    created_at: datetime = Field(default_factory=utcnow)


class SRSCard(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    fsrs_state: dict = Field(default_factory=dict, sa_column=Column(JSON))
    due_date: datetime = Field(default_factory=utcnow, index=True)
    lapses: int = 0
    # 1.1 — why this card exists: "concept_gap" | "lucky" | "manual" | "seed".
    origin: Optional[str] = None
    # 3.2 — flagged as a leech (too many lapses) for a remediation queue.
    leech: bool = False
    last_reviewed: Optional[datetime] = None


class GenCandidate(SQLModel, table=True):
    """Bank-expansion plan Wave 4.4 — per-candidate generation verdict row."""
    id: Optional[int] = Field(default=None, primary_key=True)
    gen_job_id: int = Field(foreign_key="genjob.id", index=True)
    question_id: Optional[int] = Field(default=None, foreign_key="question.id")
    candidate_index: int = 0
    verdict: str = ""  # "accepted" | "quarantined"
    verdict_reason: Optional[str] = None
    gate_scores: dict = Field(default_factory=dict, sa_column=Column(JSON))
    solver_model: Optional[str] = None
    critic_model: Optional[str] = None
    training_anchor_id: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow)


class GenJob(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    status: GenStatus = GenStatus.queued
    model: str = ""
    q_type: str = ""
    count: int = 0
    produced: int = 0
    accepted: int = 0
    quarantined: int = 0
    priority: int = Field(default=0, index=True)
    progress_pct: float = 0.0
    retry_count: int = 0
    max_retries: int = 0
    # Optional: pin generation to a single parent question. When None the runner
    # rotates parents of the requested q_type — required to scale beyond a few
    # variations per type without producing repetitive output.
    parent_question_id: Optional[int] = Field(
        default=None, foreign_key="question.id"
    )
    # LSAT-5 — passage-first RC generation. When True the runner generates ONE
    # coherent RC passage and attaches several varied questions to it (rather than
    # the default per-candidate path that emits an independent item per loop
    # iteration). Additive/optional (migration 26); existing LR/RC single-candidate
    # jobs leave it False and are unchanged.
    passage_first: bool = Field(default=False)
    # BACK-3 — resumable batch checkpoint. The next candidate index a resumed run
    # should START at, so an interrupted batch picks up where it left off instead
    # of re-generating (and re-persisting) candidates 0..k again. Additive/optional
    # (migration 29); legacy jobs leave it 0 and run the whole count from the top
    # exactly as before. Only consulted when ``config.GEN_RESUMABLE_BATCH`` is on.
    next_index: int = Field(default=0)
    validation_report: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None


class EmbeddingVector(SQLModel, table=True):
    """Local embedding for one object (a question or a user note).

    Vectors are stored as JSON and compared with brute-force cosine in Python —
    a single user's bank is small enough that this beats taking on a native
    sqlite-vec extension (see app/embeddings.py). One row per (kind, ref_id);
    a UNIQUE index (migration 2) enforces that.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = Field(index=True)        # "question" | "note"
    ref_id: int = Field(index=True)      # Question.id or ErrorLogEntry.id
    model: str = ""
    dim: int = 0
    vector_json: list = Field(default_factory=list, sa_column=Column(JSON))
    # Wave 3.5 — packed float32; preferred over vector_json when set.
    vector_blob: Optional[bytes] = Field(default=None)
    created_at: datetime = Field(default_factory=utcnow)


class ImportRun(SQLModel, table=True):
    """Durable import ledger for PDFs, research datasets, and portable exports."""
    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(index=True)
    license: Optional[str] = None
    file_hash: Optional[str] = Field(default=None, index=True)
    row_counts_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    warnings_json: list = Field(default_factory=list, sa_column=Column(JSON))
    dedup_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: ImportRunStatus = Field(default=ImportRunStatus.planned, index=True)
    preptest_id: Optional[int] = Field(default=None, index=True)
    error: Optional[str] = None
    started_at: datetime = Field(default_factory=utcnow, index=True)
    finished_at: Optional[datetime] = None


class ParseJob(SQLModel, table=True):
    """A persisted PDF parse awaiting human verification + commit.

    The previous in-memory parse cache was lost on restart, discarding the
    human-verify work mid-import. Persisting it means the review step (and any
    answer-key reconcile) survives a crash and can be resumed.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    filename: Optional[str] = None
    parsed_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    warnings_json: list = Field(default_factory=list, sa_column=Column(JSON))
    committed: bool = False
    preptest_id: Optional[int] = None
    import_run_id: Optional[int] = Field(default=None, foreign_key="importrun.id")
    created_at: datetime = Field(default_factory=utcnow)


class StudyPlan(SQLModel, table=True):
    """The student's goal: a target score and test date drive the daily plan.

    Single-user app, so there is one active plan at a time (others are kept for
    history with active=False).
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    target_score: int = 165
    exam_date: Optional[str] = None       # ISO date, e.g. "2026-09-12"
    daily_minutes: int = 60
    active: bool = True
    created_at: datetime = Field(default_factory=utcnow)
    # DATA-6 — last-write timestamp for the shared study-profile arbiter's
    # last-write-wins conflict policy. Additive/optional (migration 24 backfills
    # pre-existing rows from ``created_at``); ``upsert_plan`` keeps its existing
    # signature and simply stamps this on insert via the default_factory.
    updated_at: datetime = Field(default_factory=utcnow)


class SharedStudyProfile(SQLModel, table=True):
    """DATA-6 — the single reconciled study profile shared across domains.

    Reconciles the LSAT ``StudyPlan`` (target_score / exam_date / daily_minutes)
    with the host's ``StudyPlanSettings`` (targetLevel / dailyTargetMinutes /
    examDate, persisted in Dexie). ``GET /api/study/profile`` returns the
    reconciled view; ``PUT`` writes it (updating the active LSAT ``StudyPlan`` row
    AND mirroring the host-owned fields here). The host side persists via the
    degrading-fetch bridge to Dexie.

    Conflict policy is last-write-wins by ``updated_at``: a writer stamps
    ``updated_at`` and the most recent write across either side wins. This row
    holds the HOST-owned fields the LSAT ``StudyPlan`` has no column for
    (``target_level``, ``rest_days``, ``mock_cadence_days``) plus a mirror of the
    reconciled scalars, so the profile survives even when only one side wrote.

    Single-user app: there is one row, keyed by a stable string (``default``).
    This is the source of truth LEARN-3 (daily plan) and ANL-4 (readiness) read.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    # Stable single-user key; a UNIQUE index (migration 24) enforces one row.
    profile_key: str = Field(default="default", index=True)
    # Reconciled scalars (mirror the LSAT StudyPlan; host maps targetLevel/
    # dailyTargetMinutes/examDate onto these via the bridge).
    target_score: int = 165
    exam_date: Optional[str] = None        # ISO date "YYYY-MM-DD"
    daily_minutes: int = 60
    # Host-owned fields the LSAT StudyPlan cannot store. Carried verbatim so a
    # host write round-trips losslessly through this single source of truth.
    target_level: Optional[str] = None     # host StudyPlanSettings.targetLevel
    rest_days: list = Field(default_factory=list, sa_column=Column(JSON))
    mock_cadence_days: Optional[int] = None
    topic_weights: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # StudyVault 1.0 cross-domain planner inputs. Additive JSON columns keep the
    # schema flexible and migration-safe for older single-user databases.
    domain_goals: dict = Field(default_factory=dict, sa_column=Column(JSON))
    time_allocation: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Who wrote last ("lsat" | "host" | "merge"): provenance for the
    # last-write-wins arbitration (informational; the timestamp decides).
    last_writer: str = Field(default="merge")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class Setting(SQLModel, table=True):
    """Runtime-overridable config (model routing, etc.) as key/value strings.

    Applied over config.py defaults at startup and live on update. Secrets (API
    keys) are deliberately NOT stored here — they stay in the environment only.
    """
    key: str = Field(primary_key=True)
    value: str = ""


class CoachSnapshot(SQLModel, table=True):
    """A cached AI-coach diagnosis, refreshed on a schedule by the worker so the
    dashboard shows a fresh diagnosis without a per-load model call."""
    id: Optional[int] = Field(default=None, primary_key=True)
    text: str = ""
    recommendation_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)


class Annotation(SQLModel, table=True):
    """Highlights / underlines / margin notes for a question, scoped either to a
    specific attempt (a single take) or to a question (cross-attempt markup).
    Stored as opaque JSON so the UI owns the mark shape; one row per (scope, ref_id)
    enforced by a UNIQUE index (migration 3).

    LSAT-6 — the row also doubles as a Notebook knowledge-base entry: a
    user-authored explanation (surfaced alongside the AI explanation) and a free
    tag list. Both are NULLABLE/additive so existing highlight/note writers are
    untouched; the FTS5 ``annotation_fts`` mirror (migration 25) indexes the note
    text + ``user_explanation`` so the KB is keyword-searchable."""
    id: Optional[int] = Field(default=None, primary_key=True)
    scope: str = Field(index=True)        # "attempt" | "question"
    ref_id: int = Field(index=True)       # Attempt.id or Question.id
    data_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=utcnow)
    # LSAT-6 — user-authored explanation surfaced next to the AI one (nullable).
    user_explanation: Optional[str] = None
    # LSAT-6 — JSON-encoded list[str] of free tags for the notebook KB (nullable).
    tags_json: Optional[str] = None


class Reflection(SQLModel, table=True):
    """A study reflection journal entry attached to a session (one per session)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: int = Field(foreign_key="studysession.id", index=True)
    text: str = ""
    prompts_json: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ExplanationFeedback(SQLModel, table=True):
    """Q1 — a thumbs up/down (+ optional note) on a question's explanation. Lets
    low-rated explanations be regenerated and explanation quality be tracked
    over time (the gate keeps bad questions out; this measures whether the
    *explanations* actually help)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    helpful: bool = True
    note: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


# --- R7 tables --------------------------------------------------------------
class AttemptChoiceEvent(SQLModel, table=True):
    """1.2 — one process-of-elimination interaction within an attempt: which
    choice was selected/eliminated/restored/reconsidered, in what order, and how
    long after the question opened. Captures the *process* the binary Attempt
    cannot, enabling 'you eliminate the trap last' coaching + per-choice timing."""
    id: Optional[int] = Field(default=None, primary_key=True)
    attempt_id: int = Field(foreign_key="attempt.id", index=True)
    label: str                       # "A".."E"
    action: str                      # "select" | "eliminate" | "restore" | "reconsider"
    order_index: int = 0             # 0-based order the events occurred in
    time_ms: int = 0                 # ms since the question opened
    confidence: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


class SRSReviewLog(SQLModel, table=True):
    """3.2 — append-only FSRS review history (rating + timestamp per review) so
    the FSRS weights can be optimized from the user's own data (py-fsrs needs the
    full review log, not just the current card state)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    card_id: int = Field(foreign_key="srscard.id", index=True)
    question_id: int = Field(index=True)
    rating: int                      # 1=again 2=hard 3=good 4=easy
    reviewed_at: datetime = Field(default_factory=utcnow, index=True)


class MetricSample(SQLModel, table=True):
    """7.3 — a persisted observability sample (LLM latency, gate pass/fail, etc.)
    so p50s and trends survive a restart instead of living only in a RAM ring."""
    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = Field(index=True)    # "llm_latency_ms" | "gate" | ...
    model: str = ""
    value: float = 0.0
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class UsageLedger(SQLModel, table=True):
    """7.3 — durable cloud-spend ledger so the monthly budget gauge AND its
    enforcement survive restarts (the in-RAM token counters reset on launch)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    provider: str = "cloud"
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    created_at: datetime = Field(default_factory=utcnow, index=True)


class Playlist(SQLModel, table=True):
    """6.1 — a saved, replayable problem set ('Smart set'). kind='smart' stores a
    filter in criteria_json (e.g. all Flaw misses in PT70-80); kind='manual'
    pins explicit question ids in question_ids_json."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    kind: str = "smart"              # "smart" | "manual"
    criteria_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    question_ids_json: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class AuditLog(SQLModel, table=True):
    """5.4 — lightweight audit trail for content edits (tag/difficulty/approval/
    explanation). entity_id is a soft reference (not a FK) since it may point at
    a question or an explanation."""
    id: Optional[int] = Field(default=None, primary_key=True)
    entity: str = Field(index=True)      # "question" | "explanation"
    entity_id: int = Field(index=True)
    field: str = ""
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


# --- vNext tables -----------------------------------------------------------
class AbilitySnapshot(SQLModel, table=True):
    """Point-in-time local ability estimate.

    This intentionally stays local and transparent: it is an IRT/Elo-style
    heuristic built from attempts, timing, confidence, Blind Review, and item
    difficulty. It gives adaptivity a persisted signal without claiming
    psychometric precision the single-user dataset cannot yet support.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    q_type: Optional[str] = Field(default=None, index=True)
    section_type: Optional[SectionType] = Field(default=None, index=True)
    ability: float = Field(default=0.0, index=True)
    mastery: float = 0.5
    uncertainty: float = 1.0
    evidence_n: int = 0
    accuracy: Optional[float] = None
    avg_time_ms: Optional[float] = None
    components_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class QuestionItemStats(SQLModel, table=True):
    """Observed item behavior, recalculated from the local attempt history."""
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    attempts: int = 0
    correct: int = 0
    br_attempts: int = 0
    br_correct: int = 0
    avg_time_ms: Optional[float] = None
    difficulty_estimate: Optional[float] = None
    discrimination: Optional[float] = None
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class ReadinessSnapshot(SQLModel, table=True):
    """Section/full-exam readiness estimate written by /api/readiness."""
    id: Optional[int] = Field(default=None, primary_key=True)
    section_type: Optional[SectionType] = Field(default=None, index=True)
    readiness_score: float = Field(default=0.0, index=True)
    predicted_scaled_score: Optional[int] = None
    status: str = "insufficient_data"
    on_track: Optional[bool] = None
    components_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class AttemptRationale(SQLModel, table=True):
    """The student's written 'why' at timed, Blind Review, or revision time."""
    id: Optional[int] = Field(default=None, primary_key=True)
    attempt_id: int = Field(foreign_key="attempt.id", index=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    stage: str = Field(default="blind_review", index=True)
    answer: Optional[str] = None
    confidence: Optional[Confidence] = None
    rationale_text: str = Field(
        default="",
        sa_column=Column(EncryptedText("AttemptRationale.rationale_text")),
    )
    trap_guess: Optional[str] = None
    # LSAT-3 — the short "why" note captured at reveal in the Blind Review screen
    # (the quick takeaway the user types while revealing), kept distinct from the
    # longer ``rationale_text`` the Socratic why-loop writes. Optional/additive
    # (migration 21); older rows leave it NULL.
    br_note: Optional[str] = Field(
        default=None,
        sa_column=Column(EncryptedText("AttemptRationale.br_note")),
    )
    created_at: datetime = Field(default_factory=utcnow, index=True)


class QuestionConversation(SQLModel, table=True):
    """Persistent local tutor conversation scoped to a question/attempt."""
    id: Optional[int] = Field(default=None, primary_key=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    attempt_id: Optional[int] = Field(default=None, foreign_key="attempt.id", index=True)
    mode: str = Field(default="socratic", index=True)
    title: str = ""
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class TutorTurn(SQLModel, table=True):
    """Append-only message in a local Socratic tutor conversation."""
    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_id: int = Field(foreign_key="questionconversation.id", index=True)
    role: str = Field(default="assistant", index=True)
    content: str = Field(
        default="",
        sa_column=Column(EncryptedText("TutorTurn.content")),
    )
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class ContentVersion(SQLModel, table=True):
    """Snapshot of content before/after important edits for audit/restore."""
    id: Optional[int] = Field(default=None, primary_key=True)
    entity: str = Field(index=True)
    entity_id: int = Field(index=True)
    version: int = 1
    reason: str = ""
    snapshot_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class MigrationState(SQLModel, table=True):
    """Recorded migration integrity state, including checksums and failures."""
    __tablename__ = "schema_migration_integrity"

    version: int = Field(primary_key=True)
    name: str
    checksum: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    status: str = "pending"
    error: Optional[str] = None


class TrustSnapshot(SQLModel, table=True):
    """Machine-readable release-trust manifest captured for audit/history."""
    id: Optional[int] = Field(default=None, primary_key=True)
    tier: str = Field(default="dev", index=True)
    status: str = Field(default="warning", index=True)
    score: int = 0
    checks_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    blockers_json: list = Field(default_factory=list, sa_column=Column(JSON))
    warnings_json: list = Field(default_factory=list, sa_column=Column(JSON))
    manifest_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class ScheduledTask(SQLModel, table=True):
    """Local scheduler registry for recurring maintenance jobs."""
    id: Optional[int] = Field(default=None, primary_key=True)
    key: str = Field(index=True)
    label: str = ""
    task_type: str = Field(default="maintenance", index=True)
    cadence_s: int = 86400
    status: str = Field(default="idle", index=True)
    enabled: bool = True
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = Field(default=None, index=True)
    payload_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=utcnow)


class BenchmarkRun(SQLModel, table=True):
    """Local benchmark/eval evidence for release confidence."""
    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = Field(index=True)
    status: str = Field(default="planned", index=True)
    metrics_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    environment_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class SourceRegistry(SQLModel, table=True):
    """Auditable source/provenance registry for the content firewall."""
    id: Optional[int] = Field(default=None, primary_key=True)
    key: str = Field(index=True)
    label: str = ""
    source_type: str = Field(default="unknown", index=True)
    license: Optional[str] = None
    eligibility_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    firewall_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class ValidatorRun(SQLModel, table=True):
    """Persisted validator/eval result for generated or imported content."""
    id: Optional[int] = Field(default=None, primary_key=True)
    q_type: str = Field(default="", index=True)
    section_type: Optional[SectionType] = Field(default=None, index=True)
    status: str = Field(default="unknown", index=True)
    score: Optional[float] = None
    failure_reasons_json: list = Field(default_factory=list, sa_column=Column(JSON))
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class LLMCacheEntry(SQLModel, table=True):
    """BACK-1 — durable content-addressed cache for DETERMINISTIC LLM responses.

    One row per ``cache_key`` (a host-parity SHA-256 hex of the frozen pre-image
    in ``app/llm/cache.py`` / ``src/lib/llm/determinism.js``). Only deterministic
    calls (temperature 0 or a pinned seed) are cached, so the stored ``response``
    is the reproducible output for that exact provider/model/system/format/
    sampling/prompt contract. Survives a restart — the in-memory LRU in
    ``llm.cache`` is just the
    hot tier in front of this table. ``hits`` counts re-reads for observability;
    ``key_version`` records the pre-image schema so a future format change can
    invalidate stale rows. Best-effort: a cache failure never breaks generation.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    cache_key: str = Field(index=True)
    key_version: int = Field(default=2, index=True)
    provider: str = ""
    model: str = ""
    response: str = Field(
        default="",
        sa_column=Column(EncryptedText("LLMCacheEntry.response")),
    )
    hits: int = 0
    created_at: datetime = Field(default_factory=utcnow, index=True)
    last_hit_at: Optional[datetime] = None


class SchedulerRun(SQLModel, table=True):
    """Append-only evidence for local maintenance/scheduled task execution."""
    id: Optional[int] = Field(default=None, primary_key=True)
    task_key: str = Field(index=True)
    task_type: str = Field(default="maintenance", index=True)
    status: str = Field(default="ok", index=True)
    duration_ms: float = 0.0
    result_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookPage(SQLModel, table=True):
    """Personal local LSAT notebook/wiki page with tags and generated summary."""
    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(index=True)
    slug: str = Field(index=True)
    body: str = ""
    summary: str = ""
    tags_json: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookQuestionLink(SQLModel, table=True):
    """Backlink from a notebook page to a question/attempt context."""
    id: Optional[int] = Field(default=None, primary_key=True)
    page_id: int = Field(foreign_key="notebookpage.id", index=True)
    question_id: int = Field(foreign_key="question.id", index=True)
    attempt_id: Optional[int] = Field(default=None, foreign_key="attempt.id", index=True)
    label: str = ""
    note: str = ""
    created_at: datetime = Field(default_factory=utcnow, index=True)


class RCPassageAnalysis(SQLModel, table=True):
    """Deterministic local structure map for an RC passage."""
    id: Optional[int] = Field(default=None, primary_key=True)
    passage_id: int = Field(foreign_key="passage.id", index=True)
    topic: Optional[str] = None
    structure_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    paragraph_roles_json: list = Field(default_factory=list, sa_column=Column(JSON))
    timing_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    generated_by: str = "local_heuristic_v1"
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookWorkspace(SQLModel, table=True):
    """Notebook OS workspace. Single-user default today, extensible later."""
    id: Optional[int] = Field(default=None, primary_key=True)
    key: str = Field(default="default", index=True)
    title: str = "LSAT Notebook OS"
    description: str = ""
    home_artifact_id: Optional[int] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class StudyArtifact(SQLModel, table=True):
    """Canonical searchable artifact: note, source, rationale, map, tutor answer."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    kind: str = Field(default="note", index=True)
    title: str = Field(index=True)
    body: str = ""
    summary: str = ""
    source_kind: str = Field(default="manual", index=True)
    q_type: Optional[str] = Field(default=None, index=True)
    question_id: Optional[int] = Field(default=None, foreign_key="question.id", index=True)
    attempt_id: Optional[int] = Field(default=None, foreign_key="attempt.id", index=True)
    passage_id: Optional[int] = Field(default=None, foreign_key="passage.id", index=True)
    visibility: str = Field(default="local", index=True)
    official_firewall: bool = Field(default=False, index=True)
    cloud_allowed: bool = Field(default=True, index=True)
    export_eligible: bool = Field(default=True, index=True)
    tags_json: list = Field(default_factory=list, sa_column=Column(JSON))
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class EvidenceRef(SQLModel, table=True):
    """A typed citation edge from an artifact to LSATLab evidence."""
    id: Optional[int] = Field(default=None, primary_key=True)
    artifact_id: int = Field(foreign_key="studyartifact.id", index=True)
    kind: str = Field(index=True)
    entity_id: str = Field(index=True)
    quote: str = ""
    range_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    line_ref: Optional[str] = None
    reveal_state: str = Field(default="safe", index=True)
    official_firewall: bool = Field(default=False, index=True)
    label: str = ""
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class Citation(SQLModel, table=True):
    """Resolved citation chip target for notes, tutor turns, and transforms."""
    id: Optional[int] = Field(default=None, primary_key=True)
    artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    target: str = Field(index=True)
    target_kind: str = Field(default="artifact", index=True)
    label: str = ""
    snippet: str = ""
    official_firewall: bool = Field(default=False, index=True)
    created_at: datetime = Field(default_factory=utcnow, index=True)


class Backlink(SQLModel, table=True):
    """Reverse link from an evidence target back to the artifact that cites it."""
    id: Optional[int] = Field(default=None, primary_key=True)
    source_artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    target_artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    target_ref: str = Field(index=True)
    relation: str = Field(default="cites", index=True)
    q_type: Optional[str] = Field(default=None, index=True)
    trap: Optional[str] = Field(default=None, index=True)
    role: Optional[str] = Field(default=None, index=True)
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class KnowledgeInboxItem(SQLModel, table=True):
    """Triage queue for captured evidence before it becomes polished study material."""
    id: Optional[int] = Field(default=None, primary_key=True)
    artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    origin: str = Field(default="capture", index=True)
    status: str = Field(default="open", index=True)
    priority: int = Field(default=0, index=True)
    reason: str = ""
    created_at: datetime = Field(default_factory=utcnow, index=True)
    resolved_at: Optional[datetime] = None


class ContextPreset(SQLModel, table=True):
    """Named retrieval/firewall preset for a Notebook OS workspace."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    name: str = Field(index=True)
    modes_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    policy_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class ArtifactVersion(SQLModel, table=True):
    """Append-only artifact snapshot for audit/restore and transformation outputs."""
    id: Optional[int] = Field(default=None, primary_key=True)
    artifact_id: int = Field(foreign_key="studyartifact.id", index=True)
    version: int = Field(default=1, index=True)
    snapshot_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    reason: str = ""
    created_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookSource(SQLModel, table=True):
    """A NotebookLM-style source normalized into LSATLab's local evidence graph."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    title: str = Field(index=True)
    source_type: str = Field(default="text", index=True)
    status: str = Field(default="ready", index=True)
    content_type: str = Field(default="text/plain", index=True)
    provider: str = Field(default="local", index=True)
    official_firewall: bool = Field(default=False, index=True)
    processing_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookNote(SQLModel, table=True):
    """Manual, AI-generated, captured, transformed, or journal note."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    note_type: str = Field(default="manual", index=True)
    title: str = Field(index=True)
    content: str = ""
    citations_json: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookChatSession(SQLModel, table=True):
    """Scoped Notebook OS tutor chat with explicit retrieval mode."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    title: str = Field(index=True)
    mode: str = Field(default="summary", index=True)
    model: str = Field(default="local", index=True)
    context_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class NotebookChatMessage(SQLModel, table=True):
    """Append-only chat message. Assistant turns store citation chips."""
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: int = Field(foreign_key="notebookchatsession.id", index=True)
    role: str = Field(default="user", index=True)
    content: str = ""
    citations_json: list = Field(default_factory=list, sa_column=Column(JSON))
    meta_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)


class TransformationRun(SQLModel, table=True):
    """Notebook transformation trace: prompt, inputs, citations, model, output."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    template_key: str = Field(default="summarize", index=True)
    status: str = Field(default="queued", index=True)
    prompt: str = ""
    input_refs_json: list = Field(default_factory=list, sa_column=Column(JSON))
    output_artifact_id: Optional[int] = Field(default=None, foreign_key="studyartifact.id", index=True)
    provider: str = Field(default="local", index=True)
    model: str = ""
    firewall_decision_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    metrics_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class PodcastEpisode(SQLModel, table=True):
    """Local-first audio briefing record with transcript and firewall proof."""
    id: Optional[int] = Field(default=None, primary_key=True)
    workspace_id: Optional[int] = Field(default=None, foreign_key="notebookworkspace.id", index=True)
    title: str = Field(index=True)
    episode_type: str = Field(default="weekly_briefing", index=True)
    status: str = Field(default="planned", index=True)
    transcript: str = ""
    audio_path: Optional[str] = None
    source_refs_json: list = Field(default_factory=list, sa_column=Column(JSON))
    provider: str = Field(default="local", index=True)
    firewall_decision_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    duration_sec: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class ActivityEvent(SQLModel, table=True):
    """Notebook OS activity center event for ingestion, jobs, exports, and checks."""
    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = Field(index=True)
    status: str = Field(default="done", index=True)
    title: str = ""
    detail_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    entity: str = Field(default="", index=True)
    entity_id: Optional[int] = Field(default=None, index=True)
    progress_pct: float = Field(default=100.0, index=True)
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class HostProgressSnapshot(SQLModel, table=True):
    """DATA-4a — read-only mirror of the HOST data plane's cross-domain progress.

    The host (CFA/Quant/Excel, Dexie) periodically POSTs its review/attempt/
    mastery snapshots — already projected onto the canonical cross-domain shapes
    (``src/lib/dataDictionary.ts`` / ``serializers.py`` ``cross_domain_*``) — to
    ``POST /api/sync/progress-updates``. This table is where they land so the
    LSAT ability/plan engine (LEARN-1/LEARN-3, later) can read host progress
    WITHOUT reaching back into the host's Dexie store.

    Strictly host -> backend: the backend NEVER mutates host data and never
    writes back through this row (that bidirectional per-card FSRS sync is the
    HIGH-risk DATA-4b, deferred to Wave 8). Rows are UPSERTED by ``cross_id``
    (the host's namespaced ``<plane>:<kind>:<nativeId>``), so a re-POST of the
    same logical row updates in place rather than duplicating — the idempotency
    contract. ``dedupe_key`` additionally fingerprints the payload so an
    unchanged re-POST can be recognised as a no-op without a row read.

    ``payload`` keeps the verbatim canonical record (CrossDomainReviewCard /
    CrossDomainAttempt / CrossDomainMastery) so a future engine reads exactly
    the host's vocabulary without lossy re-projection here.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    # The host's namespaced cross-domain id "<plane>:<kind>:<nativeId>" — the
    # UPSERT key (UNIQUE index added in migration 23). Idempotent by construction.
    cross_id: str = Field(index=True)
    # Snapshot kind discriminator: "review" | "attempt" | "mastery".
    kind: str = Field(index=True)
    # Originating host plane: "cfa" | "quant" | "excel" (never "lsat" here).
    plane: str = Field(index=True)
    # Stable content fingerprint of the payload (idempotency / dedupe): an
    # unchanged re-POST yields the same dedupe_key, so the upsert is a no-op.
    dedupe_key: str = Field(default="", index=True)
    # Verbatim canonical record as the host sent it (CrossDomainReviewCard /
    # CrossDomainAttempt / CrossDomainMastery). Read by the ability/plan engine.
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # When the host observed this snapshot (ISO 8601, as reported); optional.
    observed_at: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)
    # DATA-4b — write-back bookkeeping (additive, migration 27). ``sync_revision``
    # is bumped each time an accepted FSRS write-back mutates this mirrored card;
    # the host reads it back as a reconcile cursor. ``last_write_back_at`` records
    # when the last accepted write-back landed (NULL until the first one). The
    # read-only DATA-4a feed leaves them at their defaults.
    sync_revision: int = Field(default=0)
    last_write_back_at: Optional[datetime] = None


class CrossDomainSyncLog(SQLModel, table=True):
    """DATA-4b — idempotent, last-write-wins ledger for cross-domain FSRS
    write-backs.

    DATA-4a feeds the host's review/attempt/mastery snapshots into
    ``HostProgressSnapshot`` read-only. DATA-4b adds the WRITE side: the host
    pushes updated per-card FSRS scheduling state to
    ``POST /api/sync/fsrs-write-back``, which merges it into the mirrored snapshot
    (``HostProgressSnapshot.payload['fsrsState']``) under a last-write-wins rule
    and records EVERY accepted / rejected / deduped write here.

    Strictly host -> backend and confined to the host's own mirror: LSAT-native
    ``SRSCard`` scheduling is NEVER touched, so a write-back can't corrupt LSAT
    progress. Idempotent by ``write_id`` (the host's per-write key, UNIQUE index
    in migration 27): replaying a batch after an offline reconnect re-finds the
    prior log row and is a recognised no-op rather than a double-apply. The route
    echoes the reconciled authoritative ``fsrsState`` + ``sync_revision`` per card
    so the host can detect when last-write-wins kept a value other than the one it
    sent (the bidirectional reconcile) without the backend ever reaching into the
    host's Dexie store.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    # Host's per-write idempotency key (UNIQUE, migration 27). A replay re-finds
    # this row and is a no-op.
    write_id: str = Field(index=True)
    # The mirrored card this write targets: "<plane>:<kind>:<nativeId>".
    cross_id: str = Field(index=True)
    # Originating host plane parsed from cross_id ("cfa" | "quant" | "excel").
    source_plane: str = Field(default="", index=True)
    # Write target plane — always "lsat" (the backend mirror) for DATA-4b; the
    # reverse direction (backend -> host) stays deferred.
    target_plane: str = Field(default="lsat")
    # How the write resolved: "applied" | "kept_existing" (LWW kept the newer
    # stored state) | "noop_dedupe" (write_id already seen) | "no_target" (the
    # card has not been fed via DATA-4a yet).
    resolution: str = Field(default="", index=True)
    # The FSRS state before/after the write (audit + reconcile).
    fsrs_before: dict = Field(default_factory=dict, sa_column=Column(JSON))
    fsrs_after: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # When the host observed this scheduling state (ISO 8601) — the LWW key.
    observed_at: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class ExportHistory(SQLModel, table=True):
    """DATA-5 — provenance ledger for the unified {host, lsat} export/backup
    artifact.

    Every unified export build and every unified import records / refreshes one
    row here, keyed by the envelope's ``export_id`` (UNIQUE index added in
    migration 28). This makes "back up StudyVault" one auditable action: the user
    can see when each artifact was produced, what schema versions it carries, its
    checksum (sha256 of the canonical-JSON envelope sans ``checksum``), the
    per-table row counts, and how many times it has been restored from.

    Strictly local bookkeeping: this table NEVER carries question content (that
    lives in the envelope's ``data`` payload, which itself preserves
    ``bank_export``'s ``include_official=False`` firewall) — only metadata about
    artifacts. Re-importing the SAME ``export_id`` is idempotent: the row is found
    and its ``restore_count`` / ``last_restored`` are bumped rather than
    duplicated.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    # The envelope's exportId — the UPSERT key (UNIQUE index, migration 28).
    export_id: str = Field(index=True)
    # When the artifact was produced (ISO 8601, mirrors the envelope's exportedAt).
    exported_at: str = Field(default="")
    # The unified-envelope schema version this row was written under.
    schema_version: int = Field(default=1)
    # The host's Dexie VAULT_SCHEMA_VERSION when the host half was included; NULL
    # for an LSAT-only artifact (no host payload).
    host_schema_version: Optional[int] = None
    # Artifact format discriminator (e.g. "unified-json").
    fmt: str = Field(default="unified-json")
    # True when this row was written by the source machine's export build; False
    # when written/updated by an import on a (possibly different) machine.
    source_host: bool = Field(default=True)
    # Per-table row counts captured at build time (audit + quick diff).
    row_counts: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # sha256 of the canonical-JSON envelope (sans the ``checksum`` field itself).
    checksum: str = Field(default="")
    # How many times this artifact has been imported/restored from.
    restore_count: int = Field(default=0)
    # When the last restore from this artifact landed (NULL until the first).
    last_restored: Optional[datetime] = None
    # Free-text operator note (optional).
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)
