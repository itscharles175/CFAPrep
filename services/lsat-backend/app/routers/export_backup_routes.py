"""DATA-5 — unified {host, lsat} export/backup endpoints.

One artifact, one checksum, one provenance ledger. ``POST /api/export/backup``
builds the unified envelope (LSAT bank + optional host VaultExport) and records
it in ``ExportHistory``; ``POST /api/export/import`` routes the LSAT half through
``bank_export.import_bank`` and bumps the provenance row's restore count;
``/validate`` verifies schema + checksum + the official-content firewall before an
import; ``/list`` + ``/history`` expose the provenance ledger.

The hard ``include_official=False`` firewall from ``bank_export`` is preserved on
both sides: official copyrighted content never enters an export, and an import
whose payload carries official content is rejected (400).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from .. import export_backup
from ..db import get_session

router = APIRouter(prefix="/export")


class BackupBody(BaseModel):
    # The host's verbatim VaultExport (Dexie). Optional: omit for an LSAT-only
    # backup. The backend stores it under ``hostData`` and never reaches into the
    # host's store itself.
    host_data: Optional[dict[str, Any]] = None
    include_history: bool = True
    notes: Optional[str] = None
    # Primary backend-native path: return a passphrase-encrypted .qvenc-compatible
    # wrapper. Trusted local callers that encrypt client-side must opt into the
    # plaintext envelope explicitly.
    passphrase: Optional[str] = None
    allow_plaintext: bool = False


@router.post("/backup", response_model=dict[str, Any])
def create_backup(
    body: Optional[BackupBody] = None,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Build the unified {host, lsat} export envelope + record provenance.

    Copyrighted ``official`` LSAT content is always excluded (the
    ``include_official=False`` firewall in ``bank_export``); there is deliberately
    no parameter to include it over the wire."""
    body = body or BackupBody()
    envelope = export_backup.build_unified_export(
        session,
        host_data=body.host_data,
        include_history=body.include_history,
        notes=body.notes,
    )
    if body.passphrase:
        try:
            return export_backup.encrypt_backup_payload(envelope, body.passphrase)
        except ValueError as exc:
            raise HTTPException(
                400, {"error": "backup_encryption_failed", "message": str(exc)}
            )
    if body.allow_plaintext:
        return envelope
    raise HTTPException(
        400,
        {
            "error": "backup_passphrase_required",
            "message": (
                "Unified backups are encrypted by default. Send a passphrase, "
                "or set allow_plaintext=true only when another local layer will "
                "encrypt the envelope before download."
            ),
        },
    )


class EnvelopeBody(BaseModel):
    envelope: dict[str, Any]
    passphrase: Optional[str] = None


def _resolve_envelope(body: EnvelopeBody) -> tuple[dict[str, Any], bool]:
    envelope = body.envelope
    if not export_backup.is_encrypted_backup_blob(envelope):
        return envelope, False
    if not body.passphrase:
        raise HTTPException(
            400,
            {
                "error": "encrypted_backup_passphrase_required",
                "message": "This unified backup is encrypted. Provide passphrase to validate or import it.",
            },
        )
    try:
        return export_backup.decrypt_backup_payload(envelope, body.passphrase), True
    except ValueError as exc:
        raise HTTPException(
            400, {"error": "invalid_encrypted_backup", "message": str(exc)}
        )


@router.post("/validate", response_model=dict[str, Any])
def validate(body: EnvelopeBody) -> dict[str, Any]:
    """Verify an envelope's schema + checksum + firewall BEFORE importing it.

    Side-effect-free. Returns ``{"ok": bool, "errors": [...]}`` so the UI can gate
    the import button and surface a precise reason on a mismatch."""
    envelope, encrypted = _resolve_envelope(body)
    result = export_backup.validate_envelope(envelope)
    result["encrypted"] = encrypted
    return result


@router.post("/import", response_model=dict[str, Any])
def import_backup(
    body: EnvelopeBody,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Import a unified envelope: apply the LSAT bank half + record provenance.

    Validates (schema + checksum + firewall) then routes the LSAT ``data`` through
    the idempotent ``bank_export.import_bank``. A validation/firewall failure is a
    client error (400). The host half (``hostData``) is NOT applied here — the
    host re-imports it client-side; the backend never writes the host's store."""
    try:
        envelope, encrypted = _resolve_envelope(body)
        result = export_backup.import_unified_export(session, envelope)
        result["encrypted"] = encrypted
        return result
    except ValueError as exc:
        raise HTTPException(
            400, {"error": "invalid_export_envelope", "message": str(exc)}
        )


@router.get("/list", response_model=dict[str, Any])
def list_exports(
    offset: int = 0,
    limit: int = 50,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Paginated ExportHistory provenance feed, newest first."""
    return export_backup.list_history(session, offset=offset, limit=limit)


@router.get("/history", response_model=dict[str, Any])
def history(
    export_id: str,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Detail for one provenance row by ``export_id`` (404 if unknown)."""
    row = export_backup.get_history(session, export_id)
    if row is None:
        raise HTTPException(
            404, {"error": "export_not_found", "message": f"no export {export_id!r}"}
        )
    return row
