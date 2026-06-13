"""Logging/observability: idempotent setup, request id, llm timing span."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone


def test_setup_logging_is_idempotent():
    from app import observability

    observability._CONFIGURED = False
    root = logging.getLogger()
    before = list(root.handlers)
    observability.setup_logging()
    after_first = len(root.handlers)
    observability.setup_logging()  # second call must not add handlers
    after_second = len(root.handlers)

    assert after_first >= 1
    assert after_first == after_second
    # restore
    root.handlers = before


def test_request_id_var_default_and_set():
    from app import observability

    assert observability.request_id_var.get() == "-"
    token = observability.request_id_var.set("abc123")
    try:
        assert observability.request_id_var.get() == "abc123"
    finally:
        observability.request_id_var.reset(token)


def test_time_llm_call_yields_span_and_logs(caplog):
    from app import observability

    with caplog.at_level(logging.INFO, logger="lsatlab.llm"):
        with observability.time_llm_call("explain", provider="ollama", model="qwen3:8b") as span:
            span["tokens"] = 42
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert "task=explain" in msgs
    assert "provider=ollama" in msgs
    assert "ok=True" in msgs
    assert "tokens=42" in msgs


def test_time_llm_call_logs_failure(caplog):
    from app import observability

    with caplog.at_level(logging.INFO, logger="lsatlab.llm"):
        try:
            with observability.time_llm_call("generate", provider="ollama", model="qwen3:14b"):
                raise RuntimeError("boom")
        except RuntimeError:
            pass
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert "ok=False" in msgs


def test_health_still_works_with_middleware(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_status_includes_backend_readiness(client):
    r = client.get("/api/observability/status")
    assert r.status_code == 200
    body = r.json()
    assert body["backend_ready"] is True
    assert body["db_ready"] is True
    assert body["worker_ready"] is True
    assert body["backup_status"] in {"fresh", "stale", "missing"}

    readiness = body["readiness"]
    assert readiness["ok"] is True
    assert readiness["db"]["integrity_check"] == {"result": "ok", "ok": True}
    assert readiness["db"]["foreign_key_check"]["ok"] is True
    assert readiness["db"]["orphan_total"] == 0
    assert readiness["db"]["schema_ok"] is True
    assert readiness["db"]["migrations_ok"] is True
    assert readiness["db"]["indexes_ok"] is True
    assert readiness["db"]["triggers_ok"] is True
    assert readiness["db"]["pragmas_ok"] is True
    assert readiness["worker"]["status"] == "disabled"
    assert readiness["worker"]["queue"]["queued"] == body["gen_queued"]
    assert readiness["worker"]["queue"]["running"] == body["gen_running"]


def test_ready_endpoint_reports_launch_readiness(client, monkeypatch):
    from app import ai

    async def fake_health():
        return {
            "ollama": True,
            "models": ["qwen3:8b", "qwen3:14b", "phi4:14b", "nomic-embed-text"],
            "offline_provider": "ollama",
            "realtime_provider": "ollama",
        }

    monkeypatch.setattr(ai, "health", fake_health)

    r = client.get("/api/ready", headers={"x-request-id": "ready-test"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["status"] == "ok"
    assert body["request_id"] == "ready-test"
    assert body["db"]["ready"] is True
    assert body["worker"]["ready"] is True
    assert body["backup"]["status"] in {"fresh", "stale", "missing"}
    assert body["ai"]["ready"] is True
    assert body["ai"]["ollama_reachable"] is True
    assert body["ai"]["model_available"]["explain"] is True


def test_runtime_evidence_reads_local_logs_and_metrics(client, db_session, monkeypatch, tmp_path):
    from app import config
    from app.models import MetricSample

    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    now = datetime.now(timezone.utc)
    stale = now - timedelta(days=2)
    (log_dir / "lsatlab.log").write_text(
        "\n".join(
            [
                f"{stale.isoformat()} ERROR lsatlab.request req=old method=GET path=/api/old status=500 dur_ms=2.0",
                f"{now.isoformat()} INFO lsatlab.request req=ok method=GET path=/api/health status=200 dur_ms=1.0",
                f"{now.isoformat()} ERROR lsatlab.request req=bad method=GET path=/api/boom status=500 dur_ms=2.0",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "LOG_DIR", log_dir)
    db_session.add(MetricSample(kind="llm_latency_ms", model="qwen3:8b", value=12.0))
    db_session.commit()

    r = client.get("/api/observability/runtime-evidence")

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["log_file_count"] == 1
    assert body["recent_error_count"] == 1
    assert body["stale_error_count"] == 1
    assert body["recent_error_window_hours"] == 12
    assert body["last_request_error"]["request_id"] == "bad"
    assert body["last_request_error"]["path"] == "/api/boom"
    assert body["metrics"]["available"] is True
    assert body["metrics"]["recent_count"] >= 1


def test_error_envelope_preserves_request_id(client):
    r = client.get("/api/preptests/999999", headers={"x-request-id": "err-test"})
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "not_found"
    assert body["request_id"] == "err-test"
    assert body["retryable"] is False
    assert "detail" in body
