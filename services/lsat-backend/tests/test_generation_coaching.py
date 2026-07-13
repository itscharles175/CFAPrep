"""W2-2 — generation prompt includes coaching note from fail reasons."""
from __future__ import annotations

from app import generation
from app.models import GenJob, GenStatus


def test_coaching_note_from_fail_reasons(db_session):
    job = GenJob(q_type="Inference", count=1, status=GenStatus.done)
    job.validation_report = {
        "candidates": [
            {"passed": False, "reason": "length_tell"},
            {"passed": False, "reason": "length_tell"},
            {"passed": True, "reason": "ok"},
        ]
    }
    db_session.add(job)
    db_session.commit()

    note = generation._coaching_note(db_session, "Inference")
    assert "length_tell" in note
