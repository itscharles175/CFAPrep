"""DATA-5 — one unified {host, lsat} export/backup artifact.

Why this exists
---------------
Until now each plane backed up alone: the host (CFA/Quant/Excel) exported its
Dexie ``VaultExport`` from the browser, and the LSAT backend exported its
portable bank JSON via ``bank_export`` separately. Backing up StudyVault meant
two artifacts, two checksums, no shared identity, and no record of what was ever
produced.

This module folds both halves into ONE envelope with a shared ``exportId`` /
``exportedAt`` / ``checksum`` so the whole vault is a single atomic artifact, and
records every build + import in the ``ExportHistory`` provenance table.

Design choices
--------------
- The LSAT half is the EXISTING ``bank_export.export_bank`` JSON (so the firewall,
  idempotency, and full-fidelity user data come along unchanged). It lands under
  ``data``. The optional host half (the browser's ``VaultExport``) is passed in by
  the host and stored verbatim under ``hostData`` — the backend never reaches into
  the host's Dexie store.
- ``checksum`` is the sha256 of the CANONICAL JSON of the envelope WITHOUT its own
  ``checksum`` field (sorted keys, compact separators), so re-serialising the same
  logical artifact yields the same digest regardless of key order.
- Import routes the LSAT half through ``bank_export.import_bank`` (idempotent by
  external_id/content_hash) and records/updates an ``ExportHistory`` row.

FIREWALL (non-negotiable, mirrors ``bank_export``)
--------------------------------------------------
``build_unified_export`` calls ``export_bank(..., include_official=False)``: the
copyrighted ``official`` content NEVER enters the envelope. On import we ALSO
reject any payload whose LSAT ``data`` carries an ``official`` question — a
hand-crafted artifact must not be able to smuggle official content onto a machine
via the unified path either.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlmodel import Session, select

from . import bank_export, config
from .models import ExportHistory, QuestionSource

# The unified-envelope schema version. Bumped when the ENVELOPE shape changes
# (distinct from bank_export.SCHEMA_VERSION, which versions the LSAT ``data``
# payload, and from the host's Dexie VAULT_SCHEMA_VERSION).
SCHEMA_VERSION = 1
FORMAT = "unified-json"

OFFICIAL = QuestionSource.official.value
ENCRYPTED_BACKUP_VERSION = 1
ENCRYPTED_BACKUP_ALGORITHM = "AES-GCM-256"
ENCRYPTED_BACKUP_KDF = "PBKDF2-SHA256-200000"
PBKDF2_ITERATIONS = 200_000
BACKUP_SALT_BYTES = 16
BACKUP_IV_BYTES = 12


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def _derive_backup_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def is_encrypted_backup_blob(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("version") == ENCRYPTED_BACKUP_VERSION
        and value.get("algorithm") == ENCRYPTED_BACKUP_ALGORITHM
        and value.get("kdf") == ENCRYPTED_BACKUP_KDF
        and isinstance(value.get("salt"), str)
        and isinstance(value.get("iv"), str)
        and isinstance(value.get("ciphertext"), str)
    )


def encrypt_backup_payload(payload: dict[str, Any], passphrase: str) -> dict[str, Any]:
    """Encrypt a JSON-ready backup payload using the host-compatible envelope.

    The shape and crypto parameters intentionally match ``src/lib/encryptedBackup.ts``
    so a backend-encrypted artifact can be restored by the host and vice versa.
    """
    if not passphrase:
        raise ValueError("backup passphrase required")
    salt = os.urandom(BACKUP_SALT_BYTES)
    iv = os.urandom(BACKUP_IV_BYTES)
    key = _derive_backup_key(passphrase, salt)
    plaintext = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(iv, plaintext, salt)
    return {
        "version": ENCRYPTED_BACKUP_VERSION,
        "algorithm": ENCRYPTED_BACKUP_ALGORITHM,
        "kdf": ENCRYPTED_BACKUP_KDF,
        "salt": _b64encode(salt),
        "iv": _b64encode(iv),
        "ciphertext": _b64encode(ciphertext),
        "createdAt": _now_iso(),
    }


def decrypt_backup_payload(blob: dict[str, Any], passphrase: str) -> dict[str, Any]:
    if not passphrase:
        raise ValueError("encrypted backup passphrase required")
    if not is_encrypted_backup_blob(blob):
        raise ValueError("invalid encrypted backup blob")
    try:
        salt = _b64decode(str(blob["salt"]))
        iv = _b64decode(str(blob["iv"]))
        ciphertext = _b64decode(str(blob["ciphertext"]))
    except (KeyError, TypeError, ValueError):
        raise ValueError("invalid passphrase or corrupted blob") from None
    key = _derive_backup_key(passphrase, salt)
    try:
        plaintext = AESGCM(key).decrypt(iv, ciphertext, salt)
    except InvalidTag:
        raise ValueError("invalid passphrase or corrupted blob") from None
    try:
        decoded = json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("encrypted backup decrypted but payload is not valid JSON") from None
    if not isinstance(decoded, dict):
        raise ValueError("encrypted backup decrypted but payload is not a JSON object")
    return decoded


def _canonical_json(obj: Any) -> str:
    """Deterministic JSON for checksums: sorted keys, compact separators."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_checksum(envelope: dict[str, Any]) -> str:
    """sha256 of the canonical JSON of ``envelope`` WITHOUT its ``checksum`` key.

    Prefixed ``sha256:`` to mirror the host's ``VaultExport.checksum`` convention.
    """
    payload = {k: v for k, v in envelope.items() if k != "checksum"}
    digest = hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _export_id(exported_at: str) -> str:
    """Stable-ish unified export id: ``sv-<digits>-<sha8>``.

    Mirrors the host's ``qv-…`` id shape (``progressStore.ts`` ``exportIdFor``)
    but namespaced ``sv-`` (StudyVault) since this artifact spans both planes."""
    digits = "".join(ch for ch in exported_at if ch.isdigit())[:14]
    rand = hashlib.sha256(f"{exported_at}:{datetime.now(timezone.utc).timestamp()}"
                          .encode("utf-8")).hexdigest()[:8]
    return f"sv-{digits}-{rand}"


def _bank_row_counts(bank: dict[str, Any]) -> dict[str, int]:
    """Cheap per-collection counts of the LSAT ``data`` payload for the manifest."""
    counts: dict[str, int] = {}
    counts["preptests"] = len(bank.get("preptests", []) or [])
    questions = 0
    for pt in bank.get("preptests", []) or []:
        for sec in pt.get("sections", []) or []:
            questions += len(sec.get("questions", []) or [])
    questions += len(bank.get("unsectioned_questions", []) or [])
    counts["questions"] = questions
    for key in (
        "unsectioned_questions", "study_plans", "settings", "playlists",
        "annotations", "embeddings", "study_sessions", "attempts", "error_log",
        "srs_cards", "reflections", "explanation_feedback",
    ):
        val = bank.get(key)
        if isinstance(val, list):
            counts[key] = len(val)
    return counts


def _bank_carries_official(bank: dict[str, Any]) -> bool:
    """True if the LSAT ``data`` payload contains ANY official content.

    Defense in depth on the IMPORT side: a hand-crafted envelope must not be able
    to smuggle copyrighted official content onto a machine via the unified path.
    Checks both the PrepTest-level ``is_official`` flag and the per-question
    ``source == 'official'`` (the same two firewall points ``export_bank`` uses)."""
    def _q_official(q: dict[str, Any]) -> bool:
        return str(q.get("source", "")) == OFFICIAL

    for pt in bank.get("preptests", []) or []:
        if bool(pt.get("is_official", False)):
            return True
        for sec in pt.get("sections", []) or []:
            for q in sec.get("questions", []) or []:
                if _q_official(q):
                    return True
    for q in bank.get("unsectioned_questions", []) or []:
        if _q_official(q):
            return True
    return False


# --- build -----------------------------------------------------------------
def build_unified_export(
    session: Session,
    *,
    host_data: Optional[dict[str, Any]] = None,
    include_history: bool = True,
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Build the unified {host, lsat} envelope and record it in ExportHistory.

    The LSAT half is the EXISTING ``bank_export.export_bank`` JSON with the hard
    ``include_official=False`` firewall — copyrighted official content never
    enters the artifact. The optional host half (the browser's ``VaultExport``)
    is stored verbatim under ``hostData``.

    Returns a JSON-ready envelope dict::

        {
          "exportId", "exportedAt", "schemaVersion", "hostSchemaVersion"?,
          "format", "sourceHost", "rowCounts", "checksum",
          "data": <bank_export JSON>, "hostData"?: <VaultExport>
        }
    """
    bank = bank_export.export_bank(
        session, include_history=include_history, include_official=False
    )
    exported_at = _now_iso()
    export_id = _export_id(exported_at)

    host_schema_version: Optional[int] = None
    if isinstance(host_data, dict):
        raw = host_data.get("schemaVersion")
        if isinstance(raw, int):
            host_schema_version = raw

    row_counts = _bank_row_counts(bank)
    if isinstance(host_data, dict):
        row_counts["host_present"] = 1

    envelope: dict[str, Any] = {
        "exportId": export_id,
        "exportedAt": exported_at,
        "schemaVersion": SCHEMA_VERSION,
        "format": FORMAT,
        "sourceHost": True,
        "rowCounts": row_counts,
        "data": bank,
    }
    if host_schema_version is not None:
        envelope["hostSchemaVersion"] = host_schema_version
    if isinstance(host_data, dict):
        envelope["hostData"] = host_data
    envelope["checksum"] = compute_checksum(envelope)

    _record_history(
        session,
        export_id=export_id,
        exported_at=exported_at,
        schema_version=SCHEMA_VERSION,
        host_schema_version=host_schema_version,
        checksum=envelope["checksum"],
        row_counts=row_counts,
        source_host=True,
        notes=notes,
    )
    return envelope


# --- validate --------------------------------------------------------------
def validate_envelope(envelope: Any) -> dict[str, Any]:
    """Verify the envelope's schema + checksum BEFORE an import.

    Returns ``{"ok": bool, "errors": [...]}``. Cheap and side-effect-free so the
    UI / route can gate an import on it. A ``schemaVersion`` newer than this build
    supports is rejected (we can't safely interpret it). The firewall is checked
    here too so a crafted official payload fails validation, not just import."""
    errors: list[str] = []
    if not isinstance(envelope, dict):
        return {"ok": False, "errors": ["envelope must be a JSON object"]}

    for key in ("exportId", "exportedAt", "schemaVersion", "format", "checksum",
                "data"):
        if key not in envelope:
            errors.append(f"missing required field: {key}")

    schema = envelope.get("schemaVersion")
    if schema is not None:
        try:
            if int(schema) > SCHEMA_VERSION:
                errors.append(
                    f"envelope schemaVersion={schema} is newer than this build "
                    f"(supports up to {SCHEMA_VERSION}); upgrade StudyVault to import it"
                )
        except (TypeError, ValueError):
            errors.append(f"schemaVersion must be an integer (got {schema!r})")

    fmt = envelope.get("format")
    if fmt is not None and fmt != FORMAT:
        errors.append(f"unsupported format {fmt!r} (expected {FORMAT!r})")

    data = envelope.get("data")
    if data is not None and not isinstance(data, dict):
        errors.append("data must be a JSON object (the LSAT bank export)")

    expected_checksum = envelope.get("checksum")
    if isinstance(expected_checksum, str) and expected_checksum:
        actual = compute_checksum(envelope)
        if actual != expected_checksum:
            errors.append("checksum does not match envelope payload")

    # Firewall: reject an artifact whose LSAT payload carries official content.
    if isinstance(data, dict) and _bank_carries_official(data):
        errors.append(
            "envelope carries official (copyrighted) content, which may not be "
            "imported over the unified export path (provenance firewall)"
        )

    return {"ok": not errors, "errors": errors}


# --- import ----------------------------------------------------------------
def import_unified_export(session: Session, envelope: Any) -> dict[str, Any]:
    """Apply a unified envelope: run the LSAT bank import + record provenance.

    Validates first (schema + checksum + firewall), then routes the LSAT half
    through ``bank_export.import_bank`` (idempotent by external_id/content_hash).
    Records or refreshes the ``ExportHistory`` row keyed by ``exportId`` and
    increments its ``restore_count``.

    Returns ``{"ok", "export_id", "counts", "restore_count", "host_data_present"}``.
    Raises ``ValueError`` on a validation/firewall failure so the route maps it to
    a 400. The host half is NOT applied here — the backend never writes the host's
    Dexie store; ``hostData`` travels for the host to re-import client-side.
    """
    result = validate_envelope(envelope)
    if not result["ok"]:
        raise ValueError("; ".join(result["errors"]) or "invalid export envelope")

    data = envelope.get("data") or {}
    counts = bank_export.import_bank(session, data)

    export_id = str(envelope.get("exportId"))
    exported_at = str(envelope.get("exportedAt") or "")
    schema = int(envelope.get("schemaVersion", SCHEMA_VERSION) or SCHEMA_VERSION)
    host_schema = envelope.get("hostSchemaVersion")
    if host_schema is not None:
        try:
            host_schema = int(host_schema)
        except (TypeError, ValueError):
            host_schema = None
    checksum = str(envelope.get("checksum") or "")
    row_counts = envelope.get("rowCounts")
    if not isinstance(row_counts, dict):
        row_counts = _bank_row_counts(data)

    row = _record_history(
        session,
        export_id=export_id,
        exported_at=exported_at,
        schema_version=schema,
        host_schema_version=host_schema,
        checksum=checksum,
        row_counts=row_counts,
        # An import is, by definition, NOT the source machine's build.
        source_host=False,
        bump_restore=True,
    )

    return {
        "ok": True,
        "export_id": export_id,
        "counts": counts,
        "restore_count": row.restore_count,
        "host_data_present": isinstance(envelope.get("hostData"), dict),
    }


def _record_history(
    session: Session,
    *,
    export_id: str,
    exported_at: str,
    schema_version: int,
    host_schema_version: Optional[int],
    checksum: str,
    row_counts: dict[str, Any],
    source_host: bool,
    bump_restore: bool = False,
    notes: Optional[str] = None,
) -> ExportHistory:
    """UPSERT one ExportHistory row by ``export_id``; bump restore bookkeeping.

    Idempotent: a re-build / re-import of the same ``export_id`` finds the row and
    refreshes its metadata rather than duplicating. When ``bump_restore`` is set
    (the import path) ``restore_count`` is incremented and ``last_restored`` is
    stamped. The single ``session.commit`` here is safe because ``import_bank``
    already committed the bank import as its own atomic transaction first."""
    row = session.exec(
        select(ExportHistory).where(ExportHistory.export_id == export_id)
    ).first()
    now = datetime.now(timezone.utc)
    if row is None:
        row = ExportHistory(
            export_id=export_id,
            exported_at=exported_at,
            schema_version=schema_version,
            host_schema_version=host_schema_version,
            fmt=FORMAT,
            source_host=source_host,
            row_counts=row_counts or {},
            checksum=checksum,
            restore_count=1 if bump_restore else 0,
            last_restored=now if bump_restore else None,
            notes=notes,
        )
        session.add(row)
    else:
        # Refresh metadata; only override source_host on the original build path.
        row.exported_at = exported_at or row.exported_at
        row.schema_version = schema_version
        if host_schema_version is not None:
            row.host_schema_version = host_schema_version
        if checksum:
            row.checksum = checksum
        if row_counts:
            row.row_counts = row_counts
        if notes is not None:
            row.notes = notes
        if bump_restore:
            row.restore_count = int(row.restore_count or 0) + 1
            row.last_restored = now
        row.updated_at = now
        session.add(row)
    session.commit()
    session.refresh(row)
    return row


def list_history(
    session: Session, *, offset: int = 0, limit: int = 50
) -> dict[str, Any]:
    """Paginated ExportHistory feed, newest first."""
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    total = len(session.exec(select(ExportHistory.id)).all())
    rows = session.exec(
        select(ExportHistory)
        .order_by(ExportHistory.created_at.desc(), ExportHistory.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(rows) < total,
        "items": [_history_dict(r) for r in rows],
    }


def get_history(session: Session, export_id: str) -> Optional[dict[str, Any]]:
    """Detail for one ExportHistory row by ``export_id`` (or None)."""
    row = session.exec(
        select(ExportHistory).where(ExportHistory.export_id == export_id)
    ).first()
    return _history_dict(row) if row is not None else None


def _history_dict(row: ExportHistory) -> dict[str, Any]:
    return {
        "export_id": row.export_id,
        "exported_at": row.exported_at,
        "schema_version": row.schema_version,
        "host_schema_version": row.host_schema_version,
        "format": row.fmt,
        "source_host": row.source_host,
        "row_counts": row.row_counts or {},
        "checksum": row.checksum,
        "restore_count": row.restore_count,
        "last_restored": (
            row.last_restored.isoformat() if row.last_restored else None
        ),
        "notes": row.notes,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
