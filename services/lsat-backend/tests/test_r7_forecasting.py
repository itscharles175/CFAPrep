"""R7 Wave 2a: honest forecasting + deeper analytics.

Covers analytics.forecast (3.1), analytics.mastery (3.3), analytics.pacing (3.7),
and analytics.fatigue (3.8). Sessions/attempts are constructed with known data so
the new statistical behavior is pinned, and the existing response keys the
frontend hand-types against are asserted to still be present.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import analytics
from app.models import (
    Attempt,
    AttemptMode,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
    SessionType,
    StudySession,
)


# --- builders ---------------------------------------------------------------
def _mk_session(db, *, type_=SessionType.section, scaled=None, when=None):
    s = StudySession(type=type_, scaled_score=scaled)
    if when is not None:
        s.started = when
        s.ended = when
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _mk_question(db, *, q_type="Flaw", source=QuestionSource.official, difficulty=3,
                 section_id=None, passage_id=None, correct="A"):
    q = Question(stem="s", prompt="p", correct_answer=correct, difficulty=difficulty,
                 q_type=q_type, source=source, section_id=section_id,
                 passage_id=passage_id)
    db.add(q)
    db.commit()
    db.refresh(q)
    return q


def _mk_attempt(db, *, q, s, correct=True, time_ms=60000, when=None,
                mode=AttemptMode.timed, br_correct=None):
    a = Attempt(
        question_id=q.id, session_id=s.id, mode=mode,
        chosen_answer=(q.correct_answer if correct else "Z"),
        is_correct=correct, time_ms=time_ms, br_correct=br_correct,
    )
    if when is not None:
        a.created_at = when
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _build_official_session(db, *, when, n_correct, n_total, scaled, time_ms=60000):
    """A finished official-timed session with n_total official attempts on a given
    day, carrying an explicit scaled_score so the forecast point is deterministic.
    The number of official questions is the WLS information weight."""
    s = _mk_session(db, scaled=scaled, when=when)
    for i in range(n_total):
        q = _mk_question(db, source=QuestionSource.official)
        _mk_attempt(db, q=q, s=s, correct=(i < n_correct), time_ms=time_ms, when=when)
    return s


# === 3.1 forecast ===========================================================
FORECAST_KEYS = (
    "current_score", "projected_score", "slope_per_week", "confidence",
    "target_score", "gap_to_target", "on_track", "days_to_exam", "n_points",
)


def test_forecast_existing_keys_preserved(client):
    """Every key the frontend's Forecast type reads must still be present, with the
    documented types, plus the new additive honesty keys."""
    body = client.get("/api/analytics/forecast?target_score=170").json()
    for key in FORECAST_KEYS:
        assert key in body, key
    assert body["target_score"] == 170
    assert isinstance(body["n_points"], int)
    assert isinstance(body["slope_per_week"], (int, float))
    # confidence is either None or {"low","high"} — never a different shape.
    if body["confidence"] is not None:
        assert set(body["confidence"]) == {"low", "high"}
    # new additive keys
    for key in ("low_confidence", "method", "n_official_questions", "n_session_days"):
        assert key in body


def test_forecast_sparse_data_low_confidence_range(db_session):
    """Below the data floor we must NOT emit a false-precise point: low_confidence
    is True and confidence is a real (non-collapsed) RANGE around the latest est."""
    base = datetime.now(timezone.utc) - timedelta(days=10)
    # Two days, only ~10 official questions total => below the floor (3 days / 25 q).
    _build_official_session(db_session, when=base, n_correct=4, n_total=5, scaled=150)
    _build_official_session(db_session, when=base + timedelta(days=2),
                            n_correct=4, n_total=5, scaled=156)

    out = analytics.forecast(db_session)
    assert out["low_confidence"] is True
    assert out["method"] in ("latest_estimate_range", "insufficient_data")
    assert out["confidence"] is not None
    # Range must be non-trivial (does not collapse to ~0) and ordered.
    assert out["confidence"]["high"] > out["confidence"]["low"]
    assert out["confidence"]["high"] - out["confidence"]["low"] >= 4
    # Still reports a current/projected estimate and all existing keys.
    for key in FORECAST_KEYS:
        assert key in out


def test_forecast_enough_data_is_confident(db_session):
    """Past the floor (>=3 distinct days AND >=25 official q) we fit WLS and are
    not low_confidence."""
    base = datetime.now(timezone.utc) - timedelta(days=40)
    for k, day in enumerate([0, 10, 20, 30]):
        _build_official_session(db_session, when=base + timedelta(days=day),
                                n_correct=7 + k, n_total=15, scaled=150 + 3 * k)
    out = analytics.forecast(db_session)
    assert out["low_confidence"] is False
    assert out["method"] == "weighted_least_squares"
    assert out["n_session_days"] >= 3
    assert out["n_official_questions"] >= 25
    assert out["confidence"]["high"] > out["confidence"]["low"]


def test_forecast_weighting_changes_slope(db_session):
    """Same point positions, different weights -> different fitted slope."""
    base = datetime.now(timezone.utc) - timedelta(days=40)
    # Light version: day-30 high point backed by few questions.
    _build_official_session(db_session, when=base, n_correct=5, n_total=30, scaled=150)
    _build_official_session(db_session, when=base + timedelta(days=15),
                            n_correct=6, n_total=12, scaled=151)
    light = _build_official_session(db_session, when=base + timedelta(days=30),
                                    n_correct=3, n_total=4, scaled=170)
    slope_light = analytics.forecast(db_session)["slope_per_week"]

    # Now heavily up-weight the high day-30 point by adding many more official
    # correct/total attempts to that SAME session on the SAME day.
    when_hi = base + timedelta(days=30)
    for i in range(40):
        q = _mk_question(db_session, source=QuestionSource.official)
        _mk_attempt(db_session, q=q, s=light, correct=(i < 34), time_ms=60000,
                    when=when_hi)
    slope_heavy = analytics.forecast(db_session)["slope_per_week"]

    # Heavier weight on the high endpoint should not REDUCE the upward slope; in
    # practice it increases it. Assert the fit moved (weighting matters).
    assert slope_heavy != slope_light
    assert slope_heavy >= slope_light


def test_forecast_slope_is_bounded(db_session):
    """A few wildly-improving early sessions must NOT project an absurd slope: the
    fitted weekly slope is clamped to a realistic ceiling (<= ~7 scaled pts/week)."""
    base = datetime.now(timezone.utc) - timedelta(days=12)
    # 120 -> 180 over 12 days = 5 pts/day = 35 pts/week raw; must be clamped.
    for k, day in enumerate([0, 4, 8, 12]):
        _build_official_session(db_session, when=base + timedelta(days=day),
                                n_correct=k * 3, n_total=12, scaled=120 + 20 * k)
    out = analytics.forecast(db_session)
    assert abs(out["slope_per_week"]) <= 7.0 + 1e-9
    # And the projected score never escapes the scale.
    assert 120 <= out["projected_score"] <= 180


def test_forecast_band_widens_with_horizon(db_session):
    """A proper prediction interval grows with distance from the data. Projecting
    to a far exam date must yield a wider band than a near one.

    The trend is kept flat and mid-scale on purpose so the far projection stays
    well inside [120, 180]: clamping the *displayed* band to the score scale (you
    cannot score 185) would otherwise truncate the upper edge at a boundary and
    mask the widening — a real interaction, exercised away from the ceiling here.
    """
    base = datetime.now(timezone.utc) - timedelta(days=40)
    # Flat (slope ~0) and centered near 150, with TINY scatter so the residual SE
    # is non-zero (the horizon term scales with it) yet the point stays mid-scale
    # at a 120-day horizon — far from the 180 ceiling.
    for day, scaled in [(0, 150), (10, 151), (20, 149), (30, 150)]:
        _build_official_session(db_session, when=base + timedelta(days=day),
                                n_correct=8, n_total=15, scaled=scaled)
    today = datetime.now(timezone.utc).date()
    near = (today + timedelta(days=3)).isoformat()
    far = (today + timedelta(days=120)).isoformat()

    out_near = analytics.forecast(db_session, exam_date=near)
    out_far = analytics.forecast(db_session, exam_date=far)
    # Sanity: neither projection is pinned to a scale boundary (else the clamp,
    # not the horizon, would drive the widths).
    assert 120 < out_near["projected_score"] < 180
    assert 120 < out_far["projected_score"] < 180
    width_near = out_near["confidence"]["high"] - out_near["confidence"]["low"]
    width_far = out_far["confidence"]["high"] - out_far["confidence"]["low"]
    assert width_far > width_near


def test_forecast_band_includes_measurement_error(db_session):
    """Even a perfectly linear fit can't yield a zero-width band: the LSAT SEM is
    folded in, so the band is at least a couple scaled points wide."""
    base = datetime.now(timezone.utc) - timedelta(days=40)
    # Perfectly collinear points (zero residual) but enough data to be confident.
    for k, day in enumerate([0, 10, 20, 30]):
        _build_official_session(db_session, when=base + timedelta(days=day),
                                n_correct=8, n_total=15, scaled=150 + 2 * k)
    out = analytics.forecast(db_session)
    assert out["confidence"]["high"] - out["confidence"]["low"] >= 4


# === 3.3 mastery ============================================================
MASTERY_KEYS = (
    "q_type", "section_type", "attempts", "mastery", "weighted_accuracy",
    "recent_accuracy", "avg_difficulty", "trend",
)


def test_mastery_existing_keys_preserved_plus_new(db_session):
    s = _mk_session(db_session)
    q = _mk_question(db_session, q_type="Flaw", source=QuestionSource.research)
    for _ in range(6):
        _mk_attempt(db_session, q=q, s=s, correct=True)
    rows = analytics.mastery(db_session)
    assert rows
    r = next(x for x in rows if x["q_type"] == "Flaw")
    for key in MASTERY_KEYS:
        assert key in r, key
    # new uncertainty keys
    for key in ("lower_bound", "ci", "n", "posterior_mean", "prior_mean"):
        assert key in r
    assert isinstance(r["ci"], list) and len(r["ci"]) == 2
    assert r["ci"][0] <= r["mastery"] <= r["ci"][1]


def test_mastery_difficulty_does_not_inflate_above_accuracy(db_session):
    """Old estimator multiplied accuracy by a difficulty factor and could exceed
    observed accuracy. Now mastery is a posterior mean: with a large sample it sits
    AT the observed accuracy (not above it), regardless of difficulty=5."""
    s = _mk_session(db_session)
    # 100 attempts, all correct, hardest difficulty.
    for _ in range(100):
        q = _mk_question(db_session, q_type="Method", difficulty=5,
                         source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=True)
    r = next(x for x in analytics.mastery(db_session) if x["q_type"] == "Method")
    # observed accuracy is 1.0; mastery (posterior mean) must not exceed it.
    assert r["mastery"] <= 1.0 + 1e-9
    # with a big all-correct sample it's pulled close to 1.0, not above.
    assert r["mastery"] >= 0.95


def test_mastery_small_sample_shrinks_toward_prior(db_session):
    """A 2-attempt 100%-correct type should be pulled toward the 0.5 prior, so it
    does NOT post a near-1.0 mastery a 200-attempt type would."""
    s = _mk_session(db_session)
    q_small = _mk_question(db_session, q_type="Paradox", source=QuestionSource.research)
    _mk_attempt(db_session, q=q_small, s=s, correct=True)
    q_small2 = _mk_question(db_session, q_type="Paradox", source=QuestionSource.research)
    _mk_attempt(db_session, q=q_small2, s=s, correct=True)

    # A large, also-perfect type for contrast.
    for _ in range(60):
        qb = _mk_question(db_session, q_type="Inference", source=QuestionSource.research)
        _mk_attempt(db_session, q=qb, s=s, correct=True)

    rows = {x["q_type"]: x for x in analytics.mastery(db_session)}
    small = rows["Paradox"]
    big = rows["Inference"]
    # Both 100% raw, but the small sample is shrunk well below the big one.
    assert small["mastery"] < big["mastery"]
    # 2 correct under a strength-4 prior centered at .5 => (2+2)/(4+2)=0.667-ish.
    assert small["mastery"] < 0.8
    # lower bound for the tiny sample is much weaker (wider CI).
    assert small["lower_bound"] < big["lower_bound"]


def test_mastery_ranked_by_lower_bound(db_session):
    """Weakest-first ordering is by the credible-interval lower bound."""
    s = _mk_session(db_session)
    # Type A: large sample, moderate accuracy -> tight CI.
    for i in range(40):
        q = _mk_question(db_session, q_type="Strengthen", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=(i % 2 == 0))  # 50%
    # Type B: small sample, high accuracy -> wide CI, lower bound could be low.
    for i in range(3):
        q = _mk_question(db_session, q_type="Weaken", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=True)  # 100% but n=3
    rows = analytics.mastery(db_session)
    lowers = [r["lower_bound"] for r in rows]
    assert lowers == sorted(lowers)


def test_mastery_time_based_decay(db_session):
    """Decay is time-based: an old correct streak followed by a recent wrong streak
    weights the recent (wrong) attempts more, pulling weighted_accuracy below raw."""
    s = _mk_session(db_session)
    old = datetime.now(timezone.utc) - timedelta(days=120)
    recent = datetime.now(timezone.utc) - timedelta(days=1)
    # 5 correct long ago, 5 wrong recently. Raw acc = 0.5; time-decay favors recent
    # (wrong) so weighted_accuracy should be < 0.5.
    for _ in range(5):
        q = _mk_question(db_session, q_type="Role", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=True, when=old)
    for _ in range(5):
        q = _mk_question(db_session, q_type="Role", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=False, when=recent)
    r = next(x for x in analytics.mastery(db_session) if x["q_type"] == "Role")
    assert r["weighted_accuracy"] < 0.5


# === 3.7 pacing =============================================================
def test_pacing_shape_and_endpoint(client):
    body = client.get("/api/analytics/pacing").json()
    for key in ("n", "clock_bleeders", "thirds", "by_q_type_time", "triage"):
        assert key in body
    assert isinstance(body["clock_bleeders"], list)
    assert len(body["thirds"]) == 3
    assert [t["third"] for t in body["thirds"]] == ["first", "second", "last"]
    for t in body["thirds"]:
        assert "accuracy" in t and "median_time_ms" in t and "attempts" in t
    for key in ("mean_time_correct_ms", "mean_time_wrong_ms",
                "wrong_to_correct_time_ratio", "score"):
        assert key in body["triage"]


def test_pacing_detects_clock_bleeders(db_session):
    s = _mk_session(db_session)
    # Build a q_type with a tight benchmark: many fast attempts ~30s.
    for _ in range(8):
        q = _mk_question(db_session, q_type="Detail", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=30000)
    # One wrong + very slow attempt (180s >> 1.5x 30s benchmark) -> a clock-bleeder.
    qb = _mk_question(db_session, q_type="Detail", source=QuestionSource.research)
    bleeder = _mk_attempt(db_session, q=qb, s=s, correct=False, time_ms=180000)

    out = analytics.pacing(db_session)
    ids = {b["question_id"] for b in out["clock_bleeders"]}
    assert qb.id in ids
    b = next(x for x in out["clock_bleeders"] if x["question_id"] == qb.id)
    assert b["q_type"] == "Detail"
    assert b["time_ms"] == 180000
    assert b["benchmark_ms"] > 0


def test_pacing_triage_score_low_when_time_wasted_on_wrong(db_session):
    """Spending much more time on wrong answers than right ones tanks the triage
    score (you over-invest in questions you end up missing)."""
    s = _mk_session(db_session)
    for _ in range(5):
        q = _mk_question(db_session, q_type="Inference", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=30000)
    for _ in range(5):
        q = _mk_question(db_session, q_type="Inference", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=False, time_ms=150000)
    out = analytics.pacing(db_session)
    assert out["triage"]["wrong_to_correct_time_ratio"] > 1.0
    assert out["triage"]["score"] < 100.0


def test_pacing_within_section_thirds(db_session):
    """Thirds capture pace/accuracy decay within a section. Build a session where
    the last third is slower and less accurate than the first."""
    s = _mk_session(db_session)
    # 9 attempts: first third fast+right, last third slow+wrong.
    seq = [
        (True, 25000), (True, 26000), (True, 24000),   # first
        (True, 40000), (False, 50000), (True, 45000),  # second
        (False, 90000), (False, 95000), (False, 88000),  # last
    ]
    for correct, t in seq:
        q = _mk_question(db_session, q_type="Function", source=QuestionSource.research)
        _mk_attempt(db_session, q=q, s=s, correct=correct, time_ms=t)
    out = analytics.pacing(db_session)
    first = out["thirds"][0]
    last = out["thirds"][2]
    assert first["accuracy"] > last["accuracy"]
    assert last["median_time_ms"] > first["median_time_ms"]


# === 3.8 fatigue ============================================================
def _build_full_exam(db, *, n_sections=4, per_section=5, when=None,
                     accuracy_by_pos=None, time_by_pos=None):
    """A full-exam sitting: one PrepTest with n_sections sections (positions
    1..n by Section.order), all attempts under one full_exam StudySession."""
    pt = PrepTest(name="T", source="official", is_official=True)
    db.add(pt)
    db.commit()
    db.refresh(pt)
    sess = _mk_session(db, type_=SessionType.full_exam, when=when)
    for pos in range(n_sections):
        sec = Section(preptest_id=pt.id,
                      type=(SectionType.LR if pos < 2 else SectionType.RC),
                      order=pos)
        db.add(sec)
        db.commit()
        db.refresh(sec)
        acc = (accuracy_by_pos or {}).get(pos, 1.0)
        tms = (time_by_pos or {}).get(pos, 60000)
        n_correct = round(per_section * acc)
        for i in range(per_section):
            q = _mk_question(db, source=QuestionSource.official, section_id=sec.id)
            _mk_attempt(db, q=q, s=sess, correct=(i < n_correct), time_ms=tms,
                        when=when)
    return sess


def test_fatigue_endpoint_empty_without_full_exams(client):
    # seed has only a 'section' session, no full_exam -> empty endurance curve.
    body = client.get("/api/analytics/fatigue").json()
    assert body["n_sittings"] == 0
    assert body["positions"] == []


def test_fatigue_endurance_curve(db_session):
    """Accuracy decays and time grows across section positions in a sitting."""
    _build_full_exam(
        db_session, n_sections=4, per_section=10,
        accuracy_by_pos={0: 0.9, 1: 0.8, 2: 0.6, 3: 0.4},
        time_by_pos={0: 40000, 1: 50000, 2: 70000, 3: 95000},
    )
    out = analytics.fatigue(db_session)
    assert out["n_sittings"] == 1
    positions = out["positions"]
    assert [p["position"] for p in positions] == [1, 2, 3, 4]
    accs = [p["accuracy"] for p in positions]
    times = [p["median_time_ms"] for p in positions]
    # monotonic stamina decay we constructed
    assert accs == sorted(accs, reverse=True)
    assert times == sorted(times)
    # section types surfaced per position
    assert positions[0]["section_types"] == ["LR"]
    assert positions[3]["section_types"] == ["RC"]
    for p in positions:
        assert p["n_sittings"] == 1
        assert p["attempts"] == 10


def test_fatigue_aggregates_across_sittings(db_session):
    """Two sittings of the same shape -> per-position n_sittings == 2 and pooled
    attempts == sum."""
    for _ in range(2):
        _build_full_exam(db_session, n_sections=3, per_section=4)
    out = analytics.fatigue(db_session)
    assert out["n_sittings"] == 2
    assert len(out["positions"]) == 3
    for p in out["positions"]:
        assert p["n_sittings"] == 2
        assert p["attempts"] == 8
