"""DATA-7 — cross-store migration + app-data relocation guard.

PROBLEM: a bundle-id / app-data-dir change orphans the LSAT SQLite store under
the OLD OS app-data location (``%APPDATA%/LSATLab`` on Windows, the platform
equivalent elsewhere). DATA-3 only *versions* the cross-domain contract; it never
moves stores. This module is the detect-and-report half of the guard: it resolves
the OLD vs NEW data dir (reusing ``config``'s resolver), reports whether an
orphaned store exists, and — when explicitly asked — performs a single,
idempotent, never-clobbering copy.

DESIGN — PURE & IMPORT-SAFE:
  - No DB writes happen on import (avoids a circular import with ``db.py``, which
    imports ``config``; this module imports only ``config`` + stdlib).
  - The detect/status helpers are read-only and NEVER raise: a missing dir, an
    unreadable file, or a permission error degrades to a visible "can't tell"
    field rather than a 500 — mirroring the observability router's other
    best-effort reads.
  - The migrate helper is conservative: it refuses to overwrite a NON-EMPTY new
    store, only copies when the new store is absent/empty, and is a clean no-op on
    a second call. The Tauri supervisor prefers detect+set-env over a destructive
    move; this helper exists for the rare case where copying the file once is the
    right call, and stays opt-in.

The relocation audit state is persisted (when written at all) as a JSON blob in
the existing ``schema_meta`` key/value table under ``RELOCATION_AUDIT_KEY`` —
mirroring migration 22's ``cross_domain_schema_version`` upsert. NO new
table/migration is added (DATA-7 scope).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

# Persisted-audit key inside the existing ``schema_meta`` table (no new table).
RELOCATION_AUDIT_KEY = "relocation_audit"

# The legacy app-data subdir the store lived under before a bundle-id change.
# config._default_data_dir uses this same leaf, so an unchanged install resolves
# old == new and nothing is flagged as orphaned.
_APP_DATA_LEAF = "LSATLab"

# The SQLite filename config.DB_PATH defaults to (the bank store).
_DB_FILENAME = "lsatlab.db"


def _os_app_data_base() -> str | None:
    """The platform OS app-data base dir (``%APPDATA%`` on Windows, the
    Application Support / XDG dirs elsewhere). Mirrors ``config._default_data_dir``
    so the OLD-dir resolution matches how a packaged build resolved its store.

    Returns ``None`` only if no base can be determined (never raises)."""
    try:
        if sys.platform == "win32":
            return os.environ.get("APPDATA") or str(
                Path.home() / "AppData" / "Roaming"
            )
        if sys.platform == "darwin":
            return str(Path.home() / "Library" / "Application Support")
        return os.environ.get("XDG_DATA_HOME") or str(
            Path.home() / ".local" / "share"
        )
    except Exception:  # pragma: no cover - Path.home() can raise w/o HOME
        return None


def old_data_dir() -> Path | None:
    """The LEGACY app-data dir an orphaned store would live under.

    This is the OS app-data location a packaged build wrote to before a
    bundle-id / app-data-dir change relocated the app's data dir. It is
    deliberately independent of ``LSATLAB_DATA_DIR`` (which the supervisor may
    have already pointed at the NEW dir) so we can detect a store left behind at
    the old path. Returns ``None`` when the OS base can't be resolved."""
    base = _os_app_data_base()
    if not base:
        return None
    return Path(base) / _APP_DATA_LEAF


def new_data_dir() -> Path:
    """The CURRENT (active) data dir — exactly what ``config`` resolved for this
    process. Honours ``LSATLAB_DATA_DIR`` (the supervisor can point it at the
    install's data dir) just like the rest of the backend, so the new store is
    wherever the running process actually reads/writes its SQLite bank."""
    return Path(config.DATA_DIR)


def _store_path(data_dir: Path) -> Path:
    """The SQLite store path within a given data dir."""
    return data_dir / _DB_FILENAME


def _size_bytes(path: Path) -> int | None:
    """File size in bytes, or ``None`` if it can't be read (best-effort)."""
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


def _is_nonempty_store(path: Path) -> bool:
    """True when ``path`` is an existing, non-zero-byte SQLite file. A 0-byte
    file (a stub a half-finished migration might leave) counts as ABSENT for
    clobber-protection purposes, so a real old store can still be copied in."""
    size = _size_bytes(path)
    return size is not None and size > 0


def detect_orphaned_store() -> dict[str, Any]:
    """Detect an LSAT SQLite store orphaned at the OLD app-data dir.

    Returns a serializable dict (never raises):
      - ``orphaned``  — True iff a NON-EMPTY store exists at the old path AND the
        new path differs from it AND the new store is absent/empty. (If the new
        store already holds data, there is nothing to recover — not orphaned.)
      - ``oldPath`` / ``newPath`` — resolved store file paths (str | None).
      - ``oldExists`` / ``newExists`` — whether each store file is present.
      - ``sizeBytes`` — size of the OLD store when present (else ``None``).
      - ``samePath`` — True when old and new resolve to the same store (the
        common, healthy case: nothing to do).
    """
    old_dir = old_data_dir()
    new_dir = new_data_dir()

    old_store = _store_path(old_dir) if old_dir is not None else None
    new_store = _store_path(new_dir)

    old_exists = bool(old_store is not None and old_store.is_file())
    new_exists = bool(new_store.is_file())
    old_size = _size_bytes(old_store) if old_store is not None else None

    # "Same path" is resolved structurally; ``os.path.samefile`` would require
    # both to exist, but we want a stable verdict even when one is missing.
    try:
        same_path = bool(
            old_store is not None
            and old_store.resolve() == new_store.resolve()
        )
    except OSError:  # pragma: no cover - resolve() can raise on odd paths
        same_path = old_store is not None and str(old_store) == str(new_store)

    # Orphaned ⇔ a recoverable non-empty store sits at the old path, the new path
    # is a DIFFERENT location, and the new store doesn't already hold data.
    orphaned = bool(
        old_store is not None
        and not same_path
        and _is_nonempty_store(old_store)
        and not _is_nonempty_store(new_store)
    )

    return {
        "orphaned": orphaned,
        "oldPath": str(old_store) if old_store is not None else None,
        "newPath": str(new_store),
        "oldExists": old_exists,
        "newExists": new_exists,
        "sizeBytes": old_size,
        "samePath": same_path,
    }


def migrate_orphaned_store() -> dict[str, Any]:
    """Idempotently copy an orphaned OLD store to the NEW data dir — guarded.

    Conservative by design (the supervisor prefers detect+set-env over moves):
      - copies ONLY when ``detect_orphaned_store`` reports ``orphaned`` (a
        non-empty old store + an absent/empty new store at a different path);
      - NEVER overwrites a non-empty new store;
      - copies (never deletes the source) so the old store stays as a fallback;
      - a second call is a clean no-op.

    Returns a serializable dict ``{migrated, reason, oldPath, newPath,
    bytesCopied?}``. Never raises: an I/O failure degrades to
    ``{migrated: False, reason: "copy_failed", ...}`` so a caller can surface it
    without crashing.
    """
    import shutil

    detect = detect_orphaned_store()
    old_path = detect["oldPath"]
    new_path = detect["newPath"]

    if not detect["orphaned"]:
        # Not orphaned: either nothing to recover, paths match, or the new store
        # already holds data. All are safe no-ops.
        reason = (
            "same_path"
            if detect["samePath"]
            else "new_store_present"
            if detect["newExists"]
            else "no_old_store"
        )
        return {
            "migrated": False,
            "reason": reason,
            "oldPath": old_path,
            "newPath": new_path,
        }

    src = Path(old_path)  # orphaned guarantees a non-None, non-empty old store
    dst = Path(new_path)
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        # Double-check the clobber guard right before writing (TOCTOU safety):
        # never overwrite a non-empty target even if it appeared since detect().
        if _is_nonempty_store(dst):
            return {
                "migrated": False,
                "reason": "new_store_present",
                "oldPath": old_path,
                "newPath": new_path,
            }
        shutil.copy2(src, dst)
        return {
            "migrated": True,
            "reason": "copied",
            "oldPath": old_path,
            "newPath": new_path,
            "bytesCopied": _size_bytes(dst),
        }
    except OSError:
        return {
            "migrated": False,
            "reason": "copy_failed",
            "oldPath": old_path,
            "newPath": new_path,
        }


def relocation_status() -> dict[str, Any]:
    """Serializable relocation picture for the status endpoint (read-only).

    Folds ``detect_orphaned_store`` into a single ``status`` verdict the host can
    branch on:
      - ``ok``        — old and new resolve to the same store (healthy, nothing
        to do), or no orphaned store exists.
      - ``orphaned``  — a recoverable store sits at the OLD app-data dir and the
        NEW store is absent/empty: a relocation is needed.

    Never raises; every underlying read degrades softly."""
    detect = detect_orphaned_store()
    status = "orphaned" if detect["orphaned"] else "ok"
    return {
        "status": status,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        # Echo the detect fields verbatim so the host has the full picture.
        "orphaned": detect["orphaned"],
        "oldPath": detect["oldPath"],
        "newPath": detect["newPath"],
        "oldExists": detect["oldExists"],
        "newExists": detect["newExists"],
        "sizeBytes": detect["sizeBytes"],
        "samePath": detect["samePath"],
    }


def relocation_audit_blob() -> str:
    """A JSON blob suitable for persisting under ``RELOCATION_AUDIT_KEY`` in the
    existing ``schema_meta`` key/value table (mirrors migration 22's upsert).

    Provided as a pure builder so a caller that DOES want to record the audit can
    do its own upsert; this module never writes to the DB itself (import-safety).
    """
    return json.dumps(relocation_status(), separators=(",", ":"))
