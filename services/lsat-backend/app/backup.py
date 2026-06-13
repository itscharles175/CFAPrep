"""Local DB integrity checks + rotating snapshots (D4).

There is no cloud here, so a corrupted or accidentally-wiped SQLite file is
unrecoverable without a local safety net. This module:
- runs ``PRAGMA integrity_check`` on startup,
- takes consistent snapshots via SQLite's online-backup API (safe even while the
  app holds the DB open) on a daily schedule (the worker idle hook) and on
  demand, keeping the most recent ``keep`` copies,
- can restore a snapshot back over the live DB (a safety copy is taken first).

Functions take explicit paths so they're unit-testable without the live engine.
"""
from __future__ import annotations

import logging
import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("lsatlab.backup")

_SNAP_GLOB = "lsatlab-*.db"
_MANIFEST_SUFFIX = ".manifest.json"


# --- restore error taxonomy -------------------------------------------------
# All subclass ValueError so legacy callers/tests that ``except ValueError`` keep
# working, while the HTTP layer can map each failure to a DISTINCT status code
# (Codex #7): a bad name is a client error (400), a missing snapshot is 404, and
# a snapshot that fails integrity/FK verification is a conflict (409).
class RestoreError(ValueError):
    """Base class for restore failures."""


class InvalidBackupName(RestoreError):
    """The requested name is malformed / unsafe (path traversal, empty)."""


class BackupNotFound(RestoreError):
    """No snapshot with the requested name exists."""


class BackupIntegrityError(RestoreError):
    """The snapshot exists but failed an integrity or foreign-key check."""


class IncompatibleBackup(RestoreError):
    """The snapshot's recorded schema is newer than this build can run."""


class WorkerPauseError(RestoreError):
    """The background job worker could not be CONFIRMED paused before the
    overwrite, so the restore was aborted to avoid a torn copy. The live DB is
    untouched, so this is safe to retry once the worker is idle."""


class RestoreHealError(RestoreError):
    """The snapshot was copied over the live DB, but the in-process schema heal
    (``init_db``) failed. Data is intact (the restored snapshot + a pre-restore
    snapshot), but the app must be restarted to finish the schema upgrade; the
    restore must NOT be reported as a clean success."""

# Objects created by the lightweight migration/additive-schema layer that matter
# for backend readiness. These are presence probes only: no repair or mutation is
# attempted by the report path.
_EXPECTED_INDEXES = (
    "ix_question_external_id",
    "ix_question_content_hash",
    "ix_question_qtype_difficulty",
    "ix_question_source",
    "ix_question_qtype_source",
    "ix_attempt_session_mode",
    "ux_embedding_kind_ref",
    "ux_annotation_scope_ref",
    "ix_attempt_created",
    "ix_genjob_status",
    "ux_question_content_hash",
    "ux_question_external_id",
    "ux_attempt_client_id",
    "ix_metricsample_kind_created",
    "ix_auditlog_entity",
    "ix_question_training_eligible",
    "ix_question_deleted_at",
    "ix_question_source_quarantine",
    "ix_srscard_origin",
)
# B11: include all triggers created by migrations m005, m012, m013, m014.
_EXPECTED_TRIGGERS = (
    "trg_question_source_immutable",   # m005
    "trg_question_source_valid_insert",  # m012
    "trg_question_fts_ai",             # m013
    "trg_question_fts_ad",             # m013
    "trg_question_fts_au",             # m013 / replaced by m014
    "trg_question_fts_au2",            # m014 (B13 soft-delete fix)
)
_EXPECTED_VNEXT_INDEXES = (
    "ix_abilitysnapshot_qtype_created",
    "ix_abilitysnapshot_section_created",
    "ux_questionitemstats_question",
    "ix_readinesssnapshot_section_created",
    "ix_attemptrationale_attempt_stage",
    "ix_questionconversation_question_updated",
    "ix_tutorturn_conversation_created",
    "ix_contentversion_entity_version",
    "ix_schema_migration_integrity_status",
    "ix_genjob_status_priority",
    "ix_trustsnapshot_tier_created",
    "ux_scheduledtask_key",
    "ix_scheduledtask_due",
    "ix_benchmarkrun_kind_created",
    "ux_sourceregistry_key",
    "ix_validatorrun_type_created",
    "ux_notebookpage_slug",
    "ix_notebookpage_updated",
    "ux_notebookquestionlink_page_question_attempt",
    "ix_notebookquestionlink_question",
    "ux_rcpassageanalysis_passage",
    "ix_rcpassageanalysis_updated",
    "ix_schedulerrun_task_created",
    "ix_schedulerrun_status_created",
    "ux_notebookworkspace_key",
    "ix_studyartifact_kind_updated",
    "ix_studyartifact_question",
    "ix_studyartifact_passage",
    "ix_studyartifact_firewall",
    "ix_evidenceref_target",
    "ix_citation_target",
    "ix_backlink_target",
    "ix_knowledgeinbox_status_created",
    "ux_contextpreset_workspace_name",
    "ix_artifactversion_artifact_version",
    "ix_notebooksource_workspace_status",
    "ix_notebooknote_workspace_updated",
    "ix_notebookchatsession_workspace_updated",
    "ix_notebookchatmessage_session_created",
    "ix_transformationrun_workspace_created",
    "ix_podcastepisode_workspace_created",
    "ix_activityevent_status_created",
)
_BACKUP_FRESH_WITHIN_S = 36 * 60 * 60


def _db_file() -> Path:
    return config.DB_PATH


def _backup_dir() -> Path:
    d = config.BACKUP_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _connect(path: "str | Path") -> sqlite3.Connection:
    con = sqlite3.connect(str(path))
    if config.SQLITE_FK_ENFORCE:
        con.execute("PRAGMA foreign_keys=ON")
    return con


def integrity_check(db_path: "str | Path | None" = None) -> str:
    """``PRAGMA integrity_check`` → 'ok' or a description of corruption."""
    path = Path(db_path or _db_file())
    if not path.exists():
        return "ok"  # nothing created yet
    con = _connect(path)
    try:
        row = con.execute("PRAGMA integrity_check").fetchone()
        return row[0] if row else "unknown"
    except sqlite3.Error as exc:
        return str(exc)
    finally:
        con.close()


def foreign_key_check(
    db_path: "str | Path | None" = None,
    *,
    sample_limit: int = 20,
) -> dict:
    """Run ``PRAGMA foreign_key_check`` when the DB file is available.

    SQLite reports FK violations even when runtime enforcement is disabled. That
    makes this a safe, read-only integrity signal for this local-first app.
    """
    path = Path(db_path or _db_file())
    if not path.exists():
        return {
            "available": False,
            "ok": None,
            "violations": 0,
            "sample": [],
            "error": "database file not found",
        }
    con = _connect(path)
    try:
        rows = con.execute("PRAGMA foreign_key_check").fetchall()
        sample = [
            {
                "table": str(r[0]),
                "rowid": r[1],
                "parent": str(r[2]),
                "fkid": r[3],
            }
            for r in rows[: max(0, sample_limit)]
        ]
        return {
            "available": True,
            "ok": len(rows) == 0,
            "violations": len(rows),
            "sample": sample,
        }
    except sqlite3.Error as exc:
        return {
            "available": False,
            "ok": None,
            "violations": 0,
            "sample": [],
            "error": str(exc),
        }
    finally:
        con.close()


# --- 5.3 referential-integrity (orphan-FK) sweep ----------------------------
# Each entry: (label, SELECT count of dangling rows). The same WHERE clauses are
# reused (as DELETEs) by migration v8 to clean existing orphans. We hand-roll
# these because SQLite's own `PRAGMA foreign_key_check` only reports rows when
# the FK is declared AND enforcement is on, which historically it wasn't here.
def _orphan_count_sql() -> tuple[tuple[str, str], ...]:
    return (
        ("answerchoice",
         "SELECT COUNT(*) FROM answerchoice c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("explanation",
         "SELECT COUNT(*) FROM explanation c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("explanationfeedback_question",
         "SELECT COUNT(*) FROM explanationfeedback c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("attempt_question",
         "SELECT COUNT(*) FROM attempt c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("attempt_session",
         "SELECT COUNT(*) FROM attempt c WHERE NOT EXISTS "
         "(SELECT 1 FROM studysession p WHERE p.id = c.session_id)"),
        ("srscard",
         "SELECT COUNT(*) FROM srscard c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("errorlogentry",
         "SELECT COUNT(*) FROM errorlogentry c WHERE NOT EXISTS "
         "(SELECT 1 FROM attempt p WHERE p.id = c.attempt_id)"),
        ("attemptchoiceevent",
         "SELECT COUNT(*) FROM attemptchoiceevent c WHERE NOT EXISTS "
         "(SELECT 1 FROM attempt p WHERE p.id = c.attempt_id)"),
        ("srsreviewlog",
         "SELECT COUNT(*) FROM srsreviewlog c WHERE NOT EXISTS "
         "(SELECT 1 FROM srscard p WHERE p.id = c.card_id)"),
        ("srsreviewlog_question",
         "SELECT COUNT(*) FROM srsreviewlog c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("embeddingvector_question",
         "SELECT COUNT(*) FROM embeddingvector c WHERE kind='question' AND "
         "NOT EXISTS (SELECT 1 FROM question p WHERE p.id = c.ref_id)"),
        ("embeddingvector_errorlogentry",
         "SELECT COUNT(*) FROM embeddingvector c WHERE kind='note' AND "
         "NOT EXISTS (SELECT 1 FROM errorlogentry p WHERE p.id = c.ref_id)"),
        ("annotation_question",
         "SELECT COUNT(*) FROM annotation c WHERE scope='question' AND "
         "NOT EXISTS (SELECT 1 FROM question p WHERE p.id = c.ref_id)"),
        ("annotation_attempt",
         "SELECT COUNT(*) FROM annotation c WHERE scope='attempt' AND "
         "NOT EXISTS (SELECT 1 FROM attempt p WHERE p.id = c.ref_id)"),
        ("annotation_unknown_scope",
         "SELECT COUNT(*) FROM annotation WHERE scope NOT IN "
         "('question', 'attempt')"),
        ("passage",
         "SELECT COUNT(*) FROM passage c WHERE NOT EXISTS "
         "(SELECT 1 FROM section p WHERE p.id = c.section_id)"),
        ("section",
         "SELECT COUNT(*) FROM section c WHERE NOT EXISTS "
         "(SELECT 1 FROM preptest p WHERE p.id = c.preptest_id)"),
        ("question_section",
         "SELECT COUNT(*) FROM question c WHERE section_id IS NOT NULL AND "
         "NOT EXISTS (SELECT 1 FROM section p WHERE p.id = c.section_id)"),
        ("question_passage",
         "SELECT COUNT(*) FROM question c WHERE passage_id IS NOT NULL AND "
         "NOT EXISTS (SELECT 1 FROM passage p WHERE p.id = c.passage_id)"),
        ("question_parent",
         "SELECT COUNT(*) FROM question c WHERE parent_question_id IS NOT NULL "
         "AND NOT EXISTS (SELECT 1 FROM question p WHERE p.id = c.parent_question_id)"),
        ("genjob_parent_question",
         "SELECT COUNT(*) FROM genjob c WHERE parent_question_id IS NOT NULL "
         "AND NOT EXISTS (SELECT 1 FROM question p WHERE p.id = c.parent_question_id)"),
        ("gencandidate_gen_job",
         "SELECT COUNT(*) FROM gencandidate c WHERE NOT EXISTS "
         "(SELECT 1 FROM genjob p WHERE p.id = c.gen_job_id)"),
        ("gencandidate_question",
         "SELECT COUNT(*) FROM gencandidate c WHERE question_id IS NOT NULL "
         "AND NOT EXISTS (SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("reflection_session",
         "SELECT COUNT(*) FROM reflection c WHERE NOT EXISTS "
         "(SELECT 1 FROM studysession p WHERE p.id = c.session_id)"),
        ("questionitemstats_question",
         "SELECT COUNT(*) FROM questionitemstats c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("attemptrationale_attempt",
         "SELECT COUNT(*) FROM attemptrationale c WHERE NOT EXISTS "
         "(SELECT 1 FROM attempt p WHERE p.id = c.attempt_id)"),
        ("attemptrationale_question",
         "SELECT COUNT(*) FROM attemptrationale c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("questionconversation_question",
         "SELECT COUNT(*) FROM questionconversation c WHERE NOT EXISTS "
         "(SELECT 1 FROM question p WHERE p.id = c.question_id)"),
        ("questionconversation_attempt",
         "SELECT COUNT(*) FROM questionconversation c WHERE attempt_id IS NOT NULL "
         "AND NOT EXISTS (SELECT 1 FROM attempt p WHERE p.id = c.attempt_id)"),
        ("tutorturn_conversation",
         "SELECT COUNT(*) FROM tutorturn c WHERE NOT EXISTS "
         "(SELECT 1 FROM questionconversation p WHERE p.id = c.conversation_id)"),
    )


def orphan_report(db_path: "str | Path | None" = None) -> dict:
    """Report dangling foreign-key rows by relationship.

    Returns ``{"total": N, "by_relationship": {label: count, ...}}`` containing
    only the relationships that actually have orphans (empty when clean). Cheap
    enough to run on startup for a single-user bank.
    """
    path = Path(db_path or _db_file())
    out: dict = {
        "total": 0,
        "by_relationship": {},
        "checked_relationships": 0,
        "skipped_relationships": {},
    }
    if not path.exists():
        return out
    con = _connect(path)
    try:
        for label, sql in _orphan_count_sql():
            try:
                n = con.execute(sql).fetchone()[0]
            except sqlite3.OperationalError:
                # A table may not exist yet (fresh/partial DB) — skip it.
                out["skipped_relationships"][label] = "unavailable"
                continue
            out["checked_relationships"] += 1
            if n:
                out["by_relationship"][label] = int(n)
                out["total"] += int(n)
    finally:
        con.close()
    return out


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _iso_from_timestamp(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _row_counts(db_path: Path) -> dict[str, int]:
    if not db_path.exists():
        return {}
    con = _connect(db_path)
    try:
        tables = [
            str(r[0]) for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
        ]
        counts: dict[str, int] = {}
        for table in tables:
            try:
                counts[table] = int(
                    con.execute(f"SELECT COUNT(*) FROM {_quote_ident(table)}").fetchone()[0]
                )
            except sqlite3.Error:
                counts[table] = -1
        return counts
    finally:
        con.close()


def _manifest_path(snapshot_path: Path) -> Path:
    return snapshot_path.with_suffix(snapshot_path.suffix + _MANIFEST_SUFFIX)


def backup_manifest(snapshot_path: "str | Path") -> dict[str, Any]:
    """Build a launch/readiness manifest for a DB snapshot.

    The manifest is intentionally self-contained: it records the app/schema
    versions, integrity result, row counts, checksum, and official-content
    policy so a restore or release smoke can reason about the backup without
    trusting mutable process state.
    """
    snap = Path(snapshot_path)
    integrity = integrity_check(snap)
    migration = migration_report(snap)
    fk = foreign_key_check(snap)
    return {
        "manifest_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "app_version": config.APP_VERSION,
        "schema_version": migration["latest_applied_version"],
        "latest_expected_schema_version": migration["latest_expected_version"],
        "snapshot": {
            "name": snap.name,
            "size_bytes": snap.stat().st_size if snap.exists() else None,
            "sha256": _sha256_file(snap) if snap.exists() else None,
        },
        "integrity": {
            "result": integrity,
            "ok": integrity == "ok",
            "foreign_key_check": fk,
        },
        "row_counts": _row_counts(snap),
        "official_content_policy": {
            "snapshot_type": "full_local_sqlite_backup",
            "portable_json_export": "sanitized_export",
            "official_content_may_leave_machine": False,
        },
    }


def read_backup_manifest(snapshot_path: "str | Path") -> dict[str, Any] | None:
    path = _manifest_path(Path(snapshot_path))
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_backup_manifest(snapshot_path: Path) -> dict[str, Any]:
    manifest = backup_manifest(snapshot_path)
    _manifest_path(snapshot_path).write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return manifest


def db_file_status(db_path: "str | Path | None" = None) -> dict:
    """Read-only file/connectivity status for the SQLite database."""
    path = Path(db_path or _db_file())
    parent = path.parent
    exists = path.exists()
    stat = path.stat() if exists else None
    connectable = False
    error = None
    if exists:
        try:
            con = _connect(path)
            try:
                con.execute("SELECT 1").fetchone()
                connectable = True
            finally:
                con.close()
        except sqlite3.Error as exc:
            error = str(exc)
    return {
        "path": str(path),
        "exists": exists,
        "parent_exists": parent.exists(),
        "file_writable": bool(exists and os.access(path, os.W_OK)),
        "parent_writable": bool(parent.exists() and os.access(parent, os.W_OK)),
        "connectable": connectable,
        "size_bytes": stat.st_size if stat else None,
        "modified_at": _iso_from_timestamp(stat.st_mtime if stat else None),
        "error": error,
    }


def _expected_table_columns() -> dict[str, set[str]]:
    from sqlmodel import SQLModel

    from . import models  # noqa: F401  (register tables)

    return {
        name: {col.name for col in table.columns}
        for name, table in SQLModel.metadata.tables.items()
    }


def schema_report(db_path: "str | Path | None" = None) -> dict:
    """Presence report for SQLModel tables/columns plus migration bookkeeping."""
    path = Path(db_path or _db_file())
    expected = _expected_table_columns()
    if not path.exists():
        return {
            "ok": False,
            "expected_tables": sorted(expected),
            "present_tables": [],
            "missing_tables": sorted(expected),
            "missing_columns": {
                table: sorted(cols) for table, cols in expected.items()
            },
            "schema_migrations_table": False,
        }
    con = _connect(path)
    try:
        present_rows = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        present = {str(r[0]) for r in present_rows}
        missing_tables = sorted(set(expected) - present)
        missing_columns: dict[str, list[str]] = {}
        for table, columns in expected.items():
            if table not in present:
                continue
            info = con.execute(f"PRAGMA table_info({_quote_ident(table)})").fetchall()
            have = {str(r[1]) for r in info}
            miss = sorted(columns - have)
            if miss:
                missing_columns[table] = miss
        schema_migrations_table = "schema_migrations" in present
        return {
            "ok": not missing_tables and not missing_columns
                  and schema_migrations_table,
            "expected_tables": sorted(expected),
            "present_tables": sorted(present),
            "missing_tables": missing_tables,
            "missing_columns": missing_columns,
            "schema_migrations_table": schema_migrations_table,
        }
    except sqlite3.Error as exc:
        return {
            "ok": False,
            "expected_tables": sorted(expected),
            "present_tables": [],
            "missing_tables": sorted(expected),
            "missing_columns": {},
            "schema_migrations_table": False,
            "error": str(exc),
        }
    finally:
        con.close()


def migration_report(db_path: "str | Path | None" = None) -> dict:
    """Recorded migration presence without applying any migration."""
    from . import migrations

    path = Path(db_path or _db_file())
    expected = [
        {
            "version": int(version),
            "name": name,
            "checksum": migrations._migration_checksum(fn),
        }
        for version, name, fn in migrations.MIGRATIONS
    ]
    expected_versions = {row["version"] for row in expected}
    expected_checksums = {row["version"]: row["checksum"] for row in expected}
    if not path.exists():
        return {
            "ok": False,
            "expected": expected,
            "applied": [],
            "integrity": [],
            "missing": expected,
            "unexpected_versions": [],
            "checksum_mismatches": [],
            "failed": [],
            "running": [],
            "latest_expected_version": max(expected_versions) if expected else None,
            "latest_applied_version": None,
        }
    con = _connect(path)
    try:
        has_table = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='schema_migrations'"
        ).fetchone()
        if not has_table:
            return {
                "ok": False,
                "expected": expected,
                "applied": [],
                "integrity": [],
                "missing": expected,
                "unexpected_versions": [],
                "checksum_mismatches": [],
                "failed": [],
                "running": [],
                "latest_expected_version": max(expected_versions) if expected else None,
                "latest_applied_version": None,
                "schema_migrations_table": False,
            }
        rows = con.execute(
            "SELECT version, name, applied_at FROM schema_migrations "
            "ORDER BY version"
        ).fetchall()
        applied = [
            {"version": int(r[0]), "name": str(r[1]), "applied_at": str(r[2])}
            for r in rows
        ]
        has_integrity = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='schema_migration_integrity'"
        ).fetchone()
        integrity: list[dict[str, Any]] = []
        if has_integrity:
            irows = con.execute(
                "SELECT version, name, checksum, started_at, finished_at, status, error "
                "FROM schema_migration_integrity ORDER BY version"
            ).fetchall()
            integrity = [
                {
                    "version": int(r[0]),
                    "name": str(r[1]),
                    "checksum": str(r[2]),
                    "started_at": r[3],
                    "finished_at": r[4],
                    "status": str(r[5]),
                    "error": r[6],
                }
                for r in irows
            ]
        integrity_by_version = {row["version"]: row for row in integrity}
        applied_versions = {row["version"] for row in applied}
        missing = [row for row in expected if row["version"] not in applied_versions]
        unexpected = sorted(applied_versions - expected_versions)
        checksum_mismatches = []
        failed = []
        running = []
        for row in integrity:
            expected_checksum = expected_checksums.get(row["version"])
            if expected_checksum and row["checksum"] != expected_checksum:
                checksum_mismatches.append({
                    "version": row["version"],
                    "name": row["name"],
                    "expected": expected_checksum,
                    "actual": row["checksum"],
                })
            if row["status"] == "failed":
                failed.append(row)
            elif row["status"] == "running":
                running.append(row)
        missing_integrity = [
            row for row in expected
            if row["version"] in applied_versions
            and row["version"] not in integrity_by_version
        ]
        return {
            "ok": not missing and not checksum_mismatches and not failed and not running,
            "expected": expected,
            "applied": applied,
            "integrity": integrity,
            "missing": missing,
            "missing_integrity": missing_integrity,
            "unexpected_versions": unexpected,
            "checksum_mismatches": checksum_mismatches,
            "failed": failed,
            "running": running,
            "latest_expected_version": max(expected_versions) if expected else None,
            "latest_applied_version": max(applied_versions) if applied_versions else None,
            "schema_migrations_table": True,
            "schema_migration_integrity_table": bool(has_integrity),
        }
    except sqlite3.Error as exc:
        return {
            "ok": False,
            "expected": expected,
            "applied": [],
            "integrity": [],
            "missing": expected,
            "unexpected_versions": [],
            "checksum_mismatches": [],
            "failed": [],
            "running": [],
            "latest_expected_version": max(expected_versions) if expected else None,
            "latest_applied_version": None,
            "error": str(exc),
        }
    finally:
        con.close()


def _object_presence_report(
    *,
    db_path: "str | Path | None" = None,
    object_type: str,
    expected: tuple[str, ...],
) -> dict:
    path = Path(db_path or _db_file())
    if not path.exists():
        return {
            "ok": False,
            "expected": list(expected),
            "present": [],
            "missing": list(expected),
        }
    con = _connect(path)
    try:
        rows = con.execute(
            "SELECT name FROM sqlite_master WHERE type=?",
            (object_type,),
        ).fetchall()
        present = {str(r[0]) for r in rows if r[0]}
        missing = [name for name in expected if name not in present]
        return {
            "ok": not missing,
            "expected": list(expected),
            "present": sorted(present),
            "missing": missing,
        }
    except sqlite3.Error as exc:
        return {
            "ok": False,
            "expected": list(expected),
            "present": [],
            "missing": list(expected),
            "error": str(exc),
        }
    finally:
        con.close()


def index_report(db_path: "str | Path | None" = None) -> dict:
    return _object_presence_report(
        db_path=db_path,
        object_type="index",
        expected=_EXPECTED_INDEXES + _EXPECTED_VNEXT_INDEXES,
    )


# Codex #11: migration 6 SKIPS these partial-UNIQUE indexes (only logs a
# warning) when a pre-existing DB already holds duplicate content_hash /
# external_id values, silently leaving the bank WITHOUT the atomic uniqueness
# guard (the app-level check-then-insert is then the only protection, which can
# race). This is the prominent readiness probe for that condition.
_DEDUP_UNIQUE_INDEXES = ("ux_question_content_hash", "ux_question_external_id")


def dedup_index_report(db_path: "str | Path | None" = None) -> dict:
    """Report whether the dedup uniqueness guards (m006) are actually present.

    When ``ok`` is False the partial-UNIQUE indexes never got created (migration
    6 skipped them because legacy duplicates existed), so a concurrent insert can
    still create a duplicate non-null ``content_hash`` / ``external_id``. The
    report surfaces the live duplicate groups so the user knows what to dedup
    before the guard can be installed.
    """
    report = _object_presence_report(
        db_path=db_path,
        object_type="index",
        expected=_DEDUP_UNIQUE_INDEXES,
    )
    path = Path(db_path or _db_file())
    duplicates: dict[str, int] = {}
    if report["missing"] and path.exists():
        con = _connect(path)
        try:
            for col in ("content_hash", "external_id"):
                try:
                    row = con.execute(
                        f"SELECT COUNT(*) FROM (SELECT {col} FROM question "
                        f"WHERE {col} IS NOT NULL GROUP BY {col} HAVING COUNT(*) > 1)"
                    ).fetchone()
                except sqlite3.Error:
                    continue
                if row and int(row[0]):
                    duplicates[col] = int(row[0])
        finally:
            con.close()
    report["duplicate_groups"] = duplicates
    return report


def trigger_report(db_path: "str | Path | None" = None) -> dict:
    return _object_presence_report(
        db_path=db_path,
        object_type="trigger",
        expected=_EXPECTED_TRIGGERS,
    )


def pragma_report(db_path: "str | Path | None" = None) -> dict:
    """Critical SQLite PRAGMA state for startup/doctor readiness."""
    path = Path(db_path or _db_file())
    expected = {
        "foreign_keys": 1 if config.SQLITE_FK_ENFORCE else 0,
        # WAL is persistent in the DB file header, so a fresh connection here
        # reflects it (unlike per-connection busy_timeout/synchronous, which we
        # deliberately do NOT assert). See db.py's connection-PRAGMA listener.
        "journal_mode": "wal",
    }
    if not path.exists():
        return {
            "ok": False,
            "expected": expected,
            "actual": {},
            "missing": list(expected),
            "error": "database file not found",
        }
    con = _connect(path)
    try:
        actual = {
            "foreign_keys": int(con.execute("PRAGMA foreign_keys").fetchone()[0]),
            "journal_mode": str(con.execute("PRAGMA journal_mode").fetchone()[0]),
            "synchronous": int(con.execute("PRAGMA synchronous").fetchone()[0]),
            "user_version": int(con.execute("PRAGMA user_version").fetchone()[0]),
        }
        mismatched = {
            key: {"expected": value, "actual": actual.get(key)}
            for key, value in expected.items()
            if actual.get(key) != value
        }
        return {
            "ok": not mismatched,
            "expected": expected,
            "actual": actual,
            "mismatched": mismatched,
        }
    except sqlite3.Error as exc:
        return {
            "ok": False,
            "expected": expected,
            "actual": {},
            "mismatched": expected,
            "error": str(exc),
        }
    finally:
        con.close()


def _copy_db(src_path: Path, dest_path: Path) -> None:
    """Online-backup copy src → dest (consistent under concurrent use)."""
    src = _connect(src_path)
    try:
        dst = _connect(dest_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _prune(backup_dir: Path, keep: int) -> None:
    snaps = sorted(
        backup_dir.glob(_SNAP_GLOB), key=lambda p: p.stat().st_mtime, reverse=True
    )
    for p in snaps[max(0, keep):]:
        try:
            p.unlink()
        except OSError:
            pass


def create_backup(
    *,
    db_path: "str | Path | None" = None,
    backup_dir: "str | Path | None" = None,
    keep: int = 10,
    label: "str | None" = None,
) -> Path:
    """Snapshot the live DB into the backup dir; prune to the newest ``keep``."""
    src = Path(db_path or _db_file())
    bdir = Path(backup_dir) if backup_dir else _backup_dir()
    bdir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S%f")
    suffix = f"-{label}" if label else ""
    dest = bdir / f"lsatlab-{ts}{suffix}.db"
    _copy_db(src, dest)
    _write_backup_manifest(dest)
    _prune(bdir, keep)
    log.info("backup created path=%s", dest)
    return dest


def list_backups(backup_dir: "str | Path | None" = None) -> list[dict]:
    bdir = Path(backup_dir) if backup_dir else _backup_dir()
    if not bdir.exists():
        return []
    out: list[dict] = []
    for p in sorted(bdir.glob(_SNAP_GLOB), key=lambda p: p.stat().st_mtime, reverse=True):
        st = p.stat()
        out.append({
            "name": p.name,
            "size_bytes": st.st_size,
            "created_at": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
            "manifest": read_backup_manifest(p),
        })
    return out


def backup_status(
    backup_dir: "str | Path | None" = None,
    *,
    fresh_within_s: float = _BACKUP_FRESH_WITHIN_S,
) -> dict:
    """Freshness/status for local DB snapshots without creating or deleting any."""
    bdir = Path(backup_dir) if backup_dir else config.BACKUP_DIR
    if not bdir.exists():
        return {
            "status": "missing",
            "ok": False,
            "backup_dir": str(bdir),
            "count": 0,
            "newest": None,
            "newest_age_seconds": None,
            "fresh_within_seconds": int(fresh_within_s),
        }
    try:
        snaps = sorted(
            bdir.glob(_SNAP_GLOB),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError as exc:
        return {
            "status": "unavailable",
            "ok": False,
            "backup_dir": str(bdir),
            "count": 0,
            "newest": None,
            "newest_age_seconds": None,
            "fresh_within_seconds": int(fresh_within_s),
            "error": str(exc),
        }
    if not snaps:
        return {
            "status": "missing",
            "ok": False,
            "backup_dir": str(bdir),
            "count": 0,
            "newest": None,
            "newest_age_seconds": None,
            "fresh_within_seconds": int(fresh_within_s),
        }
    newest = snaps[0]
    st = newest.stat()
    age_s = max(0, int(time.time() - st.st_mtime))
    fresh = age_s <= fresh_within_s
    return {
        "status": "fresh" if fresh else "stale",
        "ok": fresh,
        "backup_dir": str(bdir),
        "count": len(snaps),
        "newest": {
            "name": newest.name,
            "size_bytes": st.st_size,
            "created_at": datetime.fromtimestamp(
                st.st_mtime, timezone.utc
            ).isoformat(),
        },
        "newest_age_seconds": age_s,
        "fresh_within_seconds": int(fresh_within_s),
    }


def _collect_report_messages(report: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not report["db"]["exists"]:
        errors.append("db_missing")
    elif not report["db"]["connectable"]:
        errors.append("db_not_connectable")
    if not report["integrity_check"]["ok"]:
        errors.append("integrity_check_failed")
    fk = report["foreign_key_check"]
    if fk["available"] and fk["ok"] is False:
        errors.append("foreign_key_check_failed")
    elif not fk["available"]:
        warnings.append("foreign_key_check_unavailable")
    if report["orphans"]["total"]:
        errors.append("manual_orphan_sweep_failed")
    for key in ("schema", "migrations", "indexes", "triggers", "pragmas"):
        if not report[key]["ok"]:
            errors.append(f"{key}_missing")
    # Codex #11: the dedup uniqueness guard is surfaced as a WARNING (not an
    # error) — a DB carrying legacy duplicates is still usable, but the atomic
    # guard is absent so the user must dedup before it can be installed.
    if not report.get("dedup_indexes", {}).get("ok", True):
        warnings.append("dedup_unique_indexes_missing")
    if not report["backup"]["ok"]:
        warnings.append(f"backup_{report['backup']['status']}")
    return errors, warnings


def integrity_report(
    db_path: "str | Path | None" = None,
    *,
    backup_dir: "str | Path | None" = None,
) -> dict:
    """Complete local backend integrity/readiness report.

    This is deliberately read-only: PRAGMA checks, catalog presence checks, file
    metadata, and backup freshness. It does not run migrations or repair data.
    """
    path = Path(db_path or _db_file())
    result = integrity_check(path)
    report: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "db": db_file_status(path),
        "integrity_check": {
            "result": result,
            "ok": result == "ok",
        },
        "foreign_key_check": foreign_key_check(path),
        "orphans": orphan_report(path),
        "schema": schema_report(path),
        "migrations": migration_report(path),
        "indexes": index_report(path),
        "dedup_indexes": dedup_index_report(path),
        "triggers": trigger_report(path),
        "pragmas": pragma_report(path),
        "backup": backup_status(backup_dir),
    }
    errors, warnings = _collect_report_messages(report)
    report["errors"] = errors
    report["warnings"] = warnings
    report["ready"] = not errors
    report["status"] = "ok" if not errors and not warnings else (
        "warning" if not errors else "error"
    )
    return report


def _latest_expected_schema_version() -> int | None:
    """Highest migration version THIS build knows how to apply."""
    from . import migrations

    versions = [int(v) for v, _name, _fn in migrations.MIGRATIONS]
    return max(versions) if versions else None


class _PausedWorker:
    """Stop the background job worker for the duration of a DB overwrite, then
    restart it if (and only if) it was running before.

    swarm #45: the worker drains jobs on its own thread and opens fresh Sessions
    against the SAME SQLite file we are about to overwrite. If it reopens a
    connection mid-overwrite it can read torn pages or hold a lock that fails the
    copy. Pausing it makes the overwrite the sole writer."""

    def __init__(self) -> None:
        self._was_alive = False

    def __enter__(self) -> "_PausedWorker":
        # Fail CLOSED: only proceed to overwrite the live DB once we have
        # CONFIRMED the worker is paused. ``worker.stop()`` sets the stop event
        # and joins with a timeout, so a still-alive thread afterwards means the
        # join timed out mid-job and the worker could still reopen a Session
        # against the file we are about to overwrite (a torn copy). Aborting here
        # is safe — the live DB has not been touched yet.
        try:
            from . import jobs

            worker = jobs.get_worker()
            thread = worker._thread
            was_alive = thread is not None and thread.is_alive()
            if was_alive:
                worker.stop()
                still = worker._thread
                if still is not None and still.is_alive():
                    raise WorkerPauseError(
                        "background job worker did not stop in time; restore "
                        "aborted to avoid a torn database copy"
                    )
                # Confirmed paused — safe to overwrite; restart it on exit.
                self._was_alive = True
        except WorkerPauseError:
            raise
        except Exception as exc:
            raise WorkerPauseError(
                "could not pause the background job worker before restore; "
                "restore aborted to protect the live database"
            ) from exc
        return self

    def __exit__(self, *_exc) -> None:
        if not self._was_alive:
            return
        try:
            from . import jobs

            jobs.get_worker().start()
        except Exception:
            log.debug("restarting job worker after restore failed", exc_info=True)


def restore_backup(
    name: str,
    *,
    db_path: "str | Path | None" = None,
    backup_dir: "str | Path | None" = None,
) -> Path:
    """Restore a named snapshot over the live DB.

    Steps: validate the name, locate the snapshot, verify its integrity + FK
    state, reject a backup whose recorded schema is NEWER than this build can
    run, take a pre-restore safety snapshot, pause the job worker, overwrite the
    live DB, then re-run the schema heal (``init_db``) IN-PROCESS so an
    older-schema backup is upgraded immediately instead of leaving the running
    app broken until a manual restart (swarm #43 / Codex #7). A restart is still
    recommended so no stale pages linger in other open connections.

    Raises typed ``RestoreError`` subclasses so the HTTP layer can map each
    failure to a distinct status code; all remain ``ValueError`` for legacy
    callers.
    """
    if not name or "/" in name or "\\" in name or ".." in name:
        raise InvalidBackupName("invalid backup name")
    bdir = Path(backup_dir) if backup_dir else _backup_dir()
    snap = bdir / name
    if not snap.exists():
        raise BackupNotFound("backup not found")
    integrity = integrity_check(snap)
    if integrity != "ok":
        raise BackupIntegrityError(f"backup integrity check failed: {integrity}")
    fk = foreign_key_check(snap)
    if fk["available"] and fk["ok"] is False:
        raise BackupIntegrityError("backup foreign key check failed")
    # Reject a backup from a NEWER build: applying our (older) heal over it can't
    # downgrade its schema and would silently run the app against tables it does
    # not understand. Prefer the manifest's recorded value; fall back to reading
    # the snapshot's own migration history when no manifest is present.
    manifest = read_backup_manifest(snap)
    snap_version = None
    if manifest is not None:
        snap_version = manifest.get("schema_version")
    if snap_version is None:
        snap_version = migration_report(snap).get("latest_applied_version")
    our_version = _latest_expected_schema_version()
    if (
        snap_version is not None
        and our_version is not None
        and int(snap_version) > int(our_version)
    ):
        raise IncompatibleBackup(
            f"backup schema version {snap_version} is newer than this build "
            f"supports ({our_version}); upgrade the app before restoring"
        )
    target = Path(db_path or _db_file())
    if target.exists():
        create_backup(db_path=target, backup_dir=bdir, label="prerestore")
    with _PausedWorker():
        try:
            from .db import engine

            engine.dispose()
        except Exception:
            log.debug("engine dispose before restore failed", exc_info=True)
        _copy_db(snap, target)
        # swarm #43 / Codex #7: heal the just-restored schema in-process so an
        # OLDER-schema backup is brought up to the running build's expectations
        # (create_all + additive columns + recorded migrations) immediately.
        try:
            from .db import init_db

            init_db()
        except Exception as exc:
            # The snapshot is already copied over the live DB, so we cannot abort
            # — but we must NOT report a clean success. Surface a typed error so
            # the HTTP layer tells the user the restore needs an app restart to
            # finish the heal. Nothing is lost: the restored snapshot is valid and
            # the prior DB is saved as a pre-restore snapshot.
            log.exception("post-restore schema heal (init_db) failed")
            raise RestoreHealError(
                "database was restored from the snapshot, but the in-process "
                "schema heal failed; restart the app to complete the restore. "
                "Your previous database was saved as a pre-restore snapshot."
            ) from exc
    log.info("backup restored from=%s", snap)
    return target


def maybe_backup(*, min_interval_s: float = 86400.0) -> bool:
    """Throttled backup for the worker idle hook: snapshot at most once per
    ``min_interval_s`` (default daily), gauged by the newest existing snapshot so
    the schedule survives restarts. Returns True if a snapshot was taken."""
    bdir = _backup_dir()
    snaps = list_backups(bdir)
    if snaps:
        newest_mtime = max((bdir / s["name"]).stat().st_mtime for s in snaps)
        if time.time() - newest_mtime < min_interval_s:
            return False
    try:
        create_backup()
        return True
    except Exception:
        log.exception("scheduled backup failed")
        return False
