from __future__ import annotations


def test_doctor_report_without_ai_is_ready(db_session):
    from app import doctor

    report = doctor.build_report(include_ai=False)
    assert report["ok"] is True
    assert report["status"] in {"ok", "warning"}
    assert report["db"]["ready"] is True
    assert report["worker"]["ready"] is True
    assert report["ai"] is None
    assert report["integrity_report"]["ready"] is True


def test_doctor_marks_cli_worker_as_observed_not_required(db_session, monkeypatch):
    from app import config, doctor, jobs

    worker = jobs.get_worker()
    if worker._thread is not None:
        worker.stop()
    monkeypatch.setattr(config, "JOBS_WORKER_ENABLED", True)

    report = doctor.build_report(include_ai=False)
    assert report["ok"] is True
    assert report["status"] == "warning"
    assert report["worker"]["ready"] is False
    assert report["worker"]["required_for_readiness"] is False
    assert "worker_not_ready" not in report["errors"]
    assert "worker_not_observed" in report["warnings"]
