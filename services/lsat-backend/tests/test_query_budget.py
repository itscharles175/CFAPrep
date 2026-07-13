"""BC3 — query-budget CI gate.

These tests pin the number of SQL round-trips the two heaviest read endpoints
issue, so a future change that re-introduces an O(n) per-entity query loop
(one SELECT per preptest / per section / per attempt) fails CI instead of
silently regressing latency.

The strongest guard is :func:`test_preptests_query_count_is_flat_with_bank_size`:
it adds many more preptests + sections and asserts the ``/preptests`` query
count does NOT grow — the defining property of a batched (non-N+1) query path.

Budgets are deliberately generous relative to the fixed cost (a handful of
set-based queries) but far below what a per-entity loop would produce, so they
catch real regressions without being brittle to incidental query churn.
"""
from __future__ import annotations

# A single batched ``/preptests`` build is ~4 data queries (preptests, sections,
# questions, attempted-question-ids) plus a little session/transaction overhead.
# A per-preptest N+1 loop would add ~3 queries PER preptest, so this cap stays
# well clear of the fixed cost while failing fast on a reintroduced loop.
_PREPTESTS_BUDGET = 15
# /analytics/dashboard fans out across several analytics (by_type, score trend,
# coach context, streak, ...), each of which loads attempts/questions in a fixed
# number of set-based queries. Higher than /preptests, still bounded.
_ANALYTICS_DASHBOARD_BUDGET = 60


def test_preptests_under_budget(client, count_queries):
    with count_queries() as counter:
        resp = client.get("/api/preptests")
    assert resp.status_code == 200
    assert counter.count <= _PREPTESTS_BUDGET, (
        f"/preptests issued {counter.count} queries (budget {_PREPTESTS_BUDGET}); "
        f"statements:\n" + "\n".join(counter.statements)
    )


def test_preptest_progress_under_budget(client, count_queries):
    pid = client.get("/api/preptests").json()[0]["id"]
    with count_queries() as counter:
        resp = client.get(f"/api/preptests/{pid}/progress")
    assert resp.status_code == 200
    # sections + their questions + the attempts scan == a small fixed count.
    assert counter.count <= _PREPTESTS_BUDGET, (
        f"/preptests/{pid}/progress issued {counter.count} queries "
        f"(budget {_PREPTESTS_BUDGET}); statements:\n"
        + "\n".join(counter.statements)
    )


def test_analytics_dashboard_under_budget(client, count_queries):
    with count_queries() as counter:
        resp = client.get("/api/analytics/dashboard")
    assert resp.status_code == 200
    assert counter.count <= _ANALYTICS_DASHBOARD_BUDGET, (
        f"/analytics/dashboard issued {counter.count} queries "
        f"(budget {_ANALYTICS_DASHBOARD_BUDGET}); statements:\n"
        + "\n".join(counter.statements)
    )


def test_preptests_query_count_is_flat_with_bank_size(client, count_queries):
    """The N+1 regression guard: adding more preptests/sections must NOT increase
    the ``/preptests`` query count. A per-entity loop would scale linearly."""
    from sqlmodel import Session

    from app.db import engine
    from app.models import PrepTest, Section, SectionType

    # Baseline against the seeded bank.
    with count_queries() as base:
        assert client.get("/api/preptests").status_code == 200
    baseline = base.count

    # Add a pile of extra preptests, each with two sections.
    with Session(engine) as s:
        for i in range(12):
            pt = PrepTest(name=f"Budget PT {i}", source="sample", is_official=False)
            s.add(pt)
            s.commit()
            s.refresh(pt)
            s.add(Section(preptest_id=pt.id, type=SectionType.LR, order=0))
            s.add(Section(preptest_id=pt.id, type=SectionType.RC, order=1))
            s.commit()

    resp = client.get("/api/preptests").json()
    assert len(resp) >= 13  # seed + 12 added

    with count_queries() as grown:
        assert client.get("/api/preptests").status_code == 200

    # Query count must stay flat (allow a tiny constant slack, never linear growth).
    assert grown.count <= baseline + 2, (
        f"/preptests query count grew from {baseline} to {grown.count} after adding "
        f"12 preptests — looks like an N+1 loop reappeared. statements:\n"
        + "\n".join(grown.statements)
    )
