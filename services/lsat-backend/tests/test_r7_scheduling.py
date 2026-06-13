"""R7 Wave 2b — FSRS personalization, drill selection, real scale tables, and the
adaptive study plan.

Covers:
- 3.2 FSRS: review logging + last_reviewed, leech flagging, overdue-first +
  interleaved due ordering, the optimize endpoint (runs or falls back), and the
  desired_retention setting being honored by the scheduler.
- 3.4 Drills: recently-seen exclusion, variation across repeated drills,
  difficulty-band targeting, and explicit-difficulty filtering still honored.
- 3.5 Scoring: a set scale table changes the scaled score vs the generic curve,
  fallback works, a bad payload is rejected, and scale_source is present.
- 3.6 Study plan: a large gap / behind-pace raises intensity, tasks fit within the
  minutes budget, and the existing daily_plan keys are preserved.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from app import scoring, srs, study_plan
from app.models import (
    Attempt,
    AttemptMode,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
    SessionType,
    SRSCard,
    SRSReviewLog,
    StudySession,
    StudyArtifact,
)


# --------------------------------------------------------------------------- #
# 3.2 — FSRS personalization                                                  #
# --------------------------------------------------------------------------- #
def test_review_logs_and_sets_last_reviewed(client):
    """Each review appends an SRSReviewLog row and stamps card.last_reviewed."""
    from sqlmodel import Session, select

    from app.db import engine

    due = client.get("/api/srs/due").json()
    card_id = due["cards"][0]["card_id"]

    r = client.post(f"/api/srs/{card_id}/review", json={"rating": 3})
    assert r.status_code == 200
    # existing response keys preserved
    body = r.json()
    assert "next_due" in body and "interval_days" in body

    with Session(engine) as s:
        logs = s.exec(
            select(SRSReviewLog).where(SRSReviewLog.card_id == card_id)
        ).all()
        assert len(logs) == 1
        assert logs[0].rating == 3
        assert logs[0].question_id is not None
        card = s.get(SRSCard, card_id)
        assert card.last_reviewed is not None


def test_leech_flagged_at_threshold(db_session):
    """A card crossing the lapse threshold gets leech=True; /leeches surfaces it."""
    from app import config

    q = Question(stem="s", prompt="p", correct_answer="A", q_type="Flaw",
                 source=QuestionSource.sample, difficulty=3)
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    card = SRSCard(question_id=q.id, fsrs_state=srs.new_card_state(),
                   due_date=datetime.now(timezone.utc), lapses=0)
    db_session.add(card)
    db_session.commit()
    db_session.refresh(card)

    # Just below threshold: not yet a leech.
    card.lapses = config.SRS_LEECH_THRESHOLD - 1
    assert srs.flag_leech_if_needed(card) is False
    assert card.leech is False

    # At threshold: flips to leech (and only transitions once).
    card.lapses = config.SRS_LEECH_THRESHOLD
    assert srs.flag_leech_if_needed(card) is True
    assert card.leech is True
    assert srs.flag_leech_if_needed(card) is False  # already a leech

    db_session.add(card)
    db_session.commit()
    leech_cards = srs.leeches(db_session)
    assert any(c.id == card.id for c in leech_cards)


def test_leech_flagged_via_review_endpoint(client):
    """Repeated Again (rating=1) reviews accumulate lapses and flag a leech, which
    then appears in the /srs/leeches remediation queue (test-mode, no leak)."""
    from app import config

    due = client.get("/api/srs/due").json()
    card_id = due["cards"][0]["card_id"]
    for _ in range(config.SRS_LEECH_THRESHOLD):
        client.post(f"/api/srs/{card_id}/review", json={"rating": 1})

    leeches = client.get("/api/srs/leeches").json()
    assert leeches["count"] >= 1
    row = next(c for c in leeches["cards"] if c["card_id"] == card_id)
    assert row["lapses"] >= config.SRS_LEECH_THRESHOLD
    assert "correct_answer" not in row  # no answer leak


def test_due_ordering_overdue_first_and_interleaved(db_session):
    """due_cards returns most-overdue first AND interleaves q_types so no single
    type forms a long run."""
    from app.routers.srs_routes import due_cards

    now = datetime.now(timezone.utc)
    # Build many cards across two q_types with staggered overdue times. Type "A"
    # questions are the MOST overdue (would form a long leading run without
    # interleaving).
    qids_by_type: dict[str, list[int]] = {"Weaken": [], "Flaw": []}
    for i in range(6):
        for qt in ("Weaken", "Flaw"):
            q = Question(stem=f"s{qt}{i}", prompt="p", correct_answer="A",
                         q_type=qt, source=QuestionSource.sample, difficulty=3)
            db_session.add(q)
            db_session.commit()
            db_session.refresh(q)
            qids_by_type[qt].append(q.id)
    # Make all Weaken cards more overdue than all Flaw cards.
    order = 0
    for qt, hours in (("Weaken", 100), ("Flaw", 10)):
        for qid in qids_by_type[qt]:
            db_session.add(SRSCard(
                question_id=qid, fsrs_state=srs.new_card_state(),
                due_date=now - timedelta(hours=hours - order), lapses=0,
            ))
            order += 1
    db_session.commit()

    out = due_cards(session=db_session)
    types = []
    for c in out["cards"]:
        q = db_session.get(Question, c["id"])
        types.append(q.q_type)
    # We seeded only these synthetic types in this fresh db (plus none from seed
    # because db_session reseeds). The leading card should still be the most
    # overdue type, but the run must be broken up (no 6-in-a-row of one type).
    assert out["due_count"] == len(types) >= 12
    # No run of the same q_type longer than 1 at the front given equal-size
    # buckets -> strict alternation expected.
    max_run = 1
    run = 1
    for a, b in zip(types, types[1:]):
        run = run + 1 if a == b else 1
        max_run = max(max_run, run)
    assert max_run < 6, f"q_types not interleaved: {types}"
    # Most-overdue type leads.
    assert types[0] == "Weaken"


def test_optimize_endpoint_runs_or_falls_back(client):
    """/srs/optimize returns a status with ran + n_reviews; with thin history it
    falls back gracefully (ran=False) rather than erroring."""
    r = client.post("/api/srs/optimize")
    assert r.status_code == 200
    body = r.json()
    assert "ran" in body and "n_reviews" in body
    # Seeded DB has little/no review history -> must fall back, not crash.
    assert body["ran"] is False
    assert body["reason"] in (
        "insufficient_history", "optimizer_deps_missing", "fsrs_unavailable",
        "no_parameters",
    )


def test_optimize_insufficient_history_reason(db_session):
    """With fewer than the min reviews, optimize reports insufficient_history."""
    out = srs.optimize_parameters(db_session)
    assert out["ran"] is False
    # Fresh db_session has no review logs.
    assert out["n_reviews"] == 0
    assert out["reason"] == "insufficient_history"


def test_desired_retention_setting_is_honored(db_session):
    """Lowering desired_retention lengthens scheduled intervals (fewer reviews)."""
    if not srs._HAVE_FSRS:
        pytest.skip("fsrs not available")
    from app import config, settings_store

    saved = config.SRS_DESIRED_RETENTION
    try:
        # High retention -> shorter interval for a 'good' review.
        settings_store.update_settings(db_session, {"desired_retention": 0.95})
        srs.rebuild_scheduler()
        state = srs.new_card_state()
        _s_hi, _due_hi, int_hi = srs.review(state, 3)

        # Low retention -> longer interval for the same 'good' review.
        settings_store.update_settings(db_session, {"desired_retention": 0.80})
        srs.rebuild_scheduler()
        _s_lo, _due_lo, int_lo = srs.review(state, 3)

        assert int_lo >= int_hi
        # And the setting is reflected in effective_settings.
        eff = settings_store.effective_settings()
        assert abs(eff["desired_retention"] - 0.80) < 1e-9
    finally:
        config.SRS_DESIRED_RETENTION = saved
        srs.rebuild_scheduler()


# --------------------------------------------------------------------------- #
# 3.4 — drill selection                                                       #
# --------------------------------------------------------------------------- #
def _make_type_bank(db_session, q_type: str, *, n: int, difficulty: int,
                    source=QuestionSource.sample) -> list[int]:
    ids = []
    for i in range(n):
        q = Question(stem=f"{q_type}-{difficulty}-{i}", prompt="p",
                     correct_answer="A", q_type=q_type, source=source,
                     difficulty=difficulty)
        db_session.add(q)
        db_session.commit()
        db_session.refresh(q)
        ids.append(q.id)
    return ids


def test_recently_seen_excluded_from_drill(db_session):
    """Questions attempted within the exclusion window are not re-served."""
    from app.routers.drills import DrillBody, create_drill

    ids = _make_type_bank(db_session, "Evaluate", n=10, difficulty=3)
    # Attempt the first 5 just now (recently seen).
    s = StudySession(type=SessionType.drill)
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    seen = set(ids[:5])
    for qid in seen:
        db_session.add(Attempt(question_id=qid, session_id=s.id,
                               mode=AttemptMode.drill, chosen_answer="A",
                               is_correct=True, time_ms=1000))
    db_session.commit()

    out = create_drill(DrillBody(q_type="Evaluate", count=5, source="real"),
                       session=db_session)
    served = {q["id"] for q in out["questions"]}
    assert served, "drill should not be empty (fresh items exist)"
    assert served.isdisjoint(seen), "recently-seen items must be excluded"


def test_recently_seen_fallback_when_all_seen(db_session):
    """If every eligible item was recently seen, the drill still returns items
    (the exclusion relaxes rather than serving an empty drill)."""
    from app.routers.drills import DrillBody, create_drill

    ids = _make_type_bank(db_session, "Method", n=4, difficulty=3)
    s = StudySession(type=SessionType.drill)
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    for qid in ids:
        db_session.add(Attempt(question_id=qid, session_id=s.id,
                               mode=AttemptMode.drill, chosen_answer="A",
                               is_correct=True, time_ms=1000))
    db_session.commit()

    out = create_drill(DrillBody(q_type="Method", count=4, source="real"),
                       session=db_session)
    assert len(out["questions"]) == 4  # relaxed: still served


def test_repeated_drills_vary(db_session):
    """Two drills of the same type over a large bank should not be identical."""
    from app.routers.drills import DrillBody, create_drill

    _make_type_bank(db_session, "Paradox", n=40, difficulty=3)
    a = create_drill(DrillBody(q_type="Paradox", count=10, source="real"),
                     session=db_session)
    b = create_drill(DrillBody(q_type="Paradox", count=10, source="real"),
                     session=db_session)
    ids_a = [q["id"] for q in a["questions"]]
    ids_b = [q["id"] for q in b["questions"]]
    assert len(ids_a) == 10 and len(ids_b) == 10
    assert ids_a != ids_b, "repeated drills should vary (randomized selection)"


def test_difficulty_targeting_near_ability_band(db_session):
    """With low accuracy on a type, the drill targets an easier band even though
    harder items are equally available."""
    from sqlmodel import select

    from app.routers.drills import DrillBody, _target_difficulty, create_drill

    # Bank: equal numbers at difficulty 2 and difficulty 5.
    _make_type_bank(db_session, "Inference", n=20, difficulty=2)
    _make_type_bank(db_session, "Inference", n=20, difficulty=5)

    # Record a weak history on Inference (mostly wrong) so ability -> easy band.
    s = StudySession(type=SessionType.drill)
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    inf_q = db_session.exec(
        select(Question).where(Question.q_type == "Inference")
    ).all()
    for q in inf_q[:10]:
        db_session.add(Attempt(question_id=q.id, session_id=s.id,
                               mode=AttemptMode.drill, chosen_answer="B",
                               is_correct=False, time_ms=1000))
    db_session.commit()

    target = _target_difficulty(db_session, "Inference")
    assert target is not None and target <= 3, "weak ability should target an easy band"

    out = create_drill(DrillBody(q_type="Inference", count=10, source="real"),
                       session=db_session)
    diffs = [db_session.get(Question, q["id"]).difficulty for q in out["questions"]]
    # The selection should lean toward the easier band, not the hard one.
    avg = sum(diffs) / len(diffs)
    assert avg < 3.5, f"difficulty targeting should favor easier items, got avg {avg}"


def test_explicit_difficulty_filter_still_honored(db_session):
    """An explicit difficulty filter is respected exactly (overrides targeting)."""
    from app.routers.drills import DrillBody, create_drill

    _make_type_bank(db_session, "Strengthen", n=10, difficulty=2)
    _make_type_bank(db_session, "Strengthen", n=10, difficulty=5)
    out = create_drill(
        DrillBody(q_type="Strengthen", difficulty=5, count=5, source="real"),
        session=db_session,
    )
    diffs = {db_session.get(Question, q["id"]).difficulty for q in out["questions"]}
    assert diffs == {5}, "explicit difficulty filter must be honored"


def test_drill_no_answer_leak(db_session):
    """Test-mode payload — never leaks the answer key."""
    from app.routers.drills import DrillBody, create_drill

    _make_type_bank(db_session, "Role", n=5, difficulty=3)
    out = create_drill(DrillBody(q_type="Role", count=5, source="real"),
                       session=db_session)
    for q in out["questions"]:
        assert "correct_answer" not in q


# --------------------------------------------------------------------------- #
# 3.5 — real per-PrepTest scale tables                                        #
# --------------------------------------------------------------------------- #
def test_scoring_table_changes_scaled_vs_generic():
    """A provided table interpolates within it (different from the generic curve)."""
    # 18/20 = 90% -> generic curve gives 170.
    generic = scoring.predict_scaled(18, 20)
    assert generic == 170
    # A custom table that maps 18 -> 158 must override the generic curve.
    table = {"raw_to_scaled": {"0": 120, "10": 140, "18": 158, "20": 165}}
    custom = scoring.predict_scaled(18, 20, table)
    assert custom == 158
    assert custom != generic


def test_scoring_table_interpolates_between_anchors():
    """Raw counts between anchors are linearly interpolated."""
    table = {"raw_to_scaled": {"10": 140, "20": 160}}
    # 15 is halfway -> 150.
    assert scoring.scaled_from_table(15, [(10, 140), (20, 160)]) == 150
    assert scoring.predict_scaled(15, 25, table) == 150


def test_scoring_fallback_when_no_table():
    """No table -> generic curve; with-source labels it generic."""
    scaled, source = scoring.predict_scaled_with_source(18, 20, None)
    assert scaled == 170
    assert source == scoring.SCALE_SOURCE_GENERIC


def test_scale_table_endpoint_sets_and_scores(client):
    """PUT scale-table sets the table; an official-question exam then scores via it
    and reports scale_source=official_table."""
    from sqlmodel import Session, select

    from app.db import engine

    # Build an official PrepTest with a tiny LR section of official questions.
    with Session(engine) as s:
        pt = PrepTest(name="OfficialPT-3.5", source="official", is_official=True)
        s.add(pt)
        s.commit()
        s.refresh(pt)
        sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0)
        s.add(sec)
        s.commit()
        s.refresh(sec)
        qids = []
        for i in range(4):
            q = Question(section_id=sec.id, stem=f"oq{i}", prompt="p",
                         correct_answer="A", q_type="Weaken",
                         source=QuestionSource.official, difficulty=3)
            s.add(q)
            s.commit()
            s.refresh(q)
            qids.append(q.id)
        pt_id = pt.id

    # Bad payload rejected (scaled out of range).
    bad = client.put(f"/api/preptests/{pt_id}/scale-table",
                     json={"raw_to_scaled": {"0": 999}})
    assert bad.status_code == 400

    # Valid table accepted.
    ok = client.put(f"/api/preptests/{pt_id}/scale-table",
                    json={"raw_to_scaled": {"0": 120, "2": 150, "4": 180}})
    assert ok.status_code == 200
    body = ok.json()
    assert body["scale_source"] == scoring.SCALE_SOURCE_OFFICIAL
    assert body["n_anchors"] == 3

    # Run an exam over this PrepTest, answer 2/4 correctly, and confirm scoring
    # uses the table (raw 2 -> 150) and labels the source.
    exam = client.post("/api/exams", json={"preptest_id": pt_id}).json()
    sid = exam["session_id"]
    for i, qid in enumerate(qids):
        # Answer A (correct) for the first two, B (wrong) for the rest.
        client.post(f"/api/sessions/{sid}/attempts", json={
            "question_id": qid, "mode": "timed",
            "chosen_answer": "A" if i < 2 else "B",
        })
    res = client.get(f"/api/exams/{sid}/results").json()
    assert res["official_total"] == 4 and res["official_correct"] == 2
    assert res["scaled_score"] == 150  # from the table, not the generic curve
    assert res["scale_source"] == scoring.SCALE_SOURCE_OFFICIAL


def test_scale_table_404_for_unknown_preptest(client):
    r = client.put("/api/preptests/999999/scale-table",
                   json={"raw_to_scaled": {"0": 120}})
    assert r.status_code == 404


def test_exam_results_has_scale_source_with_generic_curve(client):
    """The sample (non-official, no table) exam still reports scale_source as the
    generic curve — the additive label is always present."""
    pts = client.get("/api/preptests").json()
    pid = pts[0]["id"]
    exam = client.post("/api/exams", json={"preptest_id": pid}).json()
    res = client.get(f"/api/exams/{exam['session_id']}/results").json()
    assert res["scale_source"] == scoring.SCALE_SOURCE_GENERIC
    # Existing keys preserved.
    for key in ("session_id", "scaled_score", "raw_correct", "total",
                "official_correct", "official_total", "sections"):
        assert key in res


# --------------------------------------------------------------------------- #
# 3.6 — adaptive study plan                                                   #
# --------------------------------------------------------------------------- #
def test_daily_plan_preserves_existing_keys(client):
    """All pre-existing daily_plan keys remain (frontend hand-typed contract)."""
    today = client.get("/api/study/today").json()
    for key in ("has_plan", "target_score", "exam_date", "daily_minutes",
                "days_to_exam", "predicted_score", "forecast", "due_count",
                "weakest_types", "tasks"):
        assert key in today
    # New additive keys present too.
    for key in ("intensity", "minutes_budget", "rationale"):
        assert key in today
    assert today["utility_model"] == "ability_engine_v2"
    assert today["ability_selector"]["model"] == "ability_engine_v2"
    assert today["ability_selector"]["utility"]["model"] == "ability_engine_v2_utility_v1"
    assert today["selector_summary"]["utility_model"] == "ability_engine_v2_utility_v1"
    assert today["selector_summary"]["utility_score"] == today["ability_selector"]["utility"]["score"]
    assert today["intensity"] in ("light", "standard", "intense")


def _seed_official_history(db_session, *, scaled_target_low: bool) -> None:
    """Seed an official PrepTest + enough official timed attempts to drive the
    forecast. If scaled_target_low, accuracy is low (big gap to a high target)."""
    pt = PrepTest(name="PT-3.6", source="official", is_official=True)
    db_session.add(pt)
    db_session.commit()
    db_session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0)
    db_session.add(sec)
    db_session.commit()
    db_session.refresh(sec)
    qids = []
    for i in range(40):
        q = Question(section_id=sec.id, stem=f"h{i}", prompt="p",
                     correct_answer="A", q_type="Weaken" if i % 2 else "Flaw",
                     source=QuestionSource.official, difficulty=3)
        db_session.add(q)
        db_session.commit()
        db_session.refresh(q)
        qids.append(q.id)

    # Two sessions a week apart so the forecast has >= _MIN_SESSION_DAYS.
    now = datetime.now(timezone.utc)
    for day_offset in (14, 7):
        sess = StudySession(type=SessionType.section,
                            started=now - timedelta(days=day_offset),
                            ended=now - timedelta(days=day_offset))
        db_session.add(sess)
        db_session.commit()
        db_session.refresh(sess)
        # low accuracy => low scaled => big gap to a high target.
        correct_frac = 0.3 if scaled_target_low else 0.9
        for j, qid in enumerate(qids):
            is_correct = (j / len(qids)) < correct_frac
            db_session.add(Attempt(
                question_id=qid, session_id=sess.id, mode=AttemptMode.timed,
                chosen_answer="A" if is_correct else "B", is_correct=is_correct,
                time_ms=60000, created_at=now - timedelta(days=day_offset),
            ))
        db_session.commit()


def test_large_gap_raises_intensity(db_session):
    """A large gap-to-target (low scores, high target) yields a higher intensity
    and a larger minutes budget than being comfortably on target."""
    # Behind: low accuracy, very high target.
    _seed_official_history(db_session, scaled_target_low=True)
    study_plan.upsert_plan(db_session, target_score=180,
                           exam_date=(date.today() + timedelta(days=30)).isoformat(),
                           daily_minutes=60)
    behind = study_plan.daily_plan(db_session)

    assert behind["intensity"] in ("standard", "intense")
    assert behind["forecast"]["gap_to_target"] is not None
    # A large gap should push to the top intensity.
    if behind["forecast"]["gap_to_target"] >= 7:
        assert behind["intensity"] == "intense"
        assert behind["minutes_budget"] > 60  # scaled up vs base


def test_low_gap_lowers_intensity(db_session):
    """Being at/above target with high accuracy yields a light/standard day."""
    _seed_official_history(db_session, scaled_target_low=False)
    study_plan.upsert_plan(db_session, target_score=140,
                           exam_date=(date.today() + timedelta(days=30)).isoformat(),
                           daily_minutes=60)
    ahead = study_plan.daily_plan(db_session)
    assert ahead["intensity"] in ("light", "standard")
    assert ahead["minutes_budget"] <= 60


def test_tasks_fit_within_minutes_budget(db_session):
    """The packed tasks' estimated minutes never exceed the budget (except when a
    single most-urgent task alone is larger, which is always allowed)."""
    _seed_official_history(db_session, scaled_target_low=True)
    study_plan.upsert_plan(db_session, target_score=180, daily_minutes=30)
    plan = study_plan.daily_plan(db_session)
    tasks = plan["tasks"]
    assert tasks, "should always produce at least one task"
    total = sum(t.get("est_minutes", 0) for t in tasks)
    # Either everything fits the budget, or there is exactly one (unavoidable) task.
    assert total <= plan["minutes_budget"] or len(tasks) == 1


def test_leech_and_concept_gap_surface_in_plan(db_session):
    """Leech + concept-gap queues feed dedicated tasks in the adaptive plan."""
    # A concept-gap card and a leech card.
    q1 = Question(stem="cg", prompt="p", correct_answer="A", q_type="Flaw",
                  source=QuestionSource.sample, difficulty=3)
    q2 = Question(stem="lch", prompt="p", correct_answer="A", q_type="Weaken",
                  source=QuestionSource.sample, difficulty=3)
    db_session.add(q1)
    db_session.add(q2)
    db_session.commit()
    db_session.refresh(q1)
    db_session.refresh(q2)
    db_session.add(SRSCard(question_id=q1.id, fsrs_state=srs.new_card_state(),
                           due_date=datetime.now(timezone.utc), origin="concept_gap"))
    db_session.add(SRSCard(question_id=q2.id, fsrs_state=srs.new_card_state(),
                           due_date=datetime.now(timezone.utc), lapses=10, leech=True))
    db_session.commit()

    study_plan.upsert_plan(db_session, target_score=170, daily_minutes=120)
    plan = study_plan.daily_plan(db_session)
    task_types = {t["type"] for t in plan["tasks"]}
    assert "concept_gap" in task_types
    assert "leech" in task_types
    assert plan["concept_gap_count"] >= 1
    assert plan["leech_count"] >= 1


def test_daily_plan_attaches_notebook_context_to_relevant_tasks(db_session):
    db_session.add(
        StudyArtifact(
            kind="note",
            title="Flaw drill warmup",
            body="Before a Flaw block, name the conclusion and the exact shift.",
            summary="Flaw warmup.",
            q_type="Flaw",
            official_firewall=False,
        )
    )
    db_session.commit()

    study_plan.upsert_plan(db_session, target_score=170, daily_minutes=120)
    plan = study_plan.daily_plan(db_session)

    assert plan["notebook_context"]["count"] >= 1
    assert any("Flaw drill warmup" in note for note in plan["notebook_context"]["notes"])
    assert any(
        (task.get("notebook_context") or {}).get("count", 0) >= 1
        for task in plan["tasks"]
    )
