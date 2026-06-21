"""BACK-4 — the JobWorker loop fires due ScheduledTask rows on cadence.

Before this, ``run_due_scheduled_tasks`` had no worker-loop caller, so the seeded
maintenance schedules (backups/calibration/revalidation/…) never ran. These tests
drive ``_run_scheduler_tick`` directly with a fake monotonic clock so they assert
the throttle deterministically (no real waiting), then check the full ``_loop``
actually wires the tick in, and that a failing scheduled task can't kill the loop.
"""
from __future__ import annotations

from app import jobs
from app.db import engine


class _FakeClock:
    """Monotonic-clock stand-in so the throttle is exercised without real waits."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def _make_worker(**kw) -> jobs.JobWorker:
    # poll_interval is irrelevant here (we call the tick directly), keep it small.
    kw.setdefault("poll_interval", 0.01)
    return jobs.JobWorker(engine, runner=lambda _jid: None, **kw)


def test_scheduler_tick_runs_when_due(monkeypatch, db_session):
    """First tick fires immediately (no prior run) and calls run_due_scheduled_tasks."""
    calls: list[int] = []

    def fake_run_due(session, *, limit: int = 10) -> dict:
        calls.append(limit)
        return {"ran": 0, "results": []}

    monkeypatch.setattr(jobs, "run_due_scheduled_tasks", fake_run_due)

    worker = _make_worker(scheduler_tick_interval=3600.0)
    worker._run_scheduler_tick()

    assert len(calls) == 1


def test_scheduler_tick_respects_throttle(monkeypatch, db_session):
    """A second tick before the interval elapses is a no-op; once it elapses, fires."""
    clock = _FakeClock()
    monkeypatch.setattr(jobs.time, "monotonic", clock)

    calls: list[float] = []
    monkeypatch.setattr(
        jobs, "run_due_scheduled_tasks",
        lambda session, *, limit=10: calls.append(clock.t) or {"ran": 0, "results": []},
    )

    worker = _make_worker(scheduler_tick_interval=3600.0)

    # First tick fires (last-run starts at 0.0 -> always due).
    worker._run_scheduler_tick()
    assert len(calls) == 1

    # Well within the interval -> throttled, no new call.
    clock.advance(1800.0)
    worker._run_scheduler_tick()
    assert len(calls) == 1

    # Interval elapsed -> fires again.
    clock.advance(1800.0)
    worker._run_scheduler_tick()
    assert len(calls) == 2


def test_scheduler_tick_disabled_when_interval_non_positive(monkeypatch, db_session):
    """A non-positive interval disables the tick entirely (never calls through)."""
    calls: list[int] = []
    monkeypatch.setattr(
        jobs, "run_due_scheduled_tasks",
        lambda session, *, limit=10: calls.append(limit) or {"ran": 0, "results": []},
    )

    worker = _make_worker(scheduler_tick_interval=0.0)
    worker._run_scheduler_tick()
    worker._run_scheduler_tick()

    assert calls == []


def test_scheduler_tick_swallows_task_failure(monkeypatch, db_session):
    """A failing scheduled run must not propagate out of the tick (loop stays alive)."""
    def boom(session, *, limit: int = 10) -> dict:
        raise RuntimeError("scheduled task exploded")

    monkeypatch.setattr(jobs, "run_due_scheduled_tasks", boom)

    worker = _make_worker(scheduler_tick_interval=3600.0)
    # Must not raise.
    worker._run_scheduler_tick()


def test_loop_invokes_scheduler_tick(monkeypatch, db_session):
    """End-to-end: the worker's _loop drives the scheduler tick on an idle pass."""
    calls: list[int] = []

    def fake_run_due(session, *, limit: int = 10) -> dict:
        calls.append(limit)
        return {"ran": 1, "results": [{"ok": True}]}

    monkeypatch.setattr(jobs, "run_due_scheduled_tasks", fake_run_due)

    # No queued jobs -> drain_once() returns False each pass -> idle path runs the
    # scheduler tick. A tiny interval (clamped value irrelevant: we pass it in
    # directly, bypassing the env floor) makes the first idle pass fire it.
    worker = jobs.JobWorker(
        engine, runner=lambda _jid: None, poll_interval=0.02,
        scheduler_tick_interval=0.01,
    )
    worker.start()
    try:
        import time as _time
        deadline = _time.time() + 5
        while _time.time() < deadline and not calls:
            _time.sleep(0.02)
    finally:
        worker.stop()

    assert calls, "the worker loop should have invoked run_due_scheduled_tasks"


def test_env_interval_default_and_clamp(monkeypatch):
    """The inline env reader: default, disable, 60s floor, and bad-value fallback."""
    monkeypatch.delenv("LSATLAB_SCHEDULER_TICK_SECONDS", raising=False)
    assert jobs._scheduler_tick_interval_from_env() == jobs.DEFAULT_SCHEDULER_TICK_SECONDS

    monkeypatch.setenv("LSATLAB_SCHEDULER_TICK_SECONDS", "0")
    assert jobs._scheduler_tick_interval_from_env() == 0.0

    monkeypatch.setenv("LSATLAB_SCHEDULER_TICK_SECONDS", "5")  # below the floor
    assert jobs._scheduler_tick_interval_from_env() == 60.0

    monkeypatch.setenv("LSATLAB_SCHEDULER_TICK_SECONDS", "7200")
    assert jobs._scheduler_tick_interval_from_env() == 7200.0

    monkeypatch.setenv("LSATLAB_SCHEDULER_TICK_SECONDS", "not-a-number")
    assert jobs._scheduler_tick_interval_from_env() == jobs.DEFAULT_SCHEDULER_TICK_SECONDS
