"""Lightweight, ordered, recorded schema migrations.

Why this exists
---------------
``db.init_db`` auto-creates new tables (``create_all``) and can ADD nullable
columns to existing ones, but it cannot rename, change a type, add an index or
constraint on a populated table, or backfill data — and it keeps no record of
what ran. As the schema grows (embeddings, study plans, settings) we need
ordered, *recorded* migrations without taking on Alembic for a single-user local
SQLite DB.

How it works
------------
- A ``schema_migrations`` table records each applied ``(version, name, applied_at)``.
- ``MIGRATIONS`` is an ordered list of ``(version, name, fn)``. ``run_migrations``
  applies every entry whose version has not been recorded yet, in ascending
  order, each in its own transaction, then records it.
- Migration functions get a raw DBAPI connection (``conn.exec_driver_sql(...)``)
  so they can run arbitrary SQLite DDL. They MUST be written idempotently
  (``IF NOT EXISTS`` etc.) so a half-applied run is safe to retry.
"""
from __future__ import annotations

import json
import logging
import hashlib
import inspect
from collections.abc import Callable
from datetime import datetime, timezone

log = logging.getLogger("lsatlab.migrations")

Migration = tuple[int, str, Callable[[object], None]]

# --- DATA-3 cross-domain schema-version handshake ----------------------------
# The version of the SHARED cross-domain field-semantics contract this backend
# build speaks (pinned by docs/DATA-DICTIONARY.md + mirrored by the host's
# ``CROSS_DOMAIN_SCHEMA_VERSION`` in src/lib/dataDictionary.ts). Bumped ONLY when
# a shared field's MEANING changes — deliberately distinct from the SQLite
# ``PRAGMA user_version`` (the migration ledger) and the host Dexie
# ``VAULT_SCHEMA_VERSION``. Recorded in SQLite by migration 22 and exposed at
# ``GET /api/observability/schema-versions`` so the host can detect an
# incompatible peer BEFORE attempting a cross-domain write.
CROSS_DOMAIN_SCHEMA_VERSION = 1
# The oldest host cross-domain contract this backend will still accept (it speaks
# v1 and accepts v1). Surfaced to the host so a newer backend can still serve an
# older-but-supported host read-only-safely.
CROSS_DOMAIN_HOST_MIN_SUPPORTED = 1
# The persisted-version key inside the ``schema_meta`` table migration 22 creates.
CROSS_DOMAIN_SCHEMA_KEY = "cross_domain_schema_version"


def _ensure_table(conn) -> None:
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    _ensure_integrity_table(conn)


def _ensure_integrity_table(conn) -> None:
    """Create the checksum/status ledger used by the vNext release gate.

    ``schema_migrations`` intentionally stays tiny and backwards-compatible.
    This companion table records mutable operational state: checksum, running /
    applied / failed status, timing, and the last failure text.
    """
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS schema_migration_integrity ("
        "version INTEGER PRIMARY KEY, "
        "name TEXT NOT NULL, "
        "checksum TEXT NOT NULL, "
        "started_at TEXT, "
        "finished_at TEXT, "
        "status TEXT NOT NULL, "
        "error TEXT)"
    )


def _migration_checksum(fn: Callable[[object], None]) -> str:
    try:
        body = inspect.getsource(fn)
    except (OSError, TypeError):
        body = f"{fn.__module__}.{getattr(fn, '__qualname__', repr(fn))}:{fn.__doc__ or ''}"
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _record_integrity(
    conn,
    *,
    version: int,
    name: str,
    checksum: str,
    status: str,
    started_at: str | None,
    finished_at: str | None,
    error: str | None,
) -> None:
    _ensure_integrity_table(conn)
    conn.exec_driver_sql(
        "INSERT INTO schema_migration_integrity "
        "(version, name, checksum, started_at, finished_at, status, error) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(version) DO UPDATE SET "
        "name=excluded.name, checksum=excluded.checksum, "
        "started_at=excluded.started_at, finished_at=excluded.finished_at, "
        "status=excluded.status, error=excluded.error",
        (version, name, checksum, started_at, finished_at, status, error),
    )


def _backfill_integrity(conn, migrations: list[Migration]) -> None:
    """Ensure legacy-applied migrations have checksum rows too."""
    done = _applied_versions(conn)
    for version, name, fn in migrations:
        if version not in done:
            continue
        checksum = _migration_checksum(fn)
        row = conn.exec_driver_sql(
            "SELECT checksum, status FROM schema_migration_integrity WHERE version=?",
            (version,),
        ).fetchone()
        if row is None:
            _record_integrity(
                conn,
                version=version,
                name=name,
                checksum=checksum,
                status="applied",
                started_at=None,
                finished_at=None,
                error=None,
            )


def _applied_versions(conn) -> set[int]:
    _ensure_table(conn)
    rows = conn.exec_driver_sql("SELECT version FROM schema_migrations").fetchall()
    return {int(r[0]) for r in rows}


def _add_column_idempotent(conn, sql: str, *, mig: str) -> None:
    """Run an ``ALTER TABLE ... ADD COLUMN``, tolerating ONLY 'duplicate column
    name' (the column already exists because ``create_all`` added it on a fresh
    DB). Any OTHER failure (bad type, locked table) re-raises, so the migration is
    NOT recorded as applied while silently missing the column — the previous broad
    ``except Exception`` masked genuine ALTER failures and logged a warning on
    every fresh-DB start."""
    try:
        conn.exec_driver_sql(sql)
    except Exception as exc:  # noqa: BLE001
        if "duplicate column name" in str(exc).lower():
            log.debug("%s: column already present (%s)", mig, sql)
            return
        raise


def _table_columns(conn, table: str) -> set[str]:
    """Return the set of existing column names on ``table`` (empty if missing).

    SQLite has no ``ADD COLUMN IF NOT EXISTS``; this PRAGMA check is the guard the
    additive migrations use to stay idempotent on a DB that already has the column
    (e.g. ``create_all`` added it on a fresh DB, or an older recorded migration /
    the legacy ``_apply_additive_migrations`` step already ran)."""
    try:
        rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    except Exception:  # pragma: no cover - missing table on a partial/old DB
        return set()
    return {str(row[1]) for row in rows}


def _add_column_if_missing(conn, table: str, column: str, ddl: str, *, mig: str) -> None:
    """Idempotent ``ALTER TABLE <table> ADD COLUMN <ddl>`` guarded by a
    ``PRAGMA table_info`` existence check (SQLite lacks ADD COLUMN IF NOT EXISTS).

    A DB that already has the column is a no-op and never errors. A missing table
    is skipped (the table is created by ``create_all`` on a fresh DB; on an old
    partial DB it simply may not exist yet)."""
    existing = _table_columns(conn, table)
    if not existing:
        log.warning("%s: table %s absent — skipped ADD COLUMN %s", mig, table, column)
        return
    if column in existing:
        log.debug("%s: column %s.%s already present", mig, table, column)
        return
    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {ddl}")


# --- migration functions ----------------------------------------------------
def _m001_hot_path_indexes(conn) -> None:
    """Composite indexes for the hottest query paths as the bank grows to
    thousands of items: drill selection and per-session analytics."""
    statements = (
        "CREATE INDEX IF NOT EXISTS ix_question_qtype_difficulty "
        "ON question (q_type, difficulty)",
        "CREATE INDEX IF NOT EXISTS ix_question_source "
        "ON question (source)",
        "CREATE INDEX IF NOT EXISTS ix_question_qtype_source "
        "ON question (q_type, source)",
        "CREATE INDEX IF NOT EXISTS ix_attempt_session_mode "
        "ON attempt (session_id, mode)",
    )
    for sql in statements:
        conn.exec_driver_sql(sql)


def _m002_embedding_unique_index(conn) -> None:
    """One embedding per (kind, ref_id); also the lookup index for upserts."""
    conn.exec_driver_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_embedding_kind_ref "
        "ON embeddingvector (kind, ref_id)"
    )


def _m003_annotation_unique_index(conn) -> None:
    """One annotation row per (scope, ref_id); the upsert lookup index."""
    conn.exec_driver_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_annotation_scope_ref "
        "ON annotation (scope, ref_id)"
    )


def _m004_scale_indexes(conn) -> None:
    """P2 — index the remaining hot columns as the bank/history grow:
    - attempt(created_at): the ?days= analytics window now filters in SQL.
    - genjob(status): the durable worker polls status='queued' and the
      observability status counts queued/running jobs."""
    for sql in (
        "CREATE INDEX IF NOT EXISTS ix_attempt_created ON attempt (created_at)",
        "CREATE INDEX IF NOT EXISTS ix_genjob_status ON genjob (status)",
    ):
        conn.exec_driver_sql(sql)


def _m005_provenance_immutable(conn) -> None:
    """D2 — provenance is the legal + scoring boundary, so make ``question.source``
    immutable at the DB level. The score-prediction rule ('official only') and
    the redistribution rule ('only ai_generated/sample are shareable') both hinge
    on source never silently changing under an app bug. Fires only on an actual
    change; insertion and same-value updates are unaffected (generation/import set
    source on insert, the tagger only touches q_type/difficulty/tag_confidence)."""
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_source_immutable "
        "BEFORE UPDATE OF source ON question "
        "FOR EACH ROW WHEN NEW.source <> OLD.source "
        "BEGIN SELECT RAISE(ABORT, "
        "'question.source is immutable (provenance integrity)'); END"
    )


def _m006_dedup_unique_indexes(conn) -> None:
    """D3 — make dedup atomic: partial UNIQUE indexes so a duplicate non-null
    content_hash / external_id can't be inserted even under a race (the app
    already checks-then-inserts). Tolerant: if a pre-existing DB already holds
    duplicates the index is skipped (logged) so startup never breaks — the
    app-level check still applies."""
    for name, col in (
        ("ux_question_content_hash", "content_hash"),
        ("ux_question_external_id", "external_id"),
    ):
        try:
            conn.exec_driver_sql(
                f"CREATE UNIQUE INDEX IF NOT EXISTS {name} "
                f"ON question ({col}) WHERE {col} IS NOT NULL"
            )
        except Exception as exc:  # pre-existing duplicates — keep app-level dedup
            log.warning("migration 6: skipped %s (%s)", name, exc)


def _m007_r7_indexes(conn) -> None:
    """R7 — idempotency + observability indexes.
    - attempt.client_attempt_id UNIQUE-when-present: offline replay/retries
      cannot create duplicate attempts (5.2).
    - metricsample(kind, created_at): time-series reads for the diagnostics
      panel and the cloud-spend ledger (7.3).
    - auditlog(entity, entity_id): fetch one item's edit history (5.4)."""
    statements = (
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_attempt_client_id "
        "ON attempt (client_attempt_id) WHERE client_attempt_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS ix_metricsample_kind_created "
        "ON metricsample (kind, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_auditlog_entity "
        "ON auditlog (entity, entity_id)",
    )
    for sql in statements:
        conn.exec_driver_sql(sql)


def _m008_clean_orphan_fks(conn) -> None:
    """5.3 — one-time cleanup of dangling foreign-key rows left by the OLD
    incomplete PrepTest delete (which removed only AnswerChoice + Explanation and
    orphaned Attempt/SRSCard/Annotation/ErrorLogEntry/EmbeddingVector/
    AttemptChoiceEvent/SRSReviewLog rows).

    Deleted children-before-parents so each DELETE's NOT-IN subquery still sees
    the rows it depends on. Idempotent: re-running finds nothing to delete.
    Tolerant: a missing table (partial/old DB) is skipped, never fatal."""
    # ORDER MATTERS: each NOT-IN delete only finds an orphan once its PARENT row
    # is already gone. So we delete parents first (sections whose preptest is
    # gone, attempts whose question is gone, cards whose question is gone), THEN
    # sweep the now-dangling children. Running the whole list twice would also
    # converge, but the explicit parent->child ordering makes one pass enough.
    statements = (
        # structural: orphan sections/passages first.
        "DELETE FROM section WHERE preptest_id NOT IN (SELECT id FROM preptest)",
        "DELETE FROM passage WHERE section_id NOT IN (SELECT id FROM section)",
        # attempts whose question is gone — delete BEFORE their children so the
        # children become detectable orphans below.
        "DELETE FROM attempt WHERE question_id NOT IN (SELECT id FROM question)",
        "DELETE FROM errorlogentry WHERE attempt_id NOT IN (SELECT id FROM attempt)",
        "DELETE FROM attemptchoiceevent WHERE attempt_id NOT IN (SELECT id FROM attempt)",
        "DELETE FROM annotation WHERE scope='attempt' AND ref_id NOT IN (SELECT id FROM attempt)",
        # SRS cards whose question is gone, then their review log (by card OR by
        # the now-gone question).
        "DELETE FROM srscard WHERE question_id NOT IN (SELECT id FROM question)",
        "DELETE FROM srsreviewlog WHERE card_id NOT IN (SELECT id FROM srscard)",
        "DELETE FROM srsreviewlog WHERE question_id NOT IN (SELECT id FROM question)",
        # question-scoped leaves.
        "DELETE FROM annotation WHERE scope='question' AND ref_id NOT IN (SELECT id FROM question)",
        "DELETE FROM embeddingvector WHERE kind='question' AND ref_id NOT IN (SELECT id FROM question)",
        "DELETE FROM answerchoice WHERE question_id NOT IN (SELECT id FROM question)",
        "DELETE FROM explanation WHERE question_id NOT IN (SELECT id FROM question)",
    )
    for sql in statements:
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:  # missing table on a partial/old DB — skip
            log.warning("migration 8: skipped (%s)", exc)


def _m009_training_fields(conn) -> None:
    """Bank-expansion plan Wave 1.6 — additive Question columns for the
    PDF-marked training corpus. Tolerant: column ALTERs are wrapped in
    try/except because SQLModel.create_all may already have created the
    columns when a fresh DB initializes alongside an old recorded migration
    history. The partial index speeds Wave 2.6's training-flagged parent
    lookup (`WHERE training_eligible=1` for a given q_type)."""
    for sql in (
        "ALTER TABLE question ADD COLUMN training_eligible BOOLEAN DEFAULT 0",
        "ALTER TABLE question ADD COLUMN training_role TEXT",
        "ALTER TABLE question ADD COLUMN training_notes TEXT",
    ):
        _add_column_idempotent(conn, sql, mig="migration 9")
    # Partial index: only the small subset of rows the user has flagged. At
    # 12k items even with broad use this stays tiny, so index maintenance
    # cost is negligible while parent-rotation lookups become a single seek.
    try:
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_question_training_eligible "
            "ON question (q_type, training_eligible) "
            "WHERE training_eligible = 1"
        )
    except Exception as exc:
        log.warning("migration 9: skipped training-eligible index (%s)", exc)


# Ordered registry. Append new entries with the next version number; never
# renumber or rewrite an applied migration — add a new one instead.
def _m010_embedding_vector_blob(conn) -> None:
    """Bank-expansion plan Wave 3.5 — store embeddings as float32 BLOB."""
    _add_column_idempotent(
        conn, "ALTER TABLE embeddingvector ADD COLUMN vector_blob BLOB",
        mig="migration 10",
    )
    # Backfill from JSON where present.
    try:
        rows = conn.exec_driver_sql(
            "SELECT id, vector_json FROM embeddingvector "
            "WHERE vector_json IS NOT NULL AND (vector_blob IS NULL OR length(vector_blob)=0)"
        ).fetchall()
        import struct
        for row_id, vjson in rows:
            if not vjson:
                continue
            try:
                vec = json.loads(vjson) if isinstance(vjson, str) else vjson
                blob = struct.pack(f"{len(vec)}f", *[float(x) for x in vec])
                conn.exec_driver_sql(
                    "UPDATE embeddingvector SET vector_blob=?, dim=? WHERE id=?",
                    (blob, len(vec), row_id),
                )
            except Exception:
                continue
    except Exception as exc:
        log.warning("migration 10: skipped backfill (%s)", exc)


def _m011_wave4_indexes(conn) -> None:
    """Bank-expansion plan Wave 4.5 — hot-path indexes at 12k scale."""
    for sql in (
        "CREATE INDEX IF NOT EXISTS ix_question_deleted_at "
        "ON question (deleted_at)",
        "CREATE INDEX IF NOT EXISTS ix_question_source_quarantine "
        "ON question (source, quarantined, approved)",
        "CREATE INDEX IF NOT EXISTS ix_srscard_origin ON srscard (origin)",
    ):
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:
            log.warning("migration 11: skipped %s (%s)", sql, exc)


def _m012_source_insert_guard(conn) -> None:
    """Provenance integrity — companion to m005's UPDATE-immutability. Reject an
    INSERT with a NULL or unknown ``question.source`` at the DB level. ``source``
    is the legal + scoring boundary (the export firewall keeps ``official`` out of
    shareable artifacts; score prediction includes ``official`` only), and both
    compare exact enum values — so a stray/NULL source from a non-ORM write could
    silently escape one guard or the other. The ORM always sets a valid source on
    insert; this makes raw-SQL/backfill inserts safe too. Idempotent."""
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_source_valid_insert "
        "BEFORE INSERT ON question "
        "FOR EACH ROW WHEN NEW.source IS NULL OR NEW.source NOT IN "
        "('official','ai_generated','sample','research','reclor') "
        "BEGIN SELECT RAISE(ABORT, "
        "'question.source must be a known provenance value'); END"
    )


def _m013_fts5_questions(conn) -> None:
    """FTS5 keyword search over question stem+prompt — the keyword-recall mode
    alongside the semantic cosine layer (find every question containing 'necessary
    condition'). External-content FTS (``content='question'``) kept in sync by
    triggers. FTS5 is compiled into SQLite, so no extension load is needed.

    Fully idempotent across the test suite's drop/recreate resets: ``'rebuild'``
    re-reads the (recreated) ``question`` table, wiping any stale shadow content,
    and the triggers are recreated IF NOT EXISTS (they're dropped with ``question``)."""
    conn.exec_driver_sql(
        "CREATE VIRTUAL TABLE IF NOT EXISTS question_fts USING fts5("
        "stem, prompt, content='question', content_rowid='id')"
    )
    try:
        conn.exec_driver_sql("INSERT INTO question_fts(question_fts) VALUES('rebuild')")
    except Exception as exc:  # pragma: no cover
        log.warning("migration 13: fts rebuild skipped (%s)", exc)
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_fts_ai AFTER INSERT ON question "
        "BEGIN INSERT INTO question_fts(rowid, stem, prompt) "
        "VALUES (new.id, new.stem, new.prompt); END"
    )
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_fts_ad AFTER DELETE ON question "
        "BEGIN INSERT INTO question_fts(question_fts, rowid, stem, prompt) "
        "VALUES('delete', old.id, old.stem, old.prompt); END"
    )
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_fts_au AFTER UPDATE ON question "
        "BEGIN INSERT INTO question_fts(question_fts, rowid, stem, prompt) "
        "VALUES('delete', old.id, old.stem, old.prompt); "
        "INSERT INTO question_fts(rowid, stem, prompt) "
        "VALUES (new.id, new.stem, new.prompt); END"
    )


def _m014_fts_softdelete_trigger(conn) -> None:
    """B13 — FTS sync for soft-deleted questions.

    The m013 update trigger (trg_question_fts_au) always re-inserts into the
    FTS index after deleting the old entry, even when the UPDATE sets
    deleted_at IS NOT NULL (soft-delete). This leaves soft-deleted questions
    in the FTS shadow table so they can be matched by keyword search — even
    though search_questions already filters by deleted_at IS NULL.

    This migration:
    1. Drops and recreates trg_question_fts_au with a WHEN guard so it only
       re-inserts when deleted_at IS NULL (i.e. normal / un-delete updates).
    2. Adds trg_question_fts_au2 which fires when deleted_at IS NOT NULL and
       removes the row from the FTS index, keeping the shadow table clean.

    Idempotent: DROP TRIGGER IF EXISTS + CREATE TRIGGER IF NOT EXISTS.
    """
    # Replace the m013 update trigger with a conditional version.
    conn.exec_driver_sql("DROP TRIGGER IF EXISTS trg_question_fts_au")
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_fts_au AFTER UPDATE ON question "
        "WHEN NEW.deleted_at IS NULL "
        "BEGIN "
        "INSERT INTO question_fts(question_fts, rowid, stem, prompt) "
        "VALUES('delete', old.id, old.stem, old.prompt); "
        "INSERT INTO question_fts(rowid, stem, prompt) "
        "VALUES (new.id, new.stem, new.prompt); "
        "END"
    )


def _m015_vnext_indexes(conn) -> None:
    """vNext roadmap foundation: hot indexes for adaptivity, tutor history, and
    content health. New tables are created by SQLModel.create_all; these indexes
    make the live cockpit/readiness endpoints cheap on a growing local bank."""
    for sql in (
        "CREATE INDEX IF NOT EXISTS ix_abilitysnapshot_qtype_created "
        "ON abilitysnapshot (q_type, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_abilitysnapshot_section_created "
        "ON abilitysnapshot (section_type, created_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_questionitemstats_question "
        "ON questionitemstats (question_id)",
        "CREATE INDEX IF NOT EXISTS ix_readinesssnapshot_section_created "
        "ON readinesssnapshot (section_type, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_attemptrationale_attempt_stage "
        "ON attemptrationale (attempt_id, stage)",
        "CREATE INDEX IF NOT EXISTS ix_questionconversation_question_updated "
        "ON questionconversation (question_id, updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_tutorturn_conversation_created "
        "ON tutorturn (conversation_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_contentversion_entity_version "
        "ON contentversion (entity, entity_id, version)",
        "CREATE INDEX IF NOT EXISTS ix_schema_migration_integrity_status "
        "ON schema_migration_integrity (status)",
    ):
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:
            log.warning("migration 15: skipped %s (%s)", sql, exc)
    # New trigger: soft-delete removes the question from FTS.
    conn.exec_driver_sql(
        "CREATE TRIGGER IF NOT EXISTS trg_question_fts_au2 AFTER UPDATE ON question "
        "WHEN NEW.deleted_at IS NOT NULL "
        "BEGIN "
        "INSERT INTO question_fts(question_fts, rowid, stem, prompt) "
        "VALUES('delete', old.id, old.stem, old.prompt); "
        "END"
    )


def _m016_tutor_os_trust_scheduler(conn) -> None:
    """Tutor OS tranche: trust evidence, scheduler controls, and benchmarks."""
    for sql in (
        "ALTER TABLE genjob ADD COLUMN priority INTEGER DEFAULT 0",
        "ALTER TABLE genjob ADD COLUMN progress_pct FLOAT DEFAULT 0",
        "ALTER TABLE genjob ADD COLUMN retry_count INTEGER DEFAULT 0",
        "ALTER TABLE genjob ADD COLUMN max_retries INTEGER DEFAULT 0",
        "ALTER TABLE genjob ADD COLUMN updated_at DATETIME",
        "ALTER TABLE genjob ADD COLUMN cancelled_at DATETIME",
    ):
        _add_column_idempotent(conn, sql, mig="migration 16")
    for sql in (
        "CREATE INDEX IF NOT EXISTS ix_genjob_status_priority "
        "ON genjob (status, priority, id)",
        "CREATE INDEX IF NOT EXISTS ix_trustsnapshot_tier_created "
        "ON trustsnapshot (tier, created_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_scheduledtask_key "
        "ON scheduledtask (key)",
        "CREATE INDEX IF NOT EXISTS ix_scheduledtask_due "
        "ON scheduledtask (enabled, next_run_at)",
        "CREATE INDEX IF NOT EXISTS ix_benchmarkrun_kind_created "
        "ON benchmarkrun (kind, created_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_sourceregistry_key "
        "ON sourceregistry (key)",
        "CREATE INDEX IF NOT EXISTS ix_validatorrun_type_created "
        "ON validatorrun (q_type, created_at)",
    ):
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:
            log.warning("migration 16: skipped %s (%s)", sql, exc)
    conn.exec_driver_sql("PRAGMA user_version = 16")


def _m017_tutor_os_product_surfaces(conn) -> None:
    """Tutor OS product surfaces: notebook/wiki, RC maps, and task evidence."""
    for sql in (
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_notebookpage_slug "
        "ON notebookpage (slug)",
        "CREATE INDEX IF NOT EXISTS ix_notebookpage_updated "
        "ON notebookpage (updated_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_notebookquestionlink_page_question_attempt "
        "ON notebookquestionlink (page_id, question_id, attempt_id)",
        "CREATE INDEX IF NOT EXISTS ix_notebookquestionlink_question "
        "ON notebookquestionlink (question_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_rcpassageanalysis_passage "
        "ON rcpassageanalysis (passage_id)",
        "CREATE INDEX IF NOT EXISTS ix_rcpassageanalysis_updated "
        "ON rcpassageanalysis (updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_schedulerrun_task_created "
        "ON schedulerrun (task_key, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_schedulerrun_status_created "
        "ON schedulerrun (status, created_at)",
    ):
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:
            log.warning("migration 17: skipped %s (%s)", sql, exc)
    conn.exec_driver_sql("PRAGMA user_version = 17")


def _m018_notebook_os_contracts(conn) -> None:
    """Notebook OS expansion: evidence graph, sources, chat, transforms, podcasts."""
    for sql in (
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_notebookworkspace_key "
        "ON notebookworkspace (key)",
        "CREATE INDEX IF NOT EXISTS ix_studyartifact_kind_updated "
        "ON studyartifact (kind, updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_studyartifact_question "
        "ON studyartifact (question_id)",
        "CREATE INDEX IF NOT EXISTS ix_studyartifact_passage "
        "ON studyartifact (passage_id)",
        "CREATE INDEX IF NOT EXISTS ix_studyartifact_firewall "
        "ON studyartifact (official_firewall, cloud_allowed, export_eligible)",
        "CREATE INDEX IF NOT EXISTS ix_evidenceref_target "
        "ON evidenceref (kind, entity_id)",
        "CREATE INDEX IF NOT EXISTS ix_citation_target "
        "ON citation (target)",
        "CREATE INDEX IF NOT EXISTS ix_backlink_target "
        "ON backlink (target_ref)",
        "CREATE INDEX IF NOT EXISTS ix_knowledgeinbox_status_created "
        "ON knowledgeinboxitem (status, created_at)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_contextpreset_workspace_name "
        "ON contextpreset (workspace_id, name)",
        "CREATE INDEX IF NOT EXISTS ix_artifactversion_artifact_version "
        "ON artifactversion (artifact_id, version)",
        "CREATE INDEX IF NOT EXISTS ix_notebooksource_workspace_status "
        "ON notebooksource (workspace_id, status)",
        "CREATE INDEX IF NOT EXISTS ix_notebooknote_workspace_updated "
        "ON notebooknote (workspace_id, updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_notebookchatsession_workspace_updated "
        "ON notebookchatsession (workspace_id, updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_notebookchatmessage_session_created "
        "ON notebookchatmessage (session_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_transformationrun_workspace_created "
        "ON transformationrun (workspace_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_podcastepisode_workspace_created "
        "ON podcastepisode (workspace_id, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_activityevent_status_created "
        "ON activityevent (status, created_at)",
    ):
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:
            log.warning("migration 18: skipped %s (%s)", sql, exc)
    conn.exec_driver_sql("PRAGMA user_version = 18")


def _m019_notebook_knowledge_fts(conn) -> None:
    """Notebook OS keyword index over local artifacts.

    Official-firewalled artifact bodies are deliberately excluded from the FTS
    body column. Titles/summaries remain searchable so local users can find the
    record, but the text itself does not become part of a broad export/search
    corpus.
    """
    conn.exec_driver_sql(
        "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5("
        "entity, entity_id UNINDEXED, title, body, summary, tags, "
        "tokenize='porter unicode61')"
    )
    try:
        conn.exec_driver_sql("DELETE FROM knowledge_fts")
        conn.exec_driver_sql(
            "INSERT INTO knowledge_fts(entity, entity_id, title, body, summary, tags) "
            "SELECT 'artifact', id, title, "
            "CASE WHEN official_firewall THEN '' ELSE body END, "
            "summary, COALESCE(tags_json, '') FROM studyartifact"
        )
    except Exception as exc:
        log.warning("migration 19: knowledge FTS backfill skipped (%s)", exc)
    conn.exec_driver_sql("PRAGMA user_version = 19")


def _m020_fold_additive_columns(conn) -> None:
    """BC1 — single migration ledger.

    Folds the former ``db._ADDITIVE_COLUMNS`` / ``_ADDITIVE_INDEXES`` lists into
    the ordered, recorded ledger so ``init_db`` only runs ``run_migrations``. The
    old split-brain applied these ALTERs separately from the recorded migrations:
    fine for fresh test DBs (``create_all`` makes the columns) but on a
    PRE-EXISTING production table ``create_all`` adds nothing, so the column had to
    be ALTERed in — which is exactly what this migration now does, recorded.

    Each ADD COLUMN is guarded by a ``PRAGMA table_info`` existence check
    (``_add_column_if_missing``) because SQLite has no ADD COLUMN IF NOT EXISTS, so
    a DB that already has any of these columns is a clean no-op and never errors.

    NOTE: the six ``genjob`` scheduler columns (priority, progress_pct,
    retry_count, max_retries, updated_at, cancelled_at) were already folded into
    migration 16, so they are intentionally NOT repeated here."""
    additive_columns: tuple[tuple[str, str, str], ...] = (
        ("question", "external_id", "external_id VARCHAR"),
        ("question", "content_hash", "content_hash VARCHAR"),
        ("question", "tag_confidence", "tag_confidence VARCHAR"),
        ("question", "deleted_at", "deleted_at DATETIME"),  # D5 soft-delete
        ("genjob", "parent_question_id", "parent_question_id INTEGER"),
        ("preptest", "scale_table_json", "scale_table_json TEXT"),          # 3.5
        ("question", "updated_at", "updated_at DATETIME"),                  # 5.4
        ("question", "empirical_difficulty", "empirical_difficulty FLOAT"),  # 2.8
        ("explanation", "model_used", "model_used VARCHAR"),               # 2.6
        ("explanation", "confidence", "confidence VARCHAR"),               # 2.6
        ("explanation", "answer_checked", "answer_checked BOOLEAN DEFAULT 0"),  # 2.6
        ("attempt", "client_attempt_id", "client_attempt_id VARCHAR"),     # 5.2
        ("srscard", "origin", "origin VARCHAR"),                           # 1.1
        ("srscard", "leech", "leech BOOLEAN DEFAULT 0"),                   # 3.2
        ("srscard", "last_reviewed", "last_reviewed DATETIME"),            # 3.2
        ("parsejob", "import_run_id", "import_run_id INTEGER"),            # P1 ledger
    )
    for table, column, ddl in additive_columns:
        _add_column_if_missing(conn, table, column, ddl, mig="migration 20")

    # Indexes we want even for pre-existing databases (formerly _ADDITIVE_INDEXES).
    for sql in (
        "CREATE INDEX IF NOT EXISTS ix_question_external_id "
        "ON question (external_id)",
        "CREATE INDEX IF NOT EXISTS ix_question_content_hash "
        "ON question (content_hash)",
    ):
        try:
            conn.exec_driver_sql(sql)
        except Exception as exc:
            log.warning("migration 20: skipped %s (%s)", sql, exc)
    conn.exec_driver_sql("PRAGMA user_version = 20")


def _m021_attempt_rationale_br_note(conn) -> None:
    """LSAT-3 — additive ``attemptrationale.br_note`` (the short reveal-time
    rationale the Blind Review screen captures) + an index for the auto-cloze
    "Gap" card queue.

    PRAGMA-guarded like migration 20: ``_add_column_if_missing`` is a clean no-op
    when ``create_all`` already added the column on a fresh DB, and skips a missing
    table on a partial/old DB. The ``srscard(origin)`` index already exists
    (migration 11, ``ix_srscard_origin``); the gap cards reuse it via their
    ``concept_gap_cloze`` origin, so no new index is needed there."""
    _add_column_if_missing(
        conn, "attemptrationale", "br_note", "br_note VARCHAR", mig="migration 21",
    )
    conn.exec_driver_sql("PRAGMA user_version = 21")


def _m022_cross_domain_schema_version(conn) -> None:
    """DATA-3 — record the cross-domain data-schema version for the host
    handshake.

    Creates a tiny key/value ``schema_meta`` table (idempotent, ``IF NOT
    EXISTS``) and upserts ``cross_domain_schema_version`` =
    ``CROSS_DOMAIN_SCHEMA_VERSION``. ``GET /api/observability/schema-versions``
    reads it so the host can compare contracts on boot and disable CROSS-DOMAIN
    writes (local writes are never affected) on a mismatch — the cheapest guard
    against the highest-severity multi-backend failure (an old SQLite + new Dexie
    silently losing data on a cross-plane write).

    PRAGMA-guarded like migrations 20/21: the table create + the upsert are both
    idempotent, so a fresh DB (where ``create_all`` knows nothing of this table)
    and a re-run are clean no-ops. Bumps ``PRAGMA user_version`` to 22 so the
    DB-level version tracks the latest recorded migration."""
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS schema_meta ("
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.exec_driver_sql(
        "INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (
            CROSS_DOMAIN_SCHEMA_KEY,
            str(CROSS_DOMAIN_SCHEMA_VERSION),
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.exec_driver_sql("PRAGMA user_version = 22")


def _m023_host_progress_snapshot(conn) -> None:
    """DATA-4a — indexes for the host -> backend cross-domain progress feed.

    The ``hostprogresssnapshot`` table itself is created by ``SQLModel.create_all``
    (``models.HostProgressSnapshot``); this migration adds the constraints/indexes
    ``create_all`` can't express:

    - A UNIQUE index on ``cross_id`` so ``POST /api/sync/progress-updates`` can
      UPSERT idempotently (``ON CONFLICT(cross_id) DO UPDATE``): a re-POST of the
      same host row updates in place instead of duplicating — the read-only feed's
      idempotency contract.
    - A ``(plane, kind)`` lookup index for the engine's "host progress by plane /
      kind" reads (LEARN-1/LEARN-3, later).

    PRAGMA-guarded exactly like migrations 20/21/22: every statement is
    ``IF NOT EXISTS`` / tolerant, so a fresh DB (where ``create_all`` already made
    the table) and a re-run are clean no-ops. The UNIQUE index create is wrapped
    so a pre-existing DB that somehow holds duplicate ``cross_id`` values logs and
    keeps the app-level upsert guard rather than breaking boot. Bumps
    ``PRAGMA user_version`` to 23 so the DB-level version tracks the latest
    recorded migration."""
    try:
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_hostprogresssnapshot_cross_id "
            "ON hostprogresssnapshot (cross_id)"
        )
    except Exception as exc:  # pre-existing duplicates — keep app-level upsert
        log.warning("migration 23: skipped ux_hostprogresssnapshot_cross_id (%s)", exc)
    try:
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_hostprogresssnapshot_plane_kind "
            "ON hostprogresssnapshot (plane, kind)"
        )
    except Exception as exc:
        log.warning("migration 23: skipped ix_hostprogresssnapshot_plane_kind (%s)", exc)
    conn.exec_driver_sql("PRAGMA user_version = 23")


def read_cross_domain_schema_version(conn) -> int:
    """Read the recorded cross-domain schema version from ``schema_meta``.

    Returns ``CROSS_DOMAIN_SCHEMA_VERSION`` (the code default) when the row /
    table is absent — i.e. a DB that pre-dates migration 22 but is running this
    build still reports a coherent version rather than 0. Never raises."""
    try:
        row = conn.exec_driver_sql(
            "SELECT value FROM schema_meta WHERE key=?",
            (CROSS_DOMAIN_SCHEMA_KEY,),
        ).fetchone()
    except Exception:  # pragma: no cover - table absent on a partial/old DB
        return CROSS_DOMAIN_SCHEMA_VERSION
    if row is None or row[0] is None:
        return CROSS_DOMAIN_SCHEMA_VERSION
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return CROSS_DOMAIN_SCHEMA_VERSION


MIGRATIONS: list[Migration] = [
    (1, "hot_path_indexes", _m001_hot_path_indexes),
    (2, "embedding_unique_index", _m002_embedding_unique_index),
    (3, "annotation_unique_index", _m003_annotation_unique_index),
    (4, "scale_indexes", _m004_scale_indexes),
    (5, "provenance_immutable", _m005_provenance_immutable),
    (6, "dedup_unique_indexes", _m006_dedup_unique_indexes),
    (7, "r7_indexes", _m007_r7_indexes),
    (8, "clean_orphan_fks", _m008_clean_orphan_fks),
    (9, "training_fields", _m009_training_fields),
    (10, "embedding_vector_blob", _m010_embedding_vector_blob),
    (11, "wave4_indexes", _m011_wave4_indexes),
    (12, "source_insert_guard", _m012_source_insert_guard),
    (13, "fts5_questions", _m013_fts5_questions),
    (14, "fts_softdelete_trigger", _m014_fts_softdelete_trigger),
    (15, "vnext_indexes", _m015_vnext_indexes),
    (16, "tutor_os_trust_scheduler", _m016_tutor_os_trust_scheduler),
    (17, "tutor_os_product_surfaces", _m017_tutor_os_product_surfaces),
    (18, "notebook_os_contracts", _m018_notebook_os_contracts),
    (19, "notebook_knowledge_fts", _m019_notebook_knowledge_fts),
    (20, "fold_additive_columns", _m020_fold_additive_columns),
    (21, "attempt_rationale_br_note", _m021_attempt_rationale_br_note),
    (22, "cross_domain_schema_version", _m022_cross_domain_schema_version),
    (23, "host_progress_snapshot", _m023_host_progress_snapshot),
]


# Partial-UNIQUE dedup guards created (best-effort) by m006. They are skipped
# when a pre-existing DB already holds duplicate values, so we re-check their
# presence on EVERY startup and warn prominently — otherwise the DB silently
# runs without the atomic uniqueness guard after the one-time skip.
DEDUP_UNIQUE_INDEXES = ("ux_question_content_hash", "ux_question_external_id")


def dedup_unique_indexes_missing(conn) -> list[str]:
    """Return the dedup UNIQUE indexes (m006) that are NOT present, if any."""
    try:
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    except Exception:  # pragma: no cover - sqlite_master is always present
        return []
    present = {str(r[0]) for r in rows if r[0]}
    return [name for name in DEDUP_UNIQUE_INDEXES if name not in present]


def _warn_if_dedup_guard_missing(engine) -> None:
    """Codex #11: surface a missing dedup uniqueness guard on every startup."""
    try:
        with engine.begin() as conn:
            missing = dedup_unique_indexes_missing(conn)
    except Exception:  # pragma: no cover - never let a readiness probe break boot
        return
    if missing:
        log.warning(
            "dedup readiness: UNIQUE dedup index(es) MISSING %s — migration 6 "
            "skipped them because the bank holds duplicate content_hash/external_id "
            "values; only the app-level check protects against duplicates until the "
            "duplicates are removed and the indexes are created",
            missing,
        )


def run_migrations(engine, migrations: list[Migration] | None = None) -> int:
    """Apply all not-yet-recorded migrations in ascending order.

    Returns the number applied. Safe to call on every startup.
    """
    migrations = MIGRATIONS if migrations is None else migrations
    with engine.begin() as conn:
        done = _applied_versions(conn)
        _backfill_integrity(conn, migrations)

    applied = 0
    for version, name, fn in sorted(migrations, key=lambda m: m[0]):
        if version in done:
            continue
        checksum = _migration_checksum(fn)
        started_at = datetime.now(timezone.utc).isoformat()
        with engine.begin() as conn:
            _record_integrity(
                conn,
                version=version,
                name=name,
                checksum=checksum,
                status="running",
                started_at=started_at,
                finished_at=None,
                error=None,
            )
        try:
            with engine.begin() as conn:
                fn(conn)
                finished_at = datetime.now(timezone.utc).isoformat()
                conn.exec_driver_sql(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    "VALUES (?, ?, ?)",
                    (version, name, finished_at),
                )
                _record_integrity(
                    conn,
                    version=version,
                    name=name,
                    checksum=checksum,
                    status="applied",
                    started_at=started_at,
                    finished_at=finished_at,
                    error=None,
                )
        except Exception as exc:
            with engine.begin() as conn:
                _record_integrity(
                    conn,
                    version=version,
                    name=name,
                    checksum=checksum,
                    status="failed",
                    started_at=started_at,
                    finished_at=datetime.now(timezone.utc).isoformat(),
                    error=str(exc),
                )
            raise
        log.info("migration applied version=%s name=%s checksum=%s", version, name, checksum[:12])
        applied += 1
    _warn_if_dedup_guard_missing(engine)
    return applied


def migration_preview(engine, migrations: list[Migration] | None = None) -> dict:
    """Read-only migration preview for trust diagnostics and upgrade UI."""
    migrations = MIGRATIONS if migrations is None else migrations
    with engine.begin() as conn:
        done = _applied_versions(conn)
        integrity_rows = conn.exec_driver_sql(
            "SELECT version, name, checksum, status, error "
            "FROM schema_migration_integrity"
        ).fetchall()
        user_version = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
    integrity = {
        int(row[0]): {
            "name": row[1],
            "checksum": row[2],
            "status": row[3],
            "error": row[4],
        }
        for row in integrity_rows
    }
    pending = []
    applied = []
    checksum_mismatches = []
    failed = []
    for version, name, fn in sorted(migrations, key=lambda m: m[0]):
        checksum = _migration_checksum(fn)
        row = integrity.get(version)
        item = {
            "version": version,
            "name": name,
            "checksum": checksum,
            "recorded_checksum": row.get("checksum") if row else None,
            "status": row.get("status") if row else ("applied" if version in done else "pending"),
        }
        if version in done:
            applied.append(item)
            if row and row.get("checksum") and row["checksum"] != checksum:
                checksum_mismatches.append(item)
        else:
            pending.append(item)
        if row and row.get("status") == "failed":
            failed.append(item | {"error": row.get("error")})
    latest = max((m[0] for m in migrations), default=0)
    return {
        "latest_expected_version": latest,
        "pragma_user_version": int(user_version or 0),
        "applied_count": len(applied),
        "pending_count": len(pending),
        "applied": applied,
        "pending": pending,
        "failed": failed,
        "checksum_mismatches": checksum_mismatches,
        "pre_migration_backup_required": bool(pending),
        "restore_after_upgrade_smoke_required": bool(pending),
    }
