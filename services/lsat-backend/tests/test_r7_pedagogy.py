"""R7 Backend Wave 1 — "pedagogy comes alive".

Covers:
  1.1  Blind-Review 2x2 outcome -> SRS/drill routing (concept_gap / lucky /
       timing_problem split, idempotency, remediation + pacing queues, concept_gap
       drill targeting).
  1.2  Choice-level interaction capture (ingest -> persist -> review retrieval) +
       the elimination-insight readout.
  1.3  Confidence-calibration analytics (band accuracy, over/under-confidence,
       sure-but-wrong / guess-but-right).
  1.4  Error-reason trend analytics (overall, by q_type, earlier-vs-recent).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import analytics, pedagogy
from app.models import (
    Attempt,
    AttemptChoiceEvent,
    AttemptMode,
    Confidence,
    ErrorLogEntry,
    ErrorReason,
    Question,
    SessionType,
    SRSCard,
    StudySession,
)


def _correct_answer(client, qid: int) -> str:
    # The public reveal endpoint now requires attempted-question context; these
    # tests need the seeded key only to construct known outcome rows.
    del client
    from app.db import engine
    with Session(engine) as s:
        q = s.get(Question, qid)
        assert q is not None
        return q.correct_answer


def _wrong(correct: str) -> str:
    return "A" if correct != "A" else "B"


def _attempt(client, sid: int, qid: int, chosen: str, *, time_ms: int = 60000,
             confidence: str | None = None, choice_events=None) -> int:
    body = {"question_id": qid, "mode": "timed", "chosen_answer": chosen,
            "time_ms": time_ms, "flagged": False}
    if confidence:
        body["confidence"] = confidence
    if choice_events is not None:
        body["choice_events"] = choice_events
    return client.post(f"/api/sessions/{sid}/attempts", json=body).json()["attempt_id"]


def _br(client, attempt_id: int, answer: str) -> dict:
    """Commit a blind-review answer. Returns the response (incl. outcome_routing),
    since routing fires HERE (BR-commit) — the timed section finishes first."""
    return client.patch(
        f"/api/attempts/{attempt_id}/blind-review", json={"br_answer": answer}
    ).json()


# Questions 1, 4, 8, 9 have NO seeded SRS card (seed cards are qids 2,3,6,7),
# so routing assertions on them start from a clean slate.
Q_OK, Q_TIMING, Q_CONCEPT, Q_LUCKY = 1, 4, 8, 9


def _build_four_outcomes(client) -> int:
    """One session exercising all four 2x2 outcomes on card-free questions."""
    sid = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]

    # timed_ok: timed right, BR right
    c = _correct_answer(client, Q_OK)
    a = _attempt(client, sid, Q_OK, c)
    _br(client, a, c)

    # timing_problem: timed wrong, BR right
    c = _correct_answer(client, Q_TIMING)
    a = _attempt(client, sid, Q_TIMING, _wrong(c), time_ms=110000)
    _br(client, a, c)

    # concept_gap: timed wrong, BR wrong
    c = _correct_answer(client, Q_CONCEPT)
    a = _attempt(client, sid, Q_CONCEPT, _wrong(c))
    _br(client, a, _wrong(c))

    # lucky: timed right, BR wrong
    c = _correct_answer(client, Q_LUCKY)
    a = _attempt(client, sid, Q_LUCKY, c)
    _br(client, a, _wrong(c))
    return sid


# --- 1.1 outcome -> SRS/drill routing ---------------------------------------
def test_finish_routes_outcomes_to_srs(client):
    sid = _build_four_outcomes(client)

    # Cards are created at BR-commit time (route_one) — the REAL flow, since the
    # timed section finishes before blind review. So they already exist here,
    # before finish() is called.
    from app.db import engine
    with Session(engine) as s:
        cards = {c.question_id: c for c in s.exec(select(SRSCard)).all()}
    assert cards[Q_CONCEPT].origin == "concept_gap"
    assert cards[Q_LUCKY].origin == "lucky"
    assert Q_OK not in cards          # timed_ok creates nothing
    assert Q_TIMING not in cards      # timing_problem creates NO concept card

    # finish() re-routes idempotently and returns a tally of all outcomes; it
    # creates nothing new because the BR commits already did.
    routing = client.post(f"/api/sessions/{sid}/finish").json()["outcome_routing"]
    assert routing["counts"]["timed_ok"] == 1
    assert routing["counts"]["timing_problem"] == 1
    assert routing["counts"]["concept_gap"] == 1
    assert routing["counts"]["lucky"] == 1
    assert routing["concept_gap_cards"] == 0   # already created at BR commit
    assert routing["lucky_cards"] == 0
    assert routing["timing_problems"] == 1


def test_br_commit_routes_in_real_flow(client):
    """Guard the real ordering: the timed section finishes with NO blind-review
    answers (routes nothing), then each BR answer is committed afterward and the
    PATCH itself fires the loop. (Regression: routing used to be wired only to
    finish, so it never fired in production.)"""
    sid = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]
    c = _correct_answer(client, Q_CONCEPT)
    aid = _attempt(client, sid, Q_CONCEPT, _wrong(c))

    # Timed finish first — BR data does not exist yet, so nothing is routed.
    fin = client.post(f"/api/sessions/{sid}/finish").json()
    assert fin["outcome_routing"]["concept_gap_cards"] == 0
    from app.db import engine
    with Session(engine) as s:
        assert s.exec(
            select(SRSCard).where(SRSCard.question_id == Q_CONCEPT)
        ).first() is None

    # Commit the BR answer (wrong again -> concept_gap): the PATCH must route now.
    resp = _br(client, aid, _wrong(c))
    assert resp["outcome_routing"]["concept_gap_cards"] == 1
    with Session(engine) as s:
        card = s.exec(
            select(SRSCard).where(SRSCard.question_id == Q_CONCEPT)
        ).first()
    assert card is not None and card.origin == "concept_gap"


def test_lucky_scheduled_soon(client):
    sid = _build_four_outcomes(client)
    client.post(f"/api/sessions/{sid}/finish")
    # The lucky card should be due soon (fragile knowledge) — within ~half a day.
    from app.db import engine
    with Session(engine) as s:
        card = s.exec(select(SRSCard).where(SRSCard.question_id == Q_LUCKY)).first()
        due = card.due_date
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
    assert due <= datetime.now(timezone.utc) + timedelta(hours=13)


def test_lucky_pulls_existing_card_sooner(client):
    """If a card already exists for a lucky question, its due date is pulled in."""
    from app.db import engine
    # Pre-create a far-future manual card for Q_LUCKY.
    far = datetime.now(timezone.utc) + timedelta(days=30)
    with Session(engine) as s:
        from app import srs
        s.add(SRSCard(question_id=Q_LUCKY, fsrs_state=srs.new_card_state(),
                      due_date=far, origin="manual"))
        s.commit()

    # The lucky BR commit (inside _build_four_outcomes) pulls the existing card
    # in; no NEW card is created (one already existed).
    sid = _build_four_outcomes(client)
    with Session(engine) as s:
        card = s.exec(select(SRSCard).where(SRSCard.question_id == Q_LUCKY)).first()
        due = card.due_date
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        # origin is preserved (we don't relabel a manual card)
        assert card.origin == "manual"
    assert due < far

    # finish() is then an idempotent no-op for the lucky card (already pulled in).
    routing = client.post(f"/api/sessions/{sid}/finish").json()["outcome_routing"]
    assert routing["lucky_cards"] == 0
    assert routing["lucky_pulled_sooner"] == 0


def test_routing_is_idempotent(client):
    sid = _build_four_outcomes(client)
    client.post(f"/api/sessions/{sid}/finish")
    from app.db import engine
    with Session(engine) as s:
        n_after_first = len(s.exec(select(SRSCard)).all())
    # Re-finish: must not duplicate cards.
    routing2 = client.post(f"/api/sessions/{sid}/finish").json()["outcome_routing"]
    assert routing2["concept_gap_cards"] == 0
    assert routing2["lucky_cards"] == 0
    assert routing2["lucky_pulled_sooner"] == 0  # already pulled in
    with Session(engine) as s:
        n_after_second = len(s.exec(select(SRSCard)).all())
    assert n_after_first == n_after_second


def test_concept_gap_and_pacing_queues(client):
    sid = _build_four_outcomes(client)
    client.post(f"/api/sessions/{sid}/finish")

    cgq = client.get("/api/srs/concept-gap-queue").json()
    assert cgq["count"] >= 1
    cg_qids = {c["question_id"] for c in cgq["cards"]}
    assert Q_CONCEPT in cg_qids
    assert Q_TIMING not in cg_qids  # timing problems are NOT concept gaps
    assert all(c["origin"] == "concept_gap" for c in cgq["cards"])
    # answer key never leaks into the queue rows
    assert all("correct_answer" not in c for c in cgq["cards"])

    pq = client.get("/api/drills/pacing-queue").json()
    pacing_qids = {q["question_id"] for q in pq["questions"]}
    assert Q_TIMING in pacing_qids
    assert Q_CONCEPT not in pacing_qids  # concept gaps are not pacing problems
    assert Q_LUCKY not in pacing_qids


def test_concept_gap_drill_targeting(client):
    sid = _build_four_outcomes(client)
    client.post(f"/api/sessions/{sid}/finish")

    r = client.post("/api/drills", json={"origin": "concept_gap", "count": 10})
    assert r.status_code == 200
    data = r.json()
    qids = {q["id"] for q in data["questions"]}
    # the concept_gap question is included; lucky/timed_ok are not.
    assert Q_CONCEPT in qids
    assert Q_LUCKY not in qids
    assert Q_OK not in qids
    # test-mode payloads (no answer leak)
    assert all("correct_answer" not in q for q in data["questions"])


# --- 1.2 choice-event ingestion + retrieval + insight -----------------------
def test_choice_events_ingested_and_returned_in_review(client):
    sid = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()["id"]
    c = _correct_answer(client, Q_OK)
    events = [
        {"label": "A", "action": "eliminate", "order_index": 0, "time_ms": 1000},
        {"label": "B", "action": "eliminate", "order_index": 1, "time_ms": 2500,
         "confidence": "likely"},
        {"label": c, "action": "select", "order_index": 2, "time_ms": 4000,
         "confidence": "sure"},
    ]
    aid = _attempt(client, sid, Q_OK, c, choice_events=events)
    _br(client, aid, c)
    client.post(f"/api/sessions/{sid}/finish")

    res = client.get(f"/api/sessions/{sid}/results").json()
    item = next(it for it in res["items"] if it["attempt"]["attempt_id"] == aid)
    ce = item["attempt"]["choice_events"]
    assert len(ce) == 3
    # returned in order_index order
    assert [e["order_index"] for e in ce] == [0, 1, 2]
    assert ce[0]["label"] == "A" and ce[0]["action"] == "eliminate"
    assert ce[2]["label"] == c and ce[2]["action"] == "select"
    assert ce[1]["confidence"] == "likely"


def test_attempt_without_choice_events_has_empty_list(client):
    sid = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()["id"]
    c = _correct_answer(client, Q_OK)
    aid = _attempt(client, sid, Q_OK, c)
    client.post(f"/api/sessions/{sid}/finish")
    res = client.get(f"/api/sessions/{sid}/results").json()
    item = next(it for it in res["items"] if it["attempt"]["attempt_id"] == aid)
    assert item["attempt"]["choice_events"] == []


def test_elimination_insight(client, db_session: Session):
    """Construct two traced attempts with known process: one where the correct
    answer was eliminated then re-selected (talked self out of it), and one where
    a trap was the last thing eliminated."""
    from app.db import engine
    with Session(engine) as s:
        sess = StudySession(type=SessionType.drill)
        s.add(sess)
        s.commit()
        s.refresh(sess)
        q1 = s.get(Question, Q_OK)
        q2 = s.get(Question, Q_TIMING)
        correct1, correct2 = q1.correct_answer, q2.correct_answer
        wrong1 = _wrong(correct1)

        # Attempt 1: correct, but eliminated the correct answer first then restored+chose it.
        a1 = Attempt(question_id=q1.id, session_id=sess.id, mode=AttemptMode.timed,
                     chosen_answer=correct1, is_correct=True)
        s.add(a1)
        s.commit()
        s.refresh(a1)
        s.add_all([
            AttemptChoiceEvent(attempt_id=a1.id, label=correct1, action="eliminate", order_index=0),
            AttemptChoiceEvent(attempt_id=a1.id, label=wrong1, action="eliminate", order_index=1),
            AttemptChoiceEvent(attempt_id=a1.id, label=correct1, action="restore", order_index=2),
            AttemptChoiceEvent(attempt_id=a1.id, label=correct1, action="select", order_index=3),
        ])

        # Attempt 2: correct; a wrong choice (trap) was the LAST elimination.
        trap2 = _wrong(correct2)
        a2 = Attempt(question_id=q2.id, session_id=sess.id, mode=AttemptMode.timed,
                     chosen_answer=correct2, is_correct=True)
        s.add(a2)
        s.commit()
        s.refresh(a2)
        s.add_all([
            AttemptChoiceEvent(attempt_id=a2.id, label="C", action="eliminate", order_index=0),
            AttemptChoiceEvent(attempt_id=a2.id, label=trap2, action="eliminate", order_index=1),
            AttemptChoiceEvent(attempt_id=a2.id, label=correct2, action="select", order_index=2),
        ])
        s.commit()

    with Session(engine) as s:
        ins = analytics.elimination_insight(s)
    assert ins["n_traced_attempts"] == 2
    assert ins["correct_eliminated_first"] == 1          # attempt 1
    assert ins["correct_eliminated_first_rate"] == 0.5   # 1 of 2 correct traced
    assert ins["trap_eliminated_last"] == 2              # both ended on a wrong-choice elimination
    assert ins["trap_eliminated_last_rate"] == 1.0

    # endpoint shape
    j = client.get("/api/analytics/elimination").json()
    assert "correct_eliminated_first_rate" in j and "trap_eliminated_last_rate" in j


# --- 1.3 confidence calibration ---------------------------------------------
def _seed_confidence_attempts(engine) -> None:
    """Known confidence/correctness mix on a fresh session:
       sure:    4 attempts, 3 correct  (one 'sure but wrong')
       likely:  2 attempts, 1 correct
       guess:   4 attempts, 2 correct  ('guess but right' = 2/4)
    """
    with Session(engine) as s:
        sess = StudySession(type=SessionType.drill)
        s.add(sess)
        s.commit()
        s.refresh(sess)
        qid = Q_OK
        spec = [
            (Confidence.sure, True), (Confidence.sure, True), (Confidence.sure, True),
            (Confidence.sure, False),
            (Confidence.likely, True), (Confidence.likely, False),
            (Confidence.guess, True), (Confidence.guess, True),
            (Confidence.guess, False), (Confidence.guess, False),
        ]
        for conf, ok in spec:
            s.add(Attempt(question_id=qid, session_id=sess.id, mode=AttemptMode.timed,
                          chosen_answer="A", is_correct=ok, confidence=conf))
        s.commit()


def test_confidence_calibration_structure(db_session: Session):
    """Structural check against seed + injected attempts (seed attempts also carry
    confidence). Exact math is pinned in test_confidence_calibration_isolated."""
    from app.db import engine
    _seed_confidence_attempts(engine)
    with Session(engine) as s:
        cal = analytics.confidence_calibration(s)

    bands = {b["confidence"]: b for b in cal["bands"]}
    assert set(bands) == {"sure", "likely", "guess"}
    assert bands["sure"]["attempts"] >= 4
    assert bands["guess"]["attempts"] >= 4
    for b in cal["bands"]:
        if b["attempts"]:
            assert 0.0 <= b["accuracy"] <= 1.0
            assert b["correct"] <= b["attempts"]
    assert cal["verdict"] in ("overconfident", "underconfident", "calibrated")
    assert 0.0 <= cal["sure_but_wrong_rate"] <= 1.0
    assert 0.0 <= cal["guess_but_right_rate"] <= 1.0
    assert cal["n"] == sum(b["attempts"] for b in cal["bands"])


def test_confidence_calibration_isolated(db_session: Session):
    """Pin the exact math on a DB whose ONLY confidence-rated attempts are ours.

    The seed session's attempts carry confidence, so first delete all attempts,
    then inject a known mix and assert exact band accuracy + summary rates."""
    from app.db import engine
    with Session(engine) as s:
        for a in s.exec(select(Attempt)).all():
            s.delete(a)
        s.commit()
    _seed_confidence_attempts(engine)
    with Session(engine) as s:
        cal = analytics.confidence_calibration(s)

    bands = {b["confidence"]: b for b in cal["bands"]}
    assert bands["sure"] == {"confidence": "sure", "attempts": 4, "correct": 3,
                             "accuracy": 0.75, "nominal_confidence": 0.9}
    assert bands["likely"]["attempts"] == 2 and bands["likely"]["accuracy"] == 0.5
    assert bands["guess"] == {"confidence": "guess", "attempts": 4, "correct": 2,
                              "accuracy": 0.5, "nominal_confidence": 0.3}
    assert cal["n"] == 10
    assert cal["overall_accuracy"] == round(6 / 10, 4)
    # sure-but-wrong = 1/4; guess-but-right = 2/4
    assert cal["sure_but_wrong_rate"] == 0.25
    assert cal["guess_but_right_rate"] == 0.5
    # mean nominal = (0.9*4 + 0.65*2 + 0.3*4)/10 = (3.6+1.3+1.2)/10 = 0.61
    assert cal["mean_nominal_confidence"] == 0.61
    assert cal["calibration_gap"] == round(0.61 - 0.6, 4)  # ~+0.01 -> calibrated
    assert cal["verdict"] == "calibrated"


def test_confidence_calibration_endpoint(client):
    j = client.get("/api/analytics/calibration").json()
    for key in ("bands", "n", "overall_accuracy", "verdict",
                "sure_but_wrong_rate", "guess_but_right_rate", "calibration_gap"):
        assert key in j
    assert isinstance(j["bands"], list) and len(j["bands"]) == 3
    # source filter is accepted
    assert client.get("/api/analytics/calibration?source=official").status_code == 200
    assert client.get("/api/analytics/calibration?days=30").status_code == 200


# --- 1.4 error-reason trends ------------------------------------------------
def _make_attempt_row(engine, qid: int) -> int:
    with Session(engine) as s:
        sess = s.exec(select(StudySession)).first()
        a = Attempt(question_id=qid, session_id=sess.id, mode=AttemptMode.timed,
                    chosen_answer="A", is_correct=False)
        s.add(a)
        s.commit()
        s.refresh(a)
        return a.id


def test_error_reason_trends_math(db_session: Session):
    from app.db import engine
    # Clean any pre-existing error log, then log a known reason mix across types.
    with Session(engine) as s:
        for e in s.exec(select(ErrorLogEntry)).all():
            s.delete(e)
        s.commit()

    # qid 1 = Weaken (LR), qid 9 = MainPoint (RC).
    plan = [
        (1, ErrorReason.misread), (1, ErrorReason.trap), (1, ErrorReason.trap),
        (9, ErrorReason.timing), (9, ErrorReason.misread), (9, ErrorReason.careless),
    ]
    base = datetime.now(timezone.utc) - timedelta(days=10)
    with Session(engine) as s:
        for i, (qid, reason) in enumerate(plan):
            a = Attempt(question_id=qid, session_id=s.exec(select(StudySession)).first().id,
                        mode=AttemptMode.timed, chosen_answer="A", is_correct=False)
            s.add(a)
            s.commit()
            s.refresh(a)
            s.add(ErrorLogEntry(attempt_id=a.id, reason=reason,
                                created_at=base + timedelta(hours=i)))
        s.commit()

    with Session(engine) as s:
        trends = analytics.error_reason_trends(s)

    assert trends["n"] == 6
    assert trends["overall"]["trap"] == 2
    assert trends["overall"]["misread"] == 2
    assert trends["overall"]["timing"] == 1
    assert trends["overall"]["careless"] == 1
    # by q_type
    assert trends["by_type"]["Weaken"] == {"misread": 1, "trap": 2}
    assert trends["by_type"]["MainPoint"] == {"timing": 1, "misread": 1, "careless": 1}
    # earlier (first 3: misread,trap,trap) vs recent (last 3: timing,misread,careless)
    assert trends["trend"]["trap"]["earlier"] == 2
    assert trends["trend"]["trap"]["recent"] == 0
    assert trends["trend"]["trap"]["direction"] == "down"
    assert trends["trend"]["timing"]["recent"] == 1
    assert trends["trend"]["timing"]["direction"] == "up"
    assert trends["top_reason"] in ("trap", "misread")  # both have count 2


def test_error_reason_trends_endpoint(client):
    # Log an error via the API so the endpoint has data.
    sid = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()["id"]
    aid = _attempt(client, sid, Q_OK, "A")
    client.post(f"/api/attempts/{aid}/error-log", json={"reason": "trap", "note": "x"})

    j = client.get("/api/analytics/error-reasons").json()
    for key in ("n", "overall", "by_type", "trend", "top_reason"):
        assert key in j
    assert j["overall"].get("trap", 0) >= 1
    assert client.get("/api/analytics/error-reasons?days=30").status_code == 200
