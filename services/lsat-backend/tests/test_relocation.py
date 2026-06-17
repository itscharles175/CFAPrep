"""DATA-7 — cross-store migration + app-data relocation guard.

Covers:
  - ``relocation_status()`` shape (status verdict + resolved paths + flags).
  - ``detect_orphaned_store()`` with monkeypatched old/new dirs:
      * orphaned True when the OLD store exists + non-empty and the NEW is absent;
      * orphaned False when the NEW store already holds data, when paths match,
        and when no old store exists.
  - ``migrate_orphaned_store()`` recovers an orphaned store AND never clobbers a
    non-empty new store; a second call is a clean no-op.
  - GET /api/observability/relocation-status returns 200 with the expected keys
    and the route is exposed in the OpenAPI schema (mirrors test_sync_progress.py).

Pure-logic tests monkeypatch ``relocation.old_data_dir`` /
``relocation.new_data_dir`` to point at tmp dirs, so they never touch the real OS
app-data location.
"""
from __future__ import annotations

from pathlib import Path

import pytest


# --- helpers ----------------------------------------------------------------
def _write_store(data_dir: Path, content: bytes) -> Path:
    """Create ``<data_dir>/lsatlab.db`` with ``content``; returns its path."""
    data_dir.mkdir(parents=True, exist_ok=True)
    store = data_dir / "lsatlab.db"
    store.write_bytes(content)
    return store


def _patch_dirs(monkeypatch, old_dir: Path | None, new_dir: Path) -> None:
    from app import relocation

    monkeypatch.setattr(relocation, "old_data_dir", lambda: old_dir)
    monkeypatch.setattr(relocation, "new_data_dir", lambda: new_dir)


# --- detect_orphaned_store --------------------------------------------------
def test_detect_orphaned_true_when_old_present_new_absent(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    _write_store(old_dir, b"a-real-sqlite-bank")
    # new_dir has no store at all.
    _patch_dirs(monkeypatch, old_dir, new_dir)

    detect = relocation.detect_orphaned_store()
    assert detect["orphaned"] is True
    assert detect["oldExists"] is True
    assert detect["newExists"] is False
    assert detect["samePath"] is False
    assert detect["sizeBytes"] == len(b"a-real-sqlite-bank")
    assert detect["oldPath"].endswith("lsatlab.db")
    assert detect["newPath"].endswith("lsatlab.db")


def test_detect_not_orphaned_when_new_store_nonempty(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    _write_store(old_dir, b"old-bytes")
    _write_store(new_dir, b"new-store-already-populated")
    _patch_dirs(monkeypatch, old_dir, new_dir)

    detect = relocation.detect_orphaned_store()
    # New store already holds data → nothing to recover.
    assert detect["orphaned"] is False
    assert detect["newExists"] is True


def test_detect_not_orphaned_when_paths_same(monkeypatch, tmp_path):
    from app import relocation

    same = tmp_path / "shared"
    _write_store(same, b"the-only-store")
    _patch_dirs(monkeypatch, same, same)

    detect = relocation.detect_orphaned_store()
    assert detect["samePath"] is True
    assert detect["orphaned"] is False


def test_detect_not_orphaned_when_no_old_store(monkeypatch, tmp_path):
    from app import relocation

    new_dir = tmp_path / "new"
    # No old dir resolvable at all (OS base couldn't resolve).
    _patch_dirs(monkeypatch, None, new_dir)

    detect = relocation.detect_orphaned_store()
    assert detect["orphaned"] is False
    assert detect["oldPath"] is None
    assert detect["oldExists"] is False


def test_detect_zero_byte_old_store_not_orphaned(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    _write_store(old_dir, b"")  # 0-byte stub counts as absent
    _patch_dirs(monkeypatch, old_dir, new_dir)

    detect = relocation.detect_orphaned_store()
    assert detect["orphaned"] is False


# --- migrate_orphaned_store -------------------------------------------------
def test_migrate_recovers_orphaned_store(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    payload = b"recoverable-bank-content"
    _write_store(old_dir, payload)
    _patch_dirs(monkeypatch, old_dir, new_dir)

    result = relocation.migrate_orphaned_store()
    assert result["migrated"] is True
    assert result["reason"] == "copied"
    new_store = new_dir / "lsatlab.db"
    assert new_store.read_bytes() == payload
    # Source is preserved (copy, not move).
    assert (old_dir / "lsatlab.db").read_bytes() == payload


def test_migrate_is_idempotent_no_op_second_call(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    _write_store(old_dir, b"bank")
    _patch_dirs(monkeypatch, old_dir, new_dir)

    first = relocation.migrate_orphaned_store()
    assert first["migrated"] is True
    # Second call: the new store now holds data → recognised no-op.
    second = relocation.migrate_orphaned_store()
    assert second["migrated"] is False
    assert second["reason"] == "new_store_present"


def test_migrate_never_clobbers_nonempty_new_store(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    _write_store(old_dir, b"old-bank")
    _write_store(new_dir, b"PRECIOUS-existing-data")
    _patch_dirs(monkeypatch, old_dir, new_dir)

    result = relocation.migrate_orphaned_store()
    assert result["migrated"] is False
    # The existing new store is untouched.
    assert (new_dir / "lsatlab.db").read_bytes() == b"PRECIOUS-existing-data"


# --- relocation_status shape ------------------------------------------------
_STATUS_KEYS = {
    "status",
    "generated_at",
    "orphaned",
    "oldPath",
    "newPath",
    "oldExists",
    "newExists",
    "sizeBytes",
    "samePath",
}


def test_relocation_status_shape_ok(monkeypatch, tmp_path):
    from app import relocation

    same = tmp_path / "shared"
    _write_store(same, b"store")
    _patch_dirs(monkeypatch, same, same)

    status = relocation.relocation_status()
    assert set(status) == _STATUS_KEYS
    assert status["status"] == "ok"
    assert status["orphaned"] is False


def test_relocation_status_shape_orphaned(monkeypatch, tmp_path):
    from app import relocation

    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    _write_store(old_dir, b"orphan-bank")
    _patch_dirs(monkeypatch, old_dir, new_dir)

    status = relocation.relocation_status()
    assert set(status) == _STATUS_KEYS
    assert status["status"] == "orphaned"
    assert status["orphaned"] is True


def test_relocation_status_never_raises_real_dirs():
    """Against the REAL (un-monkeypatched) resolvers it still returns a coherent
    serializable dict — no exception even if no orphaned store exists."""
    from app import relocation

    status = relocation.relocation_status()
    assert set(status) == _STATUS_KEYS
    assert status["status"] in {"ok", "orphaned"}


# --- GET /api/observability/relocation-status -------------------------------
def test_relocation_status_endpoint_200(client):
    r = client.get("/api/observability/relocation-status")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == _STATUS_KEYS
    assert body["status"] in {"ok", "orphaned"}
    assert isinstance(body["orphaned"], bool)


def test_relocation_status_route_has_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/observability/relocation-status"]["get"]
    assert op["responses"]["200"]["content"]["application/json"].get("schema")
