"""LSAT score prediction.

The modern LSAT has ~75-76 scored questions (two LR sections + one RC section, the
graded ones). The raw score (number correct) maps to a 120-180 scaled score via a
test-specific conversion table. We don't have a real owned PrepTest's table, so we
use a representative *published-style* conversion curve based on the typical shape
of recent LSAC conversion charts (e.g. PrepTests in the 70s-90s range):

  - A perfect raw maps to 180.
  - The curve is roughly linear in the middle and compresses at the extremes.

We express it as a piecewise-linear map over PERCENT CORRECT so it works for any
number of official questions the user actually has (the user rarely owns a full
clean 76-question test). The anchor points below are the percent-correct -> scaled
pairs of a representative recent curve:

    100% -> 180
     90% -> 170
     80% -> 164
     70% -> 158
     60% -> 152
     50% -> 145
     40% -> 138
     30% -> 131
     20% -> 125
     10% -> 120
      0% -> 120

Linear interpolation between anchors. This is an ESTIMATE and is documented as such
in the dashboard payload (`predicted_score` is only meaningful with enough official
attempts). Only `source == "official"` questions feed this.
"""
from __future__ import annotations

# (percent_correct, scaled_score) anchors, ascending by percent.
_CURVE: list[tuple[float, int]] = [
    (0.0, 120),
    (10.0, 120),
    (20.0, 125),
    (30.0, 131),
    (40.0, 138),
    (50.0, 145),
    (60.0, 152),
    (70.0, 158),
    (80.0, 164),
    (90.0, 170),
    (100.0, 180),
]


def percent_to_scaled(percent: float) -> int:
    """Interpolate a percent-correct (0-100) onto the 120-180 scale."""
    percent = max(0.0, min(100.0, percent))
    for (p0, s0), (p1, s1) in zip(_CURVE, _CURVE[1:]):
        if p0 <= percent <= p1:
            if p1 == p0:
                return s1
            frac = (percent - p0) / (p1 - p0)
            return round(s0 + frac * (s1 - s0))
    return 120


# Scale label values used in scoring responses (3.5, additive ``scale_source``).
SCALE_SOURCE_OFFICIAL = "official_table"
SCALE_SOURCE_GENERIC = "generic_curve"


def parse_scale_table(table: dict | None) -> list[tuple[int, int]] | None:
    """Validate + normalize a PrepTest scale table into ascending (raw, scaled)
    anchor pairs, or None if the table is absent/empty.

    Accepts either ``{"raw_to_scaled": {"45": 152, ...}}`` (the stored shape) or a
    bare ``{"45": 152, ...}`` map. Raises ValueError on a malformed table so the
    API can reject a bad payload (non-numeric keys/values, out-of-range scaled
    scores, or nothing usable)."""
    if not table:
        return None
    raw_map = table.get("raw_to_scaled", table) if isinstance(table, dict) else None
    if not isinstance(raw_map, dict) or not raw_map:
        raise ValueError("scale table must be a non-empty {raw: scaled} map")
    pairs: list[tuple[int, int]] = []
    for k, v in raw_map.items():
        try:
            raw = int(k)
            scaled = int(v)
        except (TypeError, ValueError):
            raise ValueError(f"scale table entry {k!r}: {v!r} is not integer raw:scaled")
        if raw < 0:
            raise ValueError(f"scale table raw {raw} is negative")
        if not (120 <= scaled <= 180):
            raise ValueError(f"scale table scaled score {scaled} is outside 120-180")
        pairs.append((raw, scaled))
    pairs.sort(key=lambda p: p[0])
    # An official LSAT curve is monotonically non-decreasing: more raw-correct
    # never yields a LOWER scaled score. Reject an inverted/non-monotonic table
    # (usually a typo) so it can't silently move predicted scores the wrong way.
    for (r0, s0), (r1, s1) in zip(pairs, pairs[1:]):
        if s1 < s0:
            raise ValueError(
                f"scale table is not monotonic: raw {r0}->{s0} then {r1}->{s1} "
                "(more raw-correct must not map to a lower scaled score)"
            )
    return pairs


def scaled_from_table(raw_correct: int, anchors: list[tuple[int, int]]) -> int:
    """Interpolate a raw-correct count within an official (raw -> scaled) table.

    Clamps below/above the table's range to its endpoints, linearly interpolates
    between bracketing anchors otherwise. Assumes ``anchors`` is ascending by raw
    (as returned by :func:`parse_scale_table`)."""
    if raw_correct <= anchors[0][0]:
        return anchors[0][1]
    if raw_correct >= anchors[-1][0]:
        return anchors[-1][1]
    for (r0, s0), (r1, s1) in zip(anchors, anchors[1:]):
        if r0 <= raw_correct <= r1:
            if r1 == r0:
                return s1
            frac = (raw_correct - r0) / (r1 - r0)
            return round(s0 + frac * (s1 - s0))
    return anchors[-1][1]


def predict_scaled(raw_correct: int, total: int,
                   scale_table: dict | None = None) -> int | None:
    """Map raw correct out of total to a scaled estimate. None if no data.

    3.5 — when ``scale_table`` is provided (the owning PrepTest's real published
    raw->scaled conversion), the raw count is interpolated within THAT table;
    otherwise we fall back to the generic representative percent-correct curve.
    A bad table silently falls back to the generic curve (use :func:`parse_scale_table`
    to validate before persisting)."""
    if total <= 0:
        return None
    if scale_table:
        try:
            anchors = parse_scale_table(scale_table)
        except ValueError:
            anchors = None
        if anchors:
            return scaled_from_table(raw_correct, anchors)
    return percent_to_scaled(100.0 * raw_correct / total)


# --- C1: Percentile mapping -------------------------------------------------
# Scaled-score -> percentile concordance table.  Values are representative of
# recent LSAC published concordance tables (typically released alongside each
# administration cycle).  The table covers 120-180 at every integer step; we
# store a sparse set of anchors and interpolate linearly between them (see
# ``scaled_to_percentile``).  Only use this for display/diagnostics — LSAC
# updates the concordance periodically and exact values shift slightly.
#
# Source shape: (scaled_score, percentile_rank) sorted ascending by score.
# Percentile values are approximations consistent with published LSAC data
# for the 2022-2024 administration period.
_PERCENTILE_TABLE: list[tuple[int, int]] = [
    (120, 0),
    (125, 2),
    (130, 8),
    (135, 15),
    (140, 26),
    (143, 34),
    (145, 41),
    (147, 47),
    (149, 53),
    (150, 56),
    (151, 59),
    (152, 62),
    (153, 65),
    (154, 68),
    (155, 71),
    (156, 73),
    (157, 76),
    (158, 78),
    (159, 80),
    (160, 82),
    (161, 84),
    (162, 86),
    (163, 87),
    (164, 89),
    (165, 90),
    (166, 92),
    (167, 93),
    (168, 94),
    (169, 95),
    (170, 96),
    (171, 97),
    (172, 97),
    (173, 98),
    (174, 98),
    (175, 99),
    (176, 99),
    (177, 99),
    (178, 99),
    (179, 99),
    (180, 99),
]


def scaled_to_percentile(scaled: int) -> int:
    """Map a scaled LSAT score (120-180) to an approximate percentile rank.

    Clamps to the table's range (120-180) and linearly interpolates between
    anchor points.  Returns an integer percentile (0-99).

    B24: single bisect-based pass replaces the previous two O(n) loops
    (one for exact hit, one for interpolation).
    """
    import bisect

    scaled = max(120, min(180, scaled))
    scores = [s for s, _ in _PERCENTILE_TABLE]
    idx = bisect.bisect_left(scores, scaled)
    # Exact hit (includes the clamped upper bound 180).
    if idx < len(_PERCENTILE_TABLE) and _PERCENTILE_TABLE[idx][0] == scaled:
        return _PERCENTILE_TABLE[idx][1]
    # Below all anchors (should never occur after clamping, but be safe).
    if idx == 0:
        return _PERCENTILE_TABLE[0][1]
    s0, p0 = _PERCENTILE_TABLE[idx - 1]
    s1, p1 = _PERCENTILE_TABLE[idx]
    if s1 == s0:
        return p1
    frac = (scaled - s0) / (s1 - s0)
    return round(p0 + frac * (p1 - p0))


def predict_scaled_with_source(
    raw_correct: int, total: int, scale_table: dict | None = None
) -> tuple[int | None, str]:
    """Like :func:`predict_scaled` but also returns which curve was used:
    ``"official_table"`` when a valid table was applied, else ``"generic_curve"``."""
    if total <= 0:
        return None, SCALE_SOURCE_GENERIC
    if scale_table:
        try:
            anchors = parse_scale_table(scale_table)
        except ValueError:
            anchors = None
        if anchors:
            return scaled_from_table(raw_correct, anchors), SCALE_SOURCE_OFFICIAL
    return percent_to_scaled(100.0 * raw_correct / total), SCALE_SOURCE_GENERIC
