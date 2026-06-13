"""Local DB backup + integrity endpoints (D4). All operations are on-disk and
offline — the only safety net for the single local SQLite file."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import backup

router = APIRouter(prefix="/backup")


@router.get("/list", response_model=dict[str, list[dict[str, Any]]])
def list_backups() -> dict[str, list[dict[str, Any]]]:
    return {"backups": backup.list_backups()}


@router.get("/integrity", response_model=dict[str, Any])
def integrity() -> dict[str, Any]:
    # ``result`` (PRAGMA integrity_check) preserved for the frontend; ``orphans``
    # (dangling-FK sweep, 5.3) is additive. ``report`` is the fuller backend
    # readiness slice for diagnostics and future UI without breaking old callers.
    report = backup.integrity_report()
    return {
        "result": report["integrity_check"]["result"],
        "orphans": report["orphans"],
        "foreign_key_check": report["foreign_key_check"],
        "schema": report["schema"],
        "migrations": report["migrations"],
        "indexes": report["indexes"],
        "triggers": report["triggers"],
        "pragmas": report["pragmas"],
        "backup": report["backup"],
        "ready": report["ready"],
        "status": report["status"],
        "report": report,
    }


@router.post("/now", response_model=dict[str, str])
def backup_now() -> dict[str, str]:
    path = backup.create_backup()
    return {"created": path.name}


class RestoreBody(BaseModel):
    name: str


@router.post("/restore", response_model=dict[str, Any])
def restore(body: RestoreBody) -> dict[str, Any]:
    # Map each restore failure to a DISTINCT status code (Codex #7): a malformed
    # name is a client error, a missing snapshot is 404, and a snapshot that
    # fails integrity/FK verification (or is from a newer schema) is a conflict.
    try:
        backup.restore_backup(body.name)
    except backup.InvalidBackupName as exc:
        raise HTTPException(400, {"error": "invalid_backup_name", "message": str(exc)})
    except backup.BackupNotFound as exc:
        raise HTTPException(404, {"error": "backup_not_found", "message": str(exc)})
    except backup.IncompatibleBackup as exc:
        raise HTTPException(409, {"error": "incompatible_backup", "message": str(exc)})
    except backup.BackupIntegrityError as exc:
        raise HTTPException(409, {"error": "backup_integrity_failed", "message": str(exc)})
    except backup.WorkerPauseError as exc:
        # The live DB was NOT overwritten — safe to retry once the worker is idle.
        raise HTTPException(503, {"error": "worker_busy", "message": str(exc)})
    except backup.RestoreHealError as exc:
        # The snapshot WAS copied but the schema heal failed: the app must be
        # restarted to finish. Report it instead of a false clean success.
        raise HTTPException(
            500,
            {"error": "restore_heal_incomplete", "message": str(exc), "restart_required": True},
        )
    except ValueError as exc:
        # Any future/unclassified ValueError stays a 400 client error.
        raise HTTPException(400, {"error": "restore_failed", "message": str(exc)})
    return {"restored": body.name, "restart_recommended": True}
