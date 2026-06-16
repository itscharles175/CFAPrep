"""LEARN-4 — GET /api/srs/params (host-side FSRS parameter parity).

The host scheduler (src/lib/scheduler.ts) adopts the backend's source-of-truth
FSRS weights + desired retention at boot via this endpoint, so both domains
schedule reviews identically. These tests pin the contract: the shape, that it's
idempotent + side-effect free, that it reflects the live retention config, and
that it surfaces persisted optimized weights when present.
"""
from __future__ import annotations

import json

from app.models import Setting
from app.srs import _PARAMS_SETTING_KEY


def test_srs_params_default_shape(client):
    r = client.get("/api/srs/params")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"weights", "desired_retention", "source"}
    assert body["source"] == "backend"
    assert isinstance(body["weights"], list)
    # Default seeded DB has no persisted optimization -> empty weights, host keeps
    # its ts-fsrs defaults / local fit.
    assert body["weights"] == []
    # Mirrors config.SRS_DESIRED_RETENTION (default 0.9).
    assert body["desired_retention"] == 0.9


def test_srs_params_is_idempotent(client):
    first = client.get("/api/srs/params").json()
    second = client.get("/api/srs/params").json()
    assert first == second


def test_srs_params_surfaces_persisted_weights(client, db_session):
    # Persist a fake optimized weight vector the way srs._save_optimized_params
    # would, then assert the endpoint surfaces it as floats.
    weights = [0.4, 1.2, 3.0, 15.6, 7.2, 0.5, 1.5, 0.0, 1.6,
               0.1, 1.0, 2.1, 0.05, 0.34, 1.26, 0.29, 2.61,
               0.4, 0.6, 0.5, 0.1]
    db_session.add(Setting(key=_PARAMS_SETTING_KEY, value=json.dumps(weights)))
    db_session.commit()

    body = client.get("/api/srs/params").json()
    assert body["weights"] == weights
    assert all(isinstance(w, float) for w in body["weights"])
    assert body["source"] == "backend"


def test_srs_params_tracks_retention_config(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "SRS_DESIRED_RETENTION", 0.85, raising=False)
    body = client.get("/api/srs/params").json()
    assert body["desired_retention"] == 0.85
