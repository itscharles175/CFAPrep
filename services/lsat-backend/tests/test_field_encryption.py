from __future__ import annotations

import base64
import sqlite3
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app import backup, config
from app.db_field_crypto import (
    ENVELOPE_PREFIX,
    FieldEncryptionError,
    decrypt_field,
    encrypt_field,
    validate_db_key_b64,
)
from app.models import (
    Attempt,
    AttemptRationale,
    ErrorLogEntry,
    ErrorReason,
    LLMCacheEntry,
    Question,
    QuestionConversation,
    SessionType,
    StudySession,
    TutorTurn,
)


SENTINEL = "FIELDENC_SENTINEL_20260706_ALPHA"


def _key(byte: int) -> str:
    return base64.b64encode(bytes([byte]) * 32).decode("ascii")


@pytest.fixture()
def field_key(monkeypatch):
    key = _key(11)
    monkeypatch.setattr(config, "DB_KEY_B64", key)
    return key


def _seed_sensitive_rows(session: Session, sentinel: str = SENTINEL) -> dict[str, int]:
    q = session.exec(select(Question).order_by(Question.id)).first()
    assert q is not None and q.id is not None
    study = StudySession(type=SessionType.drill)
    session.add(study)
    session.flush()
    assert study.id is not None
    attempt = Attempt(
        question_id=q.id,
        session_id=study.id,
        chosen_answer="A",
        is_correct=False,
    )
    session.add(attempt)
    session.flush()
    assert attempt.id is not None
    rationale = AttemptRationale(
        attempt_id=attempt.id,
        question_id=q.id,
        stage="blind_review",
        rationale_text=f"{sentinel} rationale text",
        br_note=f"{sentinel} br note",
    )
    conversation = QuestionConversation(
        question_id=q.id,
        attempt_id=attempt.id,
        mode="socratic",
        title="Encrypted field test",
    )
    error = ErrorLogEntry(
        attempt_id=attempt.id,
        reason=ErrorReason.trap,
        user_note=f"{sentinel} error note",
        ai_diagnosis=f"{sentinel} diagnosis",
    )
    cache = LLMCacheEntry(
        cache_key="fieldenc-cache-key",
        provider="test",
        model="test-model",
        response=f"{sentinel} cached response",
    )
    session.add(rationale)
    session.add(conversation)
    session.add(error)
    session.add(cache)
    session.flush()
    assert conversation.id is not None
    turn = TutorTurn(
        conversation_id=conversation.id,
        role="user",
        content=f"{sentinel} tutor turn",
    )
    session.add(turn)
    session.commit()
    return {
        "attempt": int(attempt.id),
        "rationale": int(rationale.id),
        "conversation": int(conversation.id),
        "turn": int(turn.id),
        "error": int(error.id),
        "cache": int(cache.id),
    }


def _raw_value(table: str, column: str, row_id: int) -> str:
    con = sqlite3.connect(str(config.DB_PATH))
    try:
        value = con.execute(
            f"SELECT {column} FROM {table} WHERE id = ?",
            (row_id,),
        ).fetchone()[0]
        assert isinstance(value, str)
        return value
    finally:
        con.close()


def _assert_encrypted_raw(table: str, column: str, row_id: int) -> None:
    raw = _raw_value(table, column, row_id)
    assert raw.startswith(ENVELOPE_PREFIX)
    assert SENTINEL not in raw


def test_field_crypto_roundtrip_wrong_key_and_invalid_key(monkeypatch):
    monkeypatch.setattr(config, "DB_KEY_B64", _key(21))
    encrypted = encrypt_field(SENTINEL, field_id="Unit.field")

    assert encrypted is not None
    assert encrypted.startswith(ENVELOPE_PREFIX)
    assert SENTINEL not in encrypted
    assert decrypt_field(encrypted, field_id="Unit.field") == SENTINEL

    monkeypatch.setattr(config, "DB_KEY_B64", _key(22))
    with pytest.raises(FieldEncryptionError):
        decrypt_field(encrypted, field_id="Unit.field")

    with pytest.raises(FieldEncryptionError):
        validate_db_key_b64("not base64")
    with pytest.raises(FieldEncryptionError):
        validate_db_key_b64(base64.b64encode(b"too-short").decode("ascii"))


def test_field_encrypted_rows_store_envelopes_not_plaintext(db_session, field_key):
    ids = _seed_sensitive_rows(db_session)

    _assert_encrypted_raw("attemptrationale", "rationale_text", ids["rationale"])
    _assert_encrypted_raw("attemptrationale", "br_note", ids["rationale"])
    _assert_encrypted_raw("tutorturn", "content", ids["turn"])
    _assert_encrypted_raw("errorlogentry", "user_note", ids["error"])
    _assert_encrypted_raw("errorlogentry", "ai_diagnosis", ids["error"])
    _assert_encrypted_raw("llmcacheentry", "response", ids["cache"])

    row = db_session.get(AttemptRationale, ids["rationale"])
    assert row is not None
    assert row.rationale_text == f"{SENTINEL} rationale text"
    assert row.br_note == f"{SENTINEL} br note"


def test_field_encryption_sentinel_absent_from_db_wal_shm_after_checkpoint(
    db_session,
    field_key,
):
    from app.db import run_db_maintenance

    _seed_sensitive_rows(db_session)
    result = run_db_maintenance(vacuum_freelist_ratio=0.0)
    assert result["wal_checkpoint"] is not None

    needle = SENTINEL.encode("utf-8")
    for path in [
        config.DB_PATH,
        Path(str(config.DB_PATH) + "-wal"),
        Path(str(config.DB_PATH) + "-shm"),
    ]:
        if path.exists():
            assert needle not in path.read_bytes(), f"{path} leaked plaintext sentinel"


def test_field_encryption_backup_db_and_manifest_do_not_leak_sentinel(
    db_session,
    field_key,
):
    _seed_sensitive_rows(db_session)

    snap = backup.create_backup(label="fieldenc")
    manifest = backup.read_backup_manifest(snap)
    assert manifest is not None
    assert manifest["snapshot"]["sha256"]

    needle = SENTINEL.encode("utf-8")
    manifest_path = snap.with_suffix(snap.suffix + ".manifest.json")
    for path in [snap, manifest_path]:
        assert path.exists()
        assert needle not in path.read_bytes(), f"{path} leaked plaintext sentinel"


def test_field_encryption_restore_orm_and_api_decrypt_with_key(client, monkeypatch):
    monkeypatch.setattr(config, "DB_KEY_B64", _key(31))
    from app.db import engine

    with Session(engine) as session:
        ids = _seed_sensitive_rows(session)
    snap = backup.create_backup(label="fieldenc-restore")

    with Session(engine) as session:
        row = session.get(AttemptRationale, ids["rationale"])
        assert row is not None
        session.delete(row)
        session.commit()

    backup.restore_backup(snap.name)

    with Session(engine) as session:
        row = session.get(AttemptRationale, ids["rationale"])
        assert row is not None
        assert row.rationale_text == f"{SENTINEL} rationale text"
        assert row.br_note == f"{SENTINEL} br note"

    response = client.get(f"/api/attempts/{ids['attempt']}/rationales")
    assert response.status_code == 200
    payload = response.json()
    assert any(r["rationale_text"] == f"{SENTINEL} rationale text" for r in payload)
