"""ONE integration test against a real Ollama. Skipped when unreachable."""
from __future__ import annotations

import json

import httpx
import pytest

from app import config


def _ollama_up() -> bool:
    try:
        r = httpx.get(f"{config.OLLAMA_URL}/api/tags", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


@pytest.mark.skipif(not _ollama_up(), reason="Ollama not reachable")
def test_live_explain_streams_real_tokens(client):
    # Force live path: clear seeded explanation on question 1.
    from app.db import engine
    from app.models import Explanation
    from sqlmodel import Session, delete
    with Session(engine) as s:
        s.exec(delete(Explanation).where(Explanation.question_id == 1))
        s.commit()

    tokens = []
    explanation_id = None
    with client.stream("POST", "/api/ai/explain",
                       json={"question_id": 1, "chosen_answer": "A"}) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if not line.startswith("data: "):
                continue
            evt = json.loads(line[len("data: "):])
            if "token" in evt:
                tokens.append(evt["token"])
            if evt.get("done"):
                explanation_id = evt["explanation_id"]
                break
            if len(tokens) > 20:
                break  # enough to confirm streaming; don't wait for full gen

    assert len(tokens) > 0
    full = "".join(tokens)
    assert "<think>" not in full  # think blocks stripped
