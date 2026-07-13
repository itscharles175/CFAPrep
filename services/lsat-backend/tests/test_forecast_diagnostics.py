"""Wave-1 analytics diagnostics (C1-C4).

Tests for:
  C1 — projected_percentile + percentile_band in forecast()
  C2 — required_slope_per_week / required_vs_actual_ratio / trajectory_feasible
  C3 — efficiency_band field in by_type() rows
  C4 — lucky_rate_by_type in blind_review_gap()

Test data is constructed with known values so every assertion is deterministic.
Follows the patterns established in test_r7_forecasting.py and test_analytics.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import analytics
from app import scoring
from app.models import (
    Attempt,
    AttemptMode,
    Question,
    QuestionSource,
    StudySession,
)


# ---------------------------------------------------------------------------
# Shared builder helpers (same style as test_r7_forecasting.py)
# ---------------------------------------------------------------------------

def _mk_session(db, *, scaled=None, when=None):
    s = StudySession(type="section", scaled_score=scaled)
    if when is not None:
        s.started = when
        s.ended = when
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _mk_question(db, *, q_type="Flaw", source=QuestionSource.official, difficulty=3,
                 passage_id=None, correct="A"):
    q = Question(
        stem="s", prompt="p", correct_answer=correct, difficulty=difficulty,
        q_type=q_type, source=source, passage_id=passage_id,
    )
    db.add(q)
    db.commit()
    db.refresh(q)
    return q


def _mk_attempt(db, *, q, s, correct=True, time_ms=60_000, when=None,
                mode=AttemptMode.timed, br_correct=None, br_answer=None):
    chosen = q.correct_answer if correct else "Z"
    a = Attempt(
        question_id=q.id, session_id=s.id, mode=mode,
        chosen_answer=chosen, is_correct=correct, time_ms=time_ms,
        br_correct=br_correct, br_answer=br_answer,
    )
    if when is not None:
        a.created_at = when
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _build_official_session(db, *, when, n_correct, n_total, scaled, time_ms=60_000):
    """Finished official-timed session: n_total attempts, explicit scaled_score."""
    s = _mk_session(db, scaled=scaled, when=when)
    for i in range(n_total):
        q = _mk_question(db, source=QuestionSource.official)
        _mk_attempt(db, q=q, s=s, correct=(i < n_correct), time_ms=time_ms, when=when)
    return s


def _enough_data(db, base=None):
    """Build >= _MIN_SESSION_DAYS days and >= _MIN_OFFICIAL_Q questions so the
    WLS branch of forecast() runs (not the low-confidence fallback)."""
    if base is None:
        base = datetime.now(timezone.utc) - timedelta(days=40)
    for k, day in enumerate([0, 10, 20, 30]):
        _build_official_session(
            db,
            when=base + timedelta(days=day),
            n_correct=7 + k,
            n_total=15,
            scaled=150 + 3 * k,
        )


# ===========================================================================
# C1 — Percentile mapping (scoring.scaled_to_percentile + forecast fields)
# ===========================================================================

class TestScaledToPercentile:
    """Pure-function tests for scoring.scaled_to_percentile — no DB needed."""

    def test_exact_anchor_120(self):
        assert scoring.scaled_to_percentile(120) == 0

    def test_exact_anchor_180(self):
        assert scoring.scaled_to_percentile(180) == 99

    def test_exact_anchor_165(self):
        assert scoring.scaled_to_percentile(165) == 90

    def test_clamp_below_120(self):
        """Scores below 120 clamp to 120's percentile (0)."""
        assert scoring.scaled_to_percentile(100) == 0
        assert scoring.scaled_to_percentile(0) == 0

    def test_clamp_above_180(self):
        """Scores above 180 clamp to 180's percentile (99)."""
        assert scoring.scaled_to_percentile(200) == 99
        assert scoring.scaled_to_percentile(999) == 99

    def test_monotonically_non_decreasing(self):
        """Higher scaled scores must never yield a lower percentile."""
        prev = scoring.scaled_to_percentile(120)
        for s in range(121, 181):
            cur = scoring.scaled_to_percentile(s)
            assert cur >= prev, f"Non-monotonic at {s}: {prev} -> {cur}"
            prev = cur

    def test_interpolation_between_anchors(self):
        """A score exactly between two anchors yields an interpolated value."""
        # Between 120 (pct=0) and 125 (pct=2): midpoint 122 or 123 should be ~1
        mid = scoring.scaled_to_percentile(122)
        assert 0 <= mid <= 2

    def test_all_values_in_range(self):
        for s in range(120, 181):
            p = scoring.scaled_to_percentile(s)
            assert 0 <= p <= 99, f"score {s} -> percentile {p} out of range"


class TestForecastPercentileFields:
    """C1: forecast() must include projected_percentile and percentile_band."""

    def test_keys_present_empty_db(self, db_session):
        """Fields are present (as None) even with zero data."""
        out = analytics.forecast(db_session)
        assert "projected_percentile" in out
        assert "percentile_band" in out
        assert out["projected_percentile"] is None
        assert out["percentile_band"] is None

    def test_percentile_populated_sparse_data(self, db_session):
        """With at least one data point (low-confidence branch), percentile is set."""
        base = datetime.now(timezone.utc) - timedelta(days=5)
        _build_official_session(db_session, when=base, n_correct=8, n_total=10, scaled=155)
        out = analytics.forecast(db_session)
        assert out["projected_percentile"] is not None
        assert isinstance(out["projected_percentile"], int)
        assert 0 <= out["projected_percentile"] <= 99

    def test_percentile_populated_wls_branch(self, db_session):
        """With enough data (WLS branch), both percentile fields are populated."""
        _enough_data(db_session)
        out = analytics.forecast(db_session)
        assert out["low_confidence"] is False
        assert out["projected_percentile"] is not None
        assert out["percentile_band"] is not None
        assert "low" in out["percentile_band"]
        assert "high" in out["percentile_band"]

    def test_percentile_band_ordered(self, db_session):
        """percentile_band.low <= projected_percentile <= percentile_band.high."""
        _enough_data(db_session)
        out = analytics.forecast(db_session)
        pb = out["percentile_band"]
        pp = out["projected_percentile"]
        assert pb["low"] <= pp <= pb["high"]

    def test_percentile_band_ordered_low_confidence(self, db_session):
        """Low-confidence band percentile ordering still holds."""
        base = datetime.now(timezone.utc) - timedelta(days=5)
        _build_official_session(db_session, when=base, n_correct=8, n_total=10, scaled=160)
        out = analytics.forecast(db_session)
        assert out["low_confidence"] is True
        pb = out["percentile_band"]
        pp = out["projected_percentile"]
        assert pb["low"] <= pp <= pb["high"]

    def test_percentile_consistent_with_projected_score(self, db_session):
        """projected_percentile matches what scoring.scaled_to_percentile returns
        for the projected_score."""
        _enough_data(db_session)
        out = analytics.forecast(db_session)
        expected = scoring.scaled_to_percentile(out["projected_score"])
        assert out["projected_percentile"] == expected

    def test_high_score_high_percentile(self, db_session):
        """A projected score near 175 should map to a high percentile (>=99)."""
        base = datetime.now(timezone.utc) - timedelta(days=40)
        for k, day in enumerate([0, 10, 20, 30]):
            _build_official_session(
                db_session,
                when=base + timedelta(days=day),
                n_correct=15,
                n_total=15,
                scaled=175 + min(k, 4),
            )
        out = analytics.forecast(db_session)
        assert out["projected_percentile"] >= 98


# ===========================================================================
# C2 — Required-slope inversion
# ===========================================================================

class TestRequiredSlope:
    """C2: required_slope_per_week, required_vs_actual_ratio, trajectory_feasible."""

    def test_keys_always_present(self, db_session):
        """C2 keys exist even with zero data (all None)."""
        out = analytics.forecast(db_session)
        for key in ("required_slope_per_week", "required_vs_actual_ratio",
                    "trajectory_feasible"):
            assert key in out

    def test_no_target_no_values(self, db_session):
        """Without target_score, C2 fields stay None."""
        _enough_data(db_session)
        out = analytics.forecast(db_session)  # no target_score passed
        assert out["required_slope_per_week"] is None
        assert out["required_vs_actual_ratio"] is None
        assert out["trajectory_feasible"] is None

    def test_no_exam_date_no_values(self, db_session):
        """Without exam_date, days_to_exam is None -> C2 fields stay None."""
        _enough_data(db_session)
        out = analytics.forecast(db_session, target_score=165)
        assert out["required_slope_per_week"] is None

    def test_exam_date_in_past_no_values(self, db_session):
        """Exam date in the past (days_to_exam <= 0) -> C2 fields stay None."""
        _enough_data(db_session)
        past = (datetime.now(timezone.utc).date() - timedelta(days=10)).isoformat()
        out = analytics.forecast(db_session, target_score=165, exam_date=past)
        assert out["required_slope_per_week"] is None
        assert out["trajectory_feasible"] is None

    def test_required_slope_arithmetic(self, db_session):
        """required_slope_per_week == (target - current) / weeks_remaining."""
        base = datetime.now(timezone.utc) - timedelta(days=40)
        # Pin current score to 150 by building 4 sessions all scoring 150.
        for k, day in enumerate([0, 10, 20, 30]):
            _build_official_session(
                db_session,
                when=base + timedelta(days=day),
                n_correct=8,
                n_total=15,
                scaled=150,
            )
        # 70 days in the future, target 164.
        future = (datetime.now(timezone.utc).date() + timedelta(days=70)).isoformat()
        out = analytics.forecast(db_session, target_score=164, exam_date=future)
        # current is 150, target 164, 70 days = 10 weeks -> 14/10 = 1.4 pts/wk
        assert out["current_score"] == 150
        req = out["required_slope_per_week"]
        assert req is not None
        assert abs(req - 1.4) < 0.1, f"Expected ~1.4, got {req}"

    def test_feasible_when_needed_slope_low(self, db_session):
        """trajectory_feasible=True when needed slope <= 7 pts/week."""
        base = datetime.now(timezone.utc) - timedelta(days=40)
        for k, day in enumerate([0, 10, 20, 30]):
            _build_official_session(
                db_session,
                when=base + timedelta(days=day),
                n_correct=8,
                n_total=15,
                scaled=150,
            )
        # current=150, target=155, 70 days=10 weeks -> 0.5 pts/wk -> feasible
        future = (datetime.now(timezone.utc).date() + timedelta(days=70)).isoformat()
        out = analytics.forecast(db_session, target_score=155, exam_date=future)
        assert out["trajectory_feasible"] is True

    def test_infeasible_when_needed_slope_high(self, db_session):
        """trajectory_feasible=False when needed slope > 7 pts/week."""
        base = datetime.now(timezone.utc) - timedelta(days=40)
        for k, day in enumerate([0, 10, 20, 30]):
            _build_official_session(
                db_session,
                when=base + timedelta(days=day),
                n_correct=8,
                n_total=15,
                scaled=150,
            )
        # current=150, target=180, 7 days=1 week -> 30 pts/wk -> infeasible
        future = (datetime.now(timezone.utc).date() + timedelta(days=7)).isoformat()
        out = analytics.forecast(db_session, target_score=180, exam_date=future)
        assert out["trajectory_feasible"] is False

    def test_ratio_none_when_actual_slope_zero(self, db_session):
        """required_vs_actual_ratio stays None when actual slope is zero (flat trend)."""
        base = datetime.now(timezone.utc) - timedelta(days=40)
        # Flat-score trend -> WLS slope will be 0.
        for k, day in enumerate([0, 10, 20, 30]):
            _build_official_session(
                db_session,
                when=base + timedelta(days=day),
                n_correct=8,
                n_total=15,
                scaled=150,
            )
        future = (datetime.now(timezone.utc).date() + timedelta(days=70)).isoformat()
        out = analytics.forecast(db_session, target_score=165, exam_date=future)
        # slope_per_week may be very close to 0 or exactly 0 on a flat trend.
        if out["slope_per_week"] == 0.0:
            assert out["required_vs_actual_ratio"] is None

    def test_c2_present_in_low_confidence_branch(self, db_session):
        """C2 fields are populated even in the low-confidence (insufficient data) branch."""
        base = datetime.now(timezone.utc) - timedelta(days=3)
        _build_official_session(db_session, when=base, n_correct=4, n_total=5, scaled=150)
        future = (datetime.now(timezone.utc).date() + timedelta(days=70)).isoformat()
        out = analytics.forecast(db_session, target_score=165, exam_date=future)
        assert out["low_confidence"] is True
        # required_slope_per_week should be set (current is 150)
        assert out["required_slope_per_week"] is not None
        assert out["trajectory_feasible"] is not None


# ===========================================================================
# C3 — Efficiency quadrant in by_type()
# ===========================================================================

class TestEfficiencyBand:
    """C3: efficiency_band field present in every by_type() row."""

    VALID_BANDS = {"mastered", "costly_right", "cheap_wrong", "struggling"}

    def test_efficiency_band_present_in_all_rows(self, db_session):
        """Every by_type() row must carry an efficiency_band string."""
        s = _mk_session(db_session)
        for q_type in ("Flaw", "Weaken", "Inference"):
            for i in range(5):
                q = _mk_question(db_session, q_type=q_type, source=QuestionSource.research)
                _mk_attempt(db_session, q=q, s=s, correct=(i % 2 == 0), time_ms=60_000)
        rows = analytics.by_type(db_session)
        assert rows, "Expected at least one by_type row"
        for row in rows:
            assert "efficiency_band" in row, f"Missing efficiency_band in {row['q_type']}"
            assert row["efficiency_band"] in self.VALID_BANDS, (
                f"Invalid band {row['efficiency_band']!r} for {row['q_type']}"
            )

    def test_mastered_high_acc_fast(self, db_session):
        """High accuracy + fast time -> 'mastered'."""
        s = _mk_session(db_session)
        # 10 correct LR answers in 30 s each (well under 90 s benchmark)
        for _ in range(10):
            q = _mk_question(db_session, q_type="Strengthen", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=30_000)
        rows = {r["q_type"]: r for r in analytics.by_type(db_session)}
        row = rows["Strengthen"]
        assert row["accuracy"] >= 0.65
        assert row["avg_time_ms"] <= 90_000
        assert row["efficiency_band"] == "mastered"

    def test_costly_right_high_acc_slow(self, db_session):
        """High accuracy but very slow -> 'costly_right'."""
        s = _mk_session(db_session)
        # All correct but very slow (180 s >> 90 s LR benchmark)
        for _ in range(10):
            q = _mk_question(db_session, q_type="Assumption", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=180_000)
        rows = {r["q_type"]: r for r in analytics.by_type(db_session)}
        row = rows["Assumption"]
        assert row["accuracy"] >= 0.65
        assert row["avg_time_ms"] > 90_000
        assert row["efficiency_band"] == "costly_right"

    def test_cheap_wrong_low_acc_fast(self, db_session):
        """Low accuracy + fast time -> 'cheap_wrong'."""
        s = _mk_session(db_session)
        # Mostly wrong, but quick (40 s each)
        for i in range(10):
            q = _mk_question(db_session, q_type="Parallel", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=(i == 0), time_ms=40_000)
        rows = {r["q_type"]: r for r in analytics.by_type(db_session)}
        row = rows["Parallel"]
        assert row["accuracy"] < 0.65
        assert row["avg_time_ms"] <= 90_000
        assert row["efficiency_band"] == "cheap_wrong"

    def test_struggling_low_acc_slow(self, db_session):
        """Low accuracy + slow time -> 'struggling'."""
        s = _mk_session(db_session)
        # Mostly wrong AND slow (150 s each)
        for i in range(10):
            q = _mk_question(db_session, q_type="Resolve", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=(i == 0), time_ms=150_000)
        rows = {r["q_type"]: r for r in analytics.by_type(db_session)}
        row = rows["Resolve"]
        assert row["accuracy"] < 0.65
        assert row["avg_time_ms"] > 90_000
        assert row["efficiency_band"] == "struggling"

    def test_rc_uses_rc_benchmark(self, db_session):
        """RC questions use the RC time benchmark (120 s), not the LR one (90 s)."""
        s = _mk_session(db_session)
        # All correct at 100 s — above LR benchmark (90s) but below RC (120s).
        # Should be "mastered" for RC, not "costly_right".
        for _ in range(10):
            q = _mk_question(db_session, q_type="Detail", source=QuestionSource.research,
                             passage_id=99999)  # non-null passage_id -> RC
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=100_000)
        rows = {(r["q_type"], r["section_type"]): r
                for r in analytics.by_type(db_session)}
        row = rows.get(("Detail", "RC"))
        assert row is not None, "Expected an RC row for 'Detail'"
        # 100 s <= 120 s RC benchmark + accuracy >= 0.65 -> mastered
        assert row["efficiency_band"] == "mastered"

    def test_efficiency_band_in_official_source_filter(self, db_session):
        """efficiency_band is present when source='official' is requested."""
        s = _mk_session(db_session)
        for i in range(5):
            q = _mk_question(db_session, q_type="Flaw", source=QuestionSource.official)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000)
        rows = analytics.by_type(db_session, source="official")
        assert rows
        for row in rows:
            assert "efficiency_band" in row


# ===========================================================================
# C4 — Lucky-rate surveillance in blind_review_gap()
# ===========================================================================

class TestLuckyRate:
    """C4: lucky_rate_by_type in blind_review_gap()."""

    def test_lucky_rate_key_always_present(self, db_session):
        """lucky_rate_by_type is always a dict in the output, even with no BR data."""
        out = analytics.blind_review_gap(db_session)
        assert "lucky_rate_by_type" in out
        assert isinstance(out["lucky_rate_by_type"], dict)

    def test_empty_when_no_br_attempts(self, db_session):
        """No BR attempts -> lucky_rate_by_type is an empty dict."""
        s = _mk_session(db_session)
        for _ in range(5):
            q = _mk_question(db_session, q_type="Flaw", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000)
        out = analytics.blind_review_gap(db_session)
        assert out["lucky_rate_by_type"] == {}

    def test_excluded_below_min_sample(self, db_session):
        """Types with fewer than 3 BR attempts are excluded."""
        s = _mk_session(db_session)
        # Only 2 BR attempts for "Weaken" -> should not appear in lucky_rate_by_type
        for i in range(2):
            q = _mk_question(db_session, q_type="Weaken", source=QuestionSource.research)
            # timed=correct, BR=wrong -> lucky
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000,
                        br_correct=False, br_answer="Z")
        out = analytics.blind_review_gap(db_session)
        assert "Weaken" not in out["lucky_rate_by_type"]

    def test_included_at_min_sample(self, db_session):
        """Types with exactly 3 BR attempts are included."""
        s = _mk_session(db_session)
        for i in range(3):
            q = _mk_question(db_session, q_type="Flaw", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000,
                        br_correct=False, br_answer="Z")
        out = analytics.blind_review_gap(db_session)
        assert "Flaw" in out["lucky_rate_by_type"]

    def test_lucky_rate_arithmetic(self, db_session):
        """lucky_rate = lucky_count / with_br_count for the type."""
        from sqlmodel import delete
        # blind_review_gap is a GLOBAL aggregate over all BR attempts; the sample
        # seed contributes one Inference BR attempt, so clear attempts first to
        # make the arithmetic deterministic.
        db_session.execute(delete(Attempt))
        db_session.commit()
        s = _mk_session(db_session)
        # 6 BR attempts: 2 lucky (timed-right/BR-wrong), 4 others.
        for i in range(6):
            q = _mk_question(db_session, q_type="Inference", source=QuestionSource.research)
            lucky = i < 2
            _mk_attempt(
                db_session, q=q, s=s,
                correct=True if lucky else False,
                time_ms=60_000,
                br_correct=False if lucky else True,
                br_answer="Z",
            )
        out = analytics.blind_review_gap(db_session)
        rate = out["lucky_rate_by_type"].get("Inference")
        assert rate is not None
        # 2 lucky out of 6 with_br = 0.3333
        assert abs(rate - round(2 / 6, 4)) < 1e-4

    def test_zero_lucky_rate_when_no_lucky_answers(self, db_session):
        """When a type has BR data but no lucky answers, rate is 0.0."""
        s = _mk_session(db_session)
        # 4 BR attempts, all timed-wrong/BR-right (timing_problem, not lucky)
        for _ in range(4):
            q = _mk_question(db_session, q_type="Strengthen", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=False, time_ms=60_000,
                        br_correct=True, br_answer="A")
        out = analytics.blind_review_gap(db_session)
        rate = out["lucky_rate_by_type"].get("Strengthen")
        assert rate is not None
        assert rate == 0.0

    def test_multiple_types_independent(self, db_session):
        """Each type has its own lucky_rate computed independently."""
        s = _mk_session(db_session)
        # Type A: all lucky (timed-right/BR-wrong)
        for _ in range(4):
            q = _mk_question(db_session, q_type="Weaken", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000,
                        br_correct=False, br_answer="Z")
        # Type B: no lucky (timed-wrong/BR-right)
        for _ in range(4):
            q = _mk_question(db_session, q_type="Method", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=False, time_ms=60_000,
                        br_correct=True, br_answer="A")
        out = analytics.blind_review_gap(db_session)
        rates = out["lucky_rate_by_type"]
        assert "Weaken" in rates
        assert "Method" in rates
        assert rates["Weaken"] == 1.0
        assert rates["Method"] == 0.0

    def test_type_with_no_br_data_absent(self, db_session):
        """A type with no BR answers at all is not in lucky_rate_by_type."""
        s = _mk_session(db_session)
        # Type with no BR
        for _ in range(5):
            q = _mk_question(db_session, q_type="Assumption", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000)
        # Type with enough BR
        for _ in range(4):
            q = _mk_question(db_session, q_type="Flaw", source=QuestionSource.research)
            _mk_attempt(db_session, q=q, s=s, correct=True, time_ms=60_000,
                        br_correct=False, br_answer="Z")
        out = analytics.blind_review_gap(db_session)
        assert "Assumption" not in out["lucky_rate_by_type"]
        assert "Flaw" in out["lucky_rate_by_type"]

    def test_rate_values_bounded(self, db_session):
        """Lucky rates are between 0.0 and 1.0."""
        s = _mk_session(db_session)
        for i in range(5):
            q = _mk_question(db_session, q_type="Resolve", source=QuestionSource.research)
            lucky = i < 3
            _mk_attempt(db_session, q=q, s=s,
                        correct=True if lucky else False,
                        time_ms=60_000,
                        br_correct=False if lucky else True,
                        br_answer="Z" if lucky else "A")
        out = analytics.blind_review_gap(db_session)
        for q_type, rate in out["lucky_rate_by_type"].items():
            assert 0.0 <= rate <= 1.0, f"Rate {rate} out of bounds for {q_type}"
