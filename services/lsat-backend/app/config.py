"""Runtime configuration. Every value is overridable via environment variables."""
from __future__ import annotations

import logging as _logging
import os
import re
import sys
from pathlib import Path

# Project root = backend/
BASE_DIR = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


# Single source of truth for the backend version; kept in sync with the frontend
# package.json / tauri.conf (0.9.0). FastAPI's version is read from here.
APP_VERSION = _env("LSATLAB_APP_VERSION", "0.9.0")


# --- App data directory (S2) ------------------------------------------------
def _default_data_dir() -> Path:
    """Base dir for the DB, logs, backups, and exports.

    - ``LSATLAB_DATA_DIR`` wins (the Tauri sidecar can point it at the install's
      data dir);
    - a frozen (PyInstaller) build relocates to the OS app-data dir so a packaged
      install never writes into Program Files / the app bundle;
    - otherwise (dev / running from source) everything stays under ``backend/``
      for easy inspection. Tests set ``LSATLAB_DB`` explicitly, so they are
      unaffected by this.
    """
    explicit = os.environ.get("LSATLAB_DATA_DIR")
    if explicit:
        return Path(explicit)
    if getattr(sys, "frozen", False):  # packaged sidecar binary
        if sys.platform == "win32":
            base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        elif sys.platform == "darwin":
            base = str(Path.home() / "Library" / "Application Support")
        else:
            base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        return Path(base) / "LSATLab"
    return BASE_DIR


DATA_DIR = _default_data_dir()
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass

# --- Database ---------------------------------------------------------------
DB_PATH = Path(_env("LSATLAB_DB", str(DATA_DIR / "lsatlab.db")))
DB_URL = f"sqlite:///{DB_PATH.as_posix()}"
# vNext trust gate: SQLite foreign-key enforcement is ON by default for the app.
# Tests that still need loose fixture insert-order explicitly set
# LSATLAB_SQLITE_FK=0 before importing app modules.
SQLITE_FK_ENFORCE = _env("LSATLAB_SQLITE_FK", "1") not in ("0", "false", "False")
# Two writers share this SQLite file (FastAPI request threads + the background
# job worker). A busy_timeout makes a writer WAIT-and-retry instead of failing
# instantly with "database is locked"; WAL (enabled in db.py) additionally lets a
# reader and a writer proceed concurrently. See db.py's connection-PRAGMA listener.
SQLITE_BUSY_TIMEOUT_MS = int(_env("LSATLAB_SQLITE_BUSY_TIMEOUT_MS", "5000") or "5000")

# Local DB snapshots (D4) and report/bank exports follow the data dir too.
BACKUP_DIR = Path(_env("LSATLAB_BACKUP_DIR", str(DATA_DIR / "backups")))
EXPORT_DIR = Path(_env("LSATLAB_EXPORT_DIR", str(DATA_DIR / "exports")))

# --- Ollama -----------------------------------------------------------------
OLLAMA_URL = _env("LSATLAB_OLLAMA_URL", "http://localhost:11434").rstrip("/")
# Bank-expansion plan Wave 1.5 — Phi-4 14B is the Tier-A default explainer
# (better LSAT explanation quality at comparable VRAM). ``ai.py`` falls back to
# ``EXPLAIN_FALLBACK_MODEL`` (qwen3:8b) on startup if Phi-4 isn't pulled, so
# existing installs keep working.
EXPLAIN_MODEL = _env("LSATLAB_EXPLAIN_MODEL", "phi4:14b")
EXPLAIN_FALLBACK_MODEL = _env("LSATLAB_EXPLAIN_FALLBACK_MODEL", "qwen3:8b")
GEN_MODEL = _env("LSATLAB_GEN_MODEL", "qwen3:14b")
DIAGNOSE_MODEL = _env("LSATLAB_DIAGNOSE_MODEL", "qwen3:8b")
# Tagging is Tier-A but only needs short structured JSON, so it can run on a
# smaller/faster local model than the explainer. Empty default => fall back to
# EXPLAIN_MODEL (no behaviour change until LSATLAB_TAG_MODEL is set). Always local.
TAG_MODEL = _env("LSATLAB_TAG_MODEL", "")

# Generation tuning (kept small so background jobs stay fast / never hang).
GEN_SELF_CONSISTENCY_RUNS = int(_env("LSATLAB_GEN_SC_RUNS", "3"))
GEN_REQUEST_TIMEOUT_S = float(_env("LSATLAB_GEN_TIMEOUT", "120"))
EXPLAIN_REQUEST_TIMEOUT_S = float(_env("LSATLAB_EXPLAIN_TIMEOUT", "120"))

# --- R7 Wave 3a: the generation gate (deterministic, decorrelated, structured) -
# A SEPARATE critic model decorrelates the gate from the generator: a model that
# writes a subtly-broken item tends to "solve" and "approve" its own output
# (correlated errors). Uses a DIFFERENT model family from GEN_MODEL (qwen3:14b)
# so the gate cannot be gamed by correlated failure modes in a single model
# family. B19: changed default from qwen3:14b to llama3.1:8b for decorrelation.
GEN_CRITIC_MODEL = _env("LSATLAB_GEN_CRITIC_MODEL", "llama3.1:8b")
# Deterministic params for the gate's SOLVE/CRITIQUE calls: temperature 0 + a
# fixed seed makes the correctness signal measure ITEM SOUNDNESS, not sampling
# luck (Ollama honours both via the `options` block).
GEN_GATE_TEMPERATURE = float(_env("LSATLAB_GEN_GATE_TEMP", "0") or "0")
GEN_GATE_SEED = int(_env("LSATLAB_GEN_GATE_SEED", "7"))
# Candidate generation wants some diversity, so it runs at a non-zero temperature
# but still asks Ollama for `format:"json"` so malformed candidates fail loudly
# instead of being silently regex-scraped to nothing.
GEN_CANDIDATE_TEMPERATURE = float(_env("LSATLAB_GEN_CAND_TEMP", "0.8") or "0.8")
# Ask the provider for guaranteed-JSON output (Ollama `format:"json"` / Anthropic
# tool-use). _extract_json stays as a fallback either way.
GEN_STRUCTURED_OUTPUT = _env("LSATLAB_GEN_STRUCTURED", "1") not in ("0", "false", "False")
# Bank-expansion plan Wave 1.3 — tighten the structured-output hint to a real
# JSON Schema (``_CANDIDATE_SCHEMA`` in generation.py) so the model's response
# is constrained to a 5-choice A-E candidate envelope at decode time. Falls
# back to ``format="json"`` when the provider doesn't support schema dicts.
GEN_STRUCTURED_SCHEMA = _env("LSATLAB_GEN_STRUCTURED_SCHEMA", "1") not in (
    "0", "false", "False",
)
# Embedding dedup gate (2.9): reject a candidate whose cosine similarity to an
# existing bank item is >= this. No-ops gracefully if embeddings are unavailable.
GEN_DEDUP_THRESHOLD = float(_env("LSATLAB_GEN_DEDUP_THRESHOLD", "0.93") or "0.93")
# Bank-expansion plan Wave 3.4 — per-section novelty thresholds (RC passages
# share more vocabulary, so the bar is slightly higher).
GEN_DEDUP_THRESHOLD_LR = float(
    _env("LSATLAB_GEN_DEDUP_THRESHOLD_LR", "0.92") or "0.92"
)
GEN_DEDUP_THRESHOLD_RC = float(
    _env("LSATLAB_GEN_DEDUP_THRESHOLD_RC", "0.94") or "0.94"
)
# Wave 3.3 — import-time embedding dedup tiers.
IMPORT_DEDUP_SKIP = float(_env("LSATLAB_IMPORT_DEDUP_SKIP", "0.98") or "0.98")
IMPORT_DEDUP_QUARANTINE = float(
    _env("LSATLAB_IMPORT_DEDUP_QUARANTINE", "0.93") or "0.93"
)
# Embed each row after import (needed for import-time dedup). Off in tests.
IMPORT_EMBED_ON_COMMIT = _env("LSATLAB_IMPORT_EMBED_ON_COMMIT", "1") not in (
    "0", "false", "False",
)
# Hard cap on an uploaded PrepTest PDF (bytes). The /import/parse route reads the
# whole upload into memory, so an accidental huge/scanned PDF could exhaust the
# local sidecar's memory; oversize uploads are rejected with HTTP 413. 50 MB by
# default — comfortably above a real LSAT PrepTest PDF.
MAX_PDF_UPLOAD_BYTES = int(
    _env("LSATLAB_MAX_PDF_BYTES", str(50 * 1024 * 1024)) or str(50 * 1024 * 1024)
)
# Wave 3.2 — comma-separated local solver models for multi-model agreement.
GEN_SOLVER_MODELS = [
    m.strip()
    for m in (_env(
        "LSATLAB_GEN_SOLVER_MODELS",
        "qwen3:14b,llama3.1:8b,gemma4:e4b-thinking",
    ) or "").split(",")
    if m.strip()
]
# Wave 3.2 — require 2-of-3 local solver models to agree (identity permutation).
GEN_MULTI_MODEL_AGREEMENT = _env("LSATLAB_GEN_MULTI_MODEL_AGREEMENT", "1") not in (
    "0", "false", "False",
)
# Wave 5.1 — plan-then-write: outline JSON before full candidate JSON.
GEN_PLAN_THEN_WRITE = _env("LSATLAB_GEN_PLAN_THEN_WRITE", "0") not in (
    "0", "false", "False",
)
# Wave 5.3 — one salvage rewrite pass before quarantining a failed candidate.
GEN_SALVAGE_REWRITE = _env("LSATLAB_GEN_SALVAGE_REWRITE", "0") not in (
    "0", "false", "False",
)


def gen_dedup_threshold_for(
    q_type: str | None, *, section_type: str = "LR",
) -> float:
    """Novelty gate threshold: RC is stricter (more shared passage vocabulary)."""
    del q_type  # reserved for future per-q_type overrides
    if section_type == "RC":
        return GEN_DEDUP_THRESHOLD_RC
    return GEN_DEDUP_THRESHOLD_LR
# Bank-expansion plan Wave 2.1 — permutation-invariant self-consistency. When
# on, the solver is also asked to solve the candidate under K shuffled choice
# orders; the solved letter, mapped back through the permutation, must agree
# with the credited answer every time. Catches positional bias.
GEN_PERMUTATION_SC = _env("LSATLAB_GEN_PERMUTATION_SC", "1") not in (
    "0", "false", "False",
)
# Bank-expansion plan Wave 2.2 — Säuberli text-informativity probe. When on,
# the candidate is also solved WITHOUT the stimulus (replaced by a placeholder).
# If the solver picks the credited letter from choices alone, the item is
# uninformative (the answer "tells" via choice content) and is rejected.
GEN_INFORMATIVITY_CHECK = _env("LSATLAB_GEN_INFORMATIVITY_CHECK", "1") not in (
    "0", "false", "False",
)
# Generation quality moat: the critic must verify that every wrong answer is a
# plausible LSAT trap, not a throwaway distractor. Tests opt out by default and
# enable this in focused cases with richer critic stubs.
GEN_DISTRACTOR_QUALITY_CHECK = _env(
    "LSATLAB_GEN_DISTRACTOR_QUALITY_CHECK", "1"
) not in ("0", "false", "False")
# Bank-expansion plan Wave 1.4 — stem-answer lexical-leak ratio. Reject a
# candidate if the credited choice's tf-idf overlap with the stimulus is more
# than this multiple of the median distractor's overlap (i.e. the answer
# "tells" because it shares words with the stem). Disabled with <= 0.
GEN_LEAK_RATIO = float(_env("LSATLAB_GEN_LEAK_RATIO", "1.5") or "1.5")
# Bank-expansion plan Wave 2.6 — training-flagged items are preferred few-shot
# anchors for Tier-B generation. This is the integer weight a flagged parent
# gets in the rotation vs an un-flagged parent (1 = no preference). 4 means a
# flagged parent is picked roughly 4x as often.
GEN_TRAINING_ANCHOR_WEIGHT = int(
    _env("LSATLAB_GEN_TRAINING_ANCHOR_WEIGHT", "4") or "4"
)
# 2.8 difficulty calibration: minimum non-blind-review attempts before a
# question's empirical_difficulty is recomputed from observed accuracy.
CALIBRATION_MIN_ATTEMPTS = int(_env("LSATLAB_CALIBRATION_MIN_ATTEMPTS", "5"))

# --- CORS -------------------------------------------------------------------
# B22: configurable embedding request timeout (seconds).
EMBED_REQUEST_TIMEOUT_S = float(_env("LSATLAB_EMBED_TIMEOUT", "30") or "30")

# B3: CORS origins are validated: '*' is rejected (over-permissive) and each
# origin must match the expected scheme pattern to prevent misconfiguration.
_CORS_ORIGIN_RE = re.compile(r"^(https?://|tauri://)[A-Za-z0-9.\-:_/]+$")


def _parse_cors_origins(raw: str) -> list[str]:
    valid: list[str] = []
    for o in raw.split(","):
        o = o.strip()
        if not o:
            continue
        if o == "*":
            _logging.getLogger("lsatlab.config").warning(
                "CORS origin '*' is not allowed and has been dropped"
            )
            continue
        if not _CORS_ORIGIN_RE.match(o):
            _logging.getLogger("lsatlab.config").warning(
                "Invalid CORS origin %r dropped (must match ^(https?://|tauri://)[...]+$)", o
            )
            continue
        valid.append(o)
    return valid


CORS_ORIGINS = _parse_cors_origins(
    _env("LSATLAB_CORS_ORIGINS", "http://localhost:5173,tauri://localhost")
)

# --- Logging ----------------------------------------------------------------
# Logs are written locally only (rotating file + console). We never ship them to
# a remote service: this is a private, offline app. Defaults to a logs/ dir next
# to the SQLite file so it follows the app data dir.
LOG_DIR = Path(_env("LSATLAB_LOG_DIR", str(DB_PATH.parent / "logs")))
LOG_LEVEL = _env("LSATLAB_LOG_LEVEL", "INFO").upper()
LOG_TO_CONSOLE = _env("LSATLAB_LOG_CONSOLE", "1") not in ("0", "false", "False")

# --- Spaced repetition (FSRS, 3.2) ------------------------------------------
# Target probability of recall at review time. FSRS schedules each card's next
# interval so its predicted retrievability equals this. Lower = longer intervals
# / fewer reviews (more efficient, more forgetting); higher = shorter intervals.
# Runtime-overridable (settings_store key "desired_retention").
SRS_DESIRED_RETENTION = float(_env("LSATLAB_SRS_DESIRED_RETENTION", "0.9") or "0.9")
# A card is flagged a "leech" once its lapses reach this many (remediation queue).
SRS_LEECH_THRESHOLD = int(_env("LSATLAB_SRS_LEECH_THRESHOLD", "8"))
# 3.4 — questions attempted within this many days are excluded from fresh drills
# (so re-drilling a type doesn't re-serve items you just saw). 0 disables.
DRILL_EXCLUDE_RECENT_DAYS = int(_env("LSATLAB_DRILL_EXCLUDE_RECENT_DAYS", "3"))
# Minimum number of logged reviews before weight optimization is even attempted
# (py-fsrs's own optimizer additionally needs ~512 review-state reviews + torch,
# so this is a cheap early-out, not the real bar).
SRS_OPTIMIZE_MIN_REVIEWS = int(_env("LSATLAB_SRS_OPTIMIZE_MIN_REVIEWS", "200"))

# --- LLM providers & resilience ---------------------------------------------
# Realtime explain/diagnose/tag always use local Ollama. Offline Tier-B
# generation MAY optionally use a cloud provider (see GEN_PROVIDER) — never the
# realtime path and never score-affecting content (docs/00-vision.md).
LLM_MAX_RETRIES = int(_env("LSATLAB_LLM_RETRIES", "2"))          # transient-error retries
LLM_MAX_CONCURRENCY = int(_env("LSATLAB_LLM_CONCURRENCY", "2"))  # cap concurrent GPU calls
EMBED_MODEL = _env("LSATLAB_EMBED_MODEL", "nomic-embed-text")
# BA7 — optional secondary embed model. When the primary EMBED_MODEL embed call
# fails (model not pulled, provider switched, transient error) the embeddings
# layer falls back ONCE to this model for the rest of the session. Empty default
# => no fallback (preserve the graceful no-op behaviour: the bank stays drillable
# even with no embeddings). Env-overridable like the other config values.
EMBED_MODEL_FALLBACK = _env("LSATLAB_EMBED_MODEL_FALLBACK", "")
# Wave 3.5 — bump when the embed model changes; stale vectors are purged on
# startup backfill.
EMBED_MODEL_VERSION = _env("LSATLAB_EMBED_MODEL_VERSION", "1") or "1"
# Vector-search backend for the RAG/dedup layer. "auto" uses sqlite-vec's fast
# native cosine when the package loads (else falls back to pure-Python cosine);
# "cosine" forces pure-Python; "sqlite-vec" prefers it but still falls back if it
# can't load. The pure-Python path is always correct, so this knob is purely perf.
VECTOR_BACKEND = _env("LSATLAB_VECTOR_BACKEND", "auto").lower()

# Local inference provider for the realtime (explain/diagnose/tag), embedding,
# and *local* offline-generation paths. "ollama" (default) talks to Ollama;
# "lmstudio" talks to an OpenAI-compatible LMStudio server (see LMSTUDIO_URL).
# Orthogonal to GEN_PROVIDER: GEN_PROVIDER=cloud still routes offline generation
# to Anthropic regardless of the local provider. Runtime-overridable (settings
# key "local_provider").
LOCAL_PROVIDER = _env("LSATLAB_LOCAL_PROVIDER", "ollama").lower()  # "ollama" | "lmstudio"
# LMStudio's OpenAI-compatible base URL (it already includes the /v1 prefix).
# Runtime-overridable (settings key "lmstudio_url").
LMSTUDIO_URL = _env("LSATLAB_LMSTUDIO_URL", "http://localhost:1234/v1").rstrip("/")

GEN_PROVIDER = _env("LSATLAB_GEN_PROVIDER", "ollama").lower()    # "ollama" | "cloud"


def _default_enforce_offline() -> bool:
    """Default state of the strict-offline fence (AI-10).

    StudyVault's defining invariant is "works on a plane": no cloud, no
    telemetry. The optional cloud provider (``GEN_PROVIDER=cloud``) stays in the
    tree for opt-out/standalone use, but in the normal app build the fence is ON
    so selecting it raises loudly instead of quietly reaching api.anthropic.com.

    The test suite exercises the cloud code paths directly (faked HTTP), so the
    fence defaults OFF under pytest — detected the same way the rest of the suite
    sets its hermetic env: a pytest run sets ``PYTEST_CURRENT_TEST`` / imports the
    ``pytest`` module. An explicit ``LSATLAB_ENFORCE_OFFLINE`` always wins, so a
    test (or a CI egress check) can still force either state.
    """
    explicit = os.environ.get("LSATLAB_ENFORCE_OFFLINE")
    if explicit is not None:
        return explicit not in ("0", "false", "False")
    under_pytest = (
        "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules
    )
    return not under_pytest


# AI-10 — strict offline provider fence. When ON (the default in the packaged
# StudyVault build) any attempt to SELECT/INSTANTIATE the cloud provider raises a
# clear RuntimeError naming the offending env var, making the cloud egress path
# unreachable. Off (opt-out) only when LSATLAB_ENFORCE_OFFLINE=0 — or implicitly
# under pytest so the suite can still cover the cloud code with faked HTTP.
ENFORCE_OFFLINE = _default_enforce_offline()
CLOUD_API_KEY = _env("LSATLAB_CLOUD_API_KEY", "") or _env("ANTHROPIC_API_KEY", "")
# B20: Updated default from "claude-opus-4-7" (invalid slug) to a known-good
# Anthropic model ID. Override via LSATLAB_CLOUD_GEN_MODEL.
CLOUD_GEN_MODEL = _env("LSATLAB_CLOUD_GEN_MODEL", "claude-3-5-sonnet-20241022")
CLOUD_API_URL = _env("LSATLAB_CLOUD_API_URL", "https://api.anthropic.com/v1/messages")
CLOUD_MAX_TOKENS = int(_env("LSATLAB_CLOUD_MAX_TOKENS", "2048"))
# 7.3 — hard ceiling on opt-in cloud spend. 0 (default) means "no budget set" =>
# unlimited (cloud stays opt-in either way). When > 0 the facade refuses a cloud
# Tier-B call once month-to-date spend in the UsageLedger would exceed it and
# falls back to the local model. The local Ollama path is never budget-limited.
CLOUD_MONTHLY_BUDGET_USD = float(_env("LSATLAB_CLOUD_MONTHLY_BUDGET_USD", "0") or "0")
# 7.3 — cost-per-token (USD) used to price each cloud call into the ledger. Per
# *million* tokens for ergonomics; defaults track Claude Opus list pricing. Both
# are env-overridable so the budget gauge stays accurate if pricing/model change.
CLOUD_INPUT_COST_PER_MTOK = float(
    _env("LSATLAB_CLOUD_INPUT_COST_PER_MTOK", "15.0") or "15.0"
)
CLOUD_OUTPUT_COST_PER_MTOK = float(
    _env("LSATLAB_CLOUD_OUTPUT_COST_PER_MTOK", "75.0") or "75.0"
)
# BB4 — cloud DRY-RUN. When on, the budget endpoint forecasts the cost of the
# *next* cloud call (priced like a real call) without ever invoking the provider.
# This is the read-only "what would this cost" affordance the System Health card
# shows; it never changes the enforcement path (offline_generate still gates on
# the real worst-case estimate). Off by default — purely a visibility toggle.
CLOUD_DRY_RUN = _env("LSATLAB_CLOUD_DRY_RUN", "0") not in ("0", "false", "False")
# BB4 — representative token counts for the NEXT-CALL dry-run cost estimate the
# budget endpoint returns when the caller doesn't pass explicit input/output
# token query params. Sized to a typical Tier-B generation call (a few-shot
# prompt in, a 5-choice candidate out, capped by CLOUD_MAX_TOKENS).
CLOUD_DRY_RUN_INPUT_TOKENS = int(
    _env("LSATLAB_CLOUD_DRY_RUN_INPUT_TOKENS", "1500") or "1500"
)
CLOUD_DRY_RUN_OUTPUT_TOKENS = int(
    _env("LSATLAB_CLOUD_DRY_RUN_OUTPUT_TOKENS", "800") or "800"
)

# --- BB4: local Whisper / voice model cache visibility -----------------------
# Voice input (offline STT) runs the Whisper-tiny ONNX model in the BROWSER via
# @huggingface/transformers (see src/lib/voice.js); transformers.js downloads it
# once and caches it client-side (Cache Storage / IndexedDB). The host is the
# authoritative place to read that cache, so the backend's role here is to report
# the *configuration* (which model, where a server-side cache would live) and a
# best-effort presence check of that optional on-disk cache dir. The browser-STT
# (Web Speech API) fallback is always available and needs no download. All of
# this is read-only and best-effort: never raise from the status helper.
VOICE_MODEL_ID = _env("LSATLAB_VOICE_MODEL_ID", "Xenova/whisper-tiny.en")
# Optional server-side transformers cache dir (the env var transformers.js / the
# Python `transformers` lib honour). When unset we fall back to the conventional
# HuggingFace hub cache so the presence check still has something to look at.
VOICE_MODEL_CACHE_DIR = Path(
    _env(
        "LSATLAB_VOICE_MODEL_CACHE_DIR",
        _env("TRANSFORMERS_CACHE", "")
        or _env("HF_HOME", "")
        or str(DATA_DIR / "voice-models"),
    )
)

# --- Background job worker --------------------------------------------------
# One in-process worker thread drains queued generation jobs sequentially (a
# single local GPU saturates under parallelism). Durable: jobs live in SQLite,
# so a queued job survives a restart and is picked up again. Disabled in tests
# so queued jobs never auto-invoke the model.
JOBS_WORKER_ENABLED = _env("LSATLAB_JOBS_WORKER", "1") not in ("0", "false", "False")
# First-run convenience: when set, seed the bundled sample content if the DB has
# no questions yet (e.g. a packaged install before the user imports a PrepTest).
# OFF by default — the normal first-run story is the onboarding "import a PrepTest"
# flow, and the dev seed is placeholder content we don't want in a real install.
SEED_ON_EMPTY = _env("LSATLAB_SEED_ON_EMPTY", "0") not in ("0", "false", "False")
JOBS_POLL_INTERVAL_S = float(_env("LSATLAB_JOBS_POLL", "1.0"))

# The worker also refreshes the coach diagnosis snapshot on idle ticks, at most
# this often, and only when the existing snapshot is older than the max age.
DIAGNOSIS_INTERVAL_S = float(_env("LSATLAB_DIAGNOSIS_INTERVAL", "21600"))   # 6h
DIAGNOSIS_MAX_AGE_S = float(_env("LSATLAB_DIAGNOSIS_MAX_AGE", "82800"))     # 23h

# 2.8/7.x — the worker also recomputes empirical difficulty on idle ticks, at
# most this often (daily by default), so calibration stays fresh without a
# manual /gen/calibrate-difficulty call. Throttled like the daily DB snapshot.
CALIBRATION_INTERVAL_S = float(_env("LSATLAB_CALIBRATION_INTERVAL", "86400"))  # 24h

# Auto-generate a short Tier-A diagnosis when an error-log entry is saved.
# Runs as a background task; disabled in tests so saves never call the model.
ERRORLOG_AUTODIAGNOSE = _env("LSATLAB_ERRORLOG_AUTODIAGNOSE", "1") not in ("0", "false", "False")
