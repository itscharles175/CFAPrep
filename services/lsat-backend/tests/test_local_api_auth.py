from __future__ import annotations

import pytest

from app import config


_TOKEN = "test-run-local-api-token"
_PROTECTED_ROUTE_SAMPLES = [
    ("put", "/api/study/profile"),
    ("post", "/api/bank/import"),
    ("post", "/api/export/backup"),
    ("post", "/api/backup/now"),
    ("post", "/api/ai/explain"),
]


def test_local_api_token_disabled_by_default_keeps_existing_api_calls(client, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", "")

    response = client.get("/api/preptests")

    assert response.status_code == 200


def test_local_api_token_rejects_missing_and_wrong_tokens(client, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", _TOKEN)

    missing = client.get("/api/preptests")
    wrong = client.get("/api/preptests", headers={"Authorization": "Bearer wrong"})

    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert missing.json()["code"] == "local_api_token_required"
    assert wrong.status_code == 401


@pytest.mark.parametrize(("method", "path"), _PROTECTED_ROUTE_SAMPLES)
def test_local_api_token_protects_write_import_backup_and_ai_routes(
    client, monkeypatch, method, path
):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", _TOKEN)

    missing = getattr(client, method)(path, json={})
    wrong = getattr(client, method)(
        path,
        json={},
        headers={"X-LSATLAB-API-Token": "wrong"},
    )

    assert missing.status_code == 401
    assert missing.json()["code"] == "local_api_token_required"
    assert wrong.status_code == 401


def test_local_api_token_allows_protected_route_to_reach_validation(
    client, monkeypatch
):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", _TOKEN)

    response = client.post(
        "/api/ai/explain",
        json={},
        headers={"Authorization": f"Bearer {_TOKEN}"},
    )

    assert response.status_code != 401


def test_local_api_token_accepts_authorization_bearer(client, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", _TOKEN)

    response = client.get(
        "/api/preptests",
        headers={"Authorization": f"Bearer {_TOKEN}"},
    )

    assert response.status_code == 200


def test_local_api_token_accepts_local_fallback_header(client, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", _TOKEN)

    response = client.get(
        "/api/preptests",
        headers={"X-LSATLAB-API-Token": _TOKEN},
    )

    assert response.status_code == 200


def test_local_api_token_leaves_launch_health_and_preflight_open(client, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_API_TOKEN", _TOKEN)

    health = client.get("/api/health")
    preflight = client.options(
        "/api/preptests",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization,X-LSATLAB-API-Token",
        },
    )

    assert health.status_code == 200
    assert health.json()["ok"] is True
    assert health.json()["service"] == "lsat-backend"
    assert health.json()["version"] == config.APP_VERSION
    assert preflight.status_code == 200
