"""Foreign-key enforcement is ON in production but OFF in the shared test engine.

Why this module exists (Codex P2 #10)
-------------------------------------
Production / dev run SQLite with ``PRAGMA foreign_keys=ON`` (``app/db.py``'s
``_set_connection_pragmas`` listener, gated on ``config.SQLITE_FK_ENFORCE`` which
defaults true). The shared pytest fixtures, however, set ``LSATLAB_SQLITE_FK=0``
in ``conftest.py`` *before* the app imports, so the conftest engine has FK
enforcement OFF. That makes the whole suite blind to FK-violating regressions: a
raw delete that orphans children, or an insert that points at a non-existent
parent, passes silently against the shared engine even though the SAME write
would be rejected by the real app database.

This module closes that gap. It is deliberately SELF-CONTAINED: it builds its own
dedicated engine against a temp-file SQLite DB with a connection listener that
mirrors ``app/db.py`` and issues ``PRAGMA foreign_keys=ON`` unconditionally, then
exercises a few integrity-sensitive flows with enforcement genuinely on. It does
not touch ``app.db.engine`` or the conftest fixtures.

The models (``app/models.py``) declare their relationships as plain
``Field(foreign_key=...)`` with NO ``ondelete`` clause, so SQLite's default
``ON DELETE NO ACTION`` applies: deleting a parent that still has children is
RESTRICTED (raises), children are neither cascaded nor nulled. That is the exact
contract the application relies on (``import_pdf._delete_preptest`` deletes
children before parents precisely because the raw parent delete would otherwise
be blocked), and it is the contract this module locks.
"""
from __future__ import annotations

import os

import pytest
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, create_engine, select

from app import models  # noqa: F401  (registers tables on SQLModel.metadata)
from app.models import (
    AnswerChoice,
    Attempt,
    AttemptMode,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
    StudySession,
)


# --- a dedicated FK-ON engine, independent of the conftest engine -----------
def _make_fk_engine(db_path: str):
    """A throwaway temp-file SQLite engine with foreign keys genuinely ON.

    Mirrors ``app/db.py``: a ``connect`` listener issues ``PRAGMA
    foreign_keys=ON`` on every new connection (SQLite resets the pragma per
    connection, so it has to be re-applied on connect, not once). We force it ON
    here unconditionally — this engine exists *specifically* to test the FK-on
    contract — rather than reading ``config.SQLITE_FK_ENFORCE`` (which the shared
    test process has flipped off via ``conftest``).
    """
    url = "sqlite:///" + db_path.replace("\\", "/")
    engine = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _fk_pragma(dbapi_connection, _connection_record):  # noqa: ANN001
        cur = dbapi_connection.cursor()
        try:
            cur.execute("PRAGMA foreign_keys=ON")
        finally:
            cur.close()

    # Create the real schema the same way init_db() does: SQLModel tables plus
    # the recorded migrations (indexes/triggers/backfills). This keeps the test
    # locked to the production schema, not a hand-rolled subset.
    SQLModel.metadata.create_all(engine)
    from app.migrations import run_migrations

    run_migrations(engine)
    return engine


@pytest.fixture()
def fk_engine(tmp_path):
    """Hermetic per-test engine on a temp file; disposed at the end."""
    db_path = os.path.join(str(tmp_path), "lsatlab_fk_integration.db")
    engine = _make_fk_engine(db_path)
    try:
        yield engine
    finally:
        engine.dispose()


def _seed_question_with_children(engine) -> dict:
    """Build a PrepTest -> Section -> Question with 5 AnswerChoices and one
    Attempt, so a parent delete has real children to restrict against."""
    with Session(engine) as s:
        pt = PrepTest(name="FK PT", source="sample", is_official=False)
        s.add(pt)
        s.commit()
        s.refresh(pt)
        sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0)
        s.add(sec)
        s.commit()
        s.refresh(sec)
        q = Question(
            section_id=sec.id, stem="fk stem", prompt="p?", correct_answer="A",
            q_type="Flaw", source=QuestionSource.sample,
        )
        s.add(q)
        s.commit()
        s.refresh(q)
        for lbl in "ABCDE":
            s.add(AnswerChoice(question_id=q.id, label=lbl, text=lbl,
                               is_correct=(lbl == "A")))
        sess = StudySession(type="section")
        s.add(sess)
        s.commit()
        s.refresh(sess)
        att = Attempt(question_id=q.id, session_id=sess.id,
                      mode=AttemptMode.timed, chosen_answer="B", is_correct=False)
        s.add(att)
        s.commit()
        s.refresh(att)
        return {"question_id": q.id, "attempt_id": att.id, "section_id": sec.id}


# --- enforcement is actually ON in this engine ------------------------------
def test_pragma_foreign_keys_is_on(fk_engine):
    """Sanity: the dedicated engine really has enforcement on (the whole point —
    the shared conftest engine reports 0 here)."""
    with fk_engine.connect() as conn:
        (flag,) = conn.exec_driver_sql("PRAGMA foreign_keys").fetchone()
    assert flag == 1


# --- (b) inserting a child with a non-existent parent FK is rejected ---------
def test_insert_child_with_missing_parent_raises(fk_engine):
    """Proves enforcement is genuinely on: an AnswerChoice pointing at a
    question_id that does not exist must be rejected at commit."""
    with Session(fk_engine) as s:
        s.add(AnswerChoice(question_id=999_999, label="A", text="orphan"))
        with pytest.raises(IntegrityError) as exc:
            s.commit()
    assert "FOREIGN KEY constraint failed" in str(exc.value.orig)

    # And nothing leaked in: the rejected row is not persisted.
    with Session(fk_engine) as s:
        leaked = s.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == 999_999)
        ).all()
    assert leaked == []


def test_insert_attempt_with_missing_question_raises(fk_engine):
    """Second integrity-sensitive child relationship: Attempt.question_id.

    The session_id is valid (real StudySession) so only the dangling
    question_id can be the cause — confirming per-FK enforcement, not just a
    generic 'something was wrong' rejection."""
    with Session(fk_engine) as s:
        sess = StudySession(type="section")
        s.add(sess)
        s.commit()
        s.refresh(sess)
        sid = sess.id

    with Session(fk_engine) as s:
        s.add(Attempt(question_id=999_999, session_id=sid,
                      mode=AttemptMode.timed))
        with pytest.raises(IntegrityError) as exc:
            s.commit()
    assert "FOREIGN KEY constraint failed" in str(exc.value.orig)


# --- (a) deleting a parent with children is RESTRICTED (no orphans) ----------
def test_delete_question_with_children_is_restricted_no_orphans(fk_engine):
    """The models declare no ``ondelete`` cascade, so SQLite restricts the
    delete of a Question that still has AnswerChoice / Attempt children: the
    commit raises, and after rollback every row is intact (no orphans)."""
    ids = _seed_question_with_children(fk_engine)
    qid, aid = ids["question_id"], ids["attempt_id"]

    with Session(fk_engine) as s:
        s.delete(s.get(Question, qid))
        with pytest.raises(IntegrityError) as exc:
            s.commit()
        assert "FOREIGN KEY constraint failed" in str(exc.value.orig)
        s.rollback()

    # The parent and ALL its children survived the blocked delete.
    with Session(fk_engine) as s:
        assert s.get(Question, qid) is not None
        choices = s.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == qid)
        ).all()
        attempts = s.exec(
            select(Attempt).where(Attempt.question_id == qid)
        ).all()
    assert len(choices) == 5
    assert [a.id for a in attempts] == [aid]


def test_raw_delete_from_question_is_also_blocked(fk_engine):
    """The raw ``DELETE FROM question`` path (the move ``import_pdf`` must AVOID
    by deleting children first, and the trick ``test_r7_integrity`` uses to
    fabricate orphans) is blocked too under FK-on — documenting exactly why the
    app's delete ordering matters and why those orphan-creation tests only work
    against the FK-off conftest engine."""
    ids = _seed_question_with_children(fk_engine)
    qid = ids["question_id"]

    with pytest.raises(IntegrityError) as exc:
        with fk_engine.begin() as conn:
            conn.exec_driver_sql(f"DELETE FROM question WHERE id = {qid}")
    assert "FOREIGN KEY constraint failed" in str(exc.value.orig)

    # Children remain (the raw delete never took effect).
    with Session(fk_engine) as s:
        assert s.get(Question, qid) is not None
        assert s.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == qid)
        ).all()


def test_child_first_delete_order_succeeds_under_fk_on(fk_engine):
    """The happy path: deleting children BEFORE the parent (the ordering
    ``import_pdf._delete_preptest`` uses) commits cleanly even with enforcement
    on, and leaves no rows behind. This is the positive complement to the
    restrict tests above."""
    ids = _seed_question_with_children(fk_engine)
    qid = ids["question_id"]

    with Session(fk_engine) as s:
        for child in s.exec(
            select(Attempt).where(Attempt.question_id == qid)
        ).all():
            s.delete(child)
        for child in s.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == qid)
        ).all():
            s.delete(child)
        s.commit()
        # Now the parent delete is permitted.
        s.delete(s.get(Question, qid))
        s.commit()  # must not raise

    with Session(fk_engine) as s:
        assert s.get(Question, qid) is None
        assert s.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == qid)
        ).all() == []
        assert s.exec(
            select(Attempt).where(Attempt.question_id == qid)
        ).all() == []
