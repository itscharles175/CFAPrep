"""Swarm P2 #48 — embeddings paste-leak guard for the Notebook export firewall.

The ref-based firewall only redacts artifact bodies *linked* to official
questions/passages/refs (covered by ``test_notebook_os_expansion.py``). These
tests cover the additive embeddings safety net: a free-text body the user PASTED
from an official item, carrying NO official ref link, must still be withheld on
export when it is near-identical to a stored official question — while benign
unrelated bodies export normally, and an unavailable embedder degrades gracefully
to the existing ref-based behaviour (no exception, nothing falsely redacted).

Mirrors the redaction fixtures/assertions in ``test_notebook_os_expansion.py``
(``_official_question_id`` shape, ``/api/evidence/capture`` -> ``/api/notebook-export``,
``redacted_count`` + "Official LSAT content redacted" in the body).
"""
from __future__ import annotations

import re

from sqlmodel import Session

from app import embeddings, llm
from app.db import engine
from app.models import Question, QuestionSource

# Distinctive vocab: the first cluster is the "official" content, the second is
# unrelated benign study notes. A bag-of-words over word-boundary counts makes
# cosine deterministic and meaningful without touching the network: a verbatim
# paste of the official text scores ~1.0 (well above the 0.92 firewall bar), while
# the benign note shares no words with the official cluster -> cosine 0.0.
_VOCAB = [
    # official-question cluster
    "correlation", "causation", "zoning", "ordinance", "presupposes", "flaw",
    # benign-note cluster
    "flashcard", "commute", "breakfast", "playlist", "weekend", "errand",
]


def _bow(text: str, model=None) -> list[float]:
    t = (text or "").lower()
    return [float(len(re.findall(rf"\b{w}\b", t))) for w in _VOCAB]


# The official question's text (passage+stem+prompt+choices) and a verbatim paste
# of it. Long enough to clear the helper's short-body skip (_SIMILARITY_MIN_BODY_CHARS).
_OFFICIAL_STEM = (
    "The argument presupposes a flaw: it treats the correlation between the new "
    "zoning ordinance and falling rents as proof of causation."
)
_OFFICIAL_PROMPT = "Which one of the following best describes the flaw in the argument?"
# What the user pastes into a free-text note — official text, no ref link.
_PASTED_OFFICIAL_BODY = (
    "The argument presupposes a flaw: it treats the correlation between the new "
    "zoning ordinance and falling rents as proof of causation, an unstated leap."
)
_BENIGN_BODY = (
    "My own commute flashcard playlist: review one flashcard each weekend errand "
    "and again over breakfast before the commute."
)


def _seed_official_question_with_embedding() -> int:
    """Create an OFFICIAL question and store its embedding via the same embeddings
    layer the export guard reads from. Returns the question id."""
    with Session(engine) as session:
        q = Question(
            stem=_OFFICIAL_STEM,
            prompt=_OFFICIAL_PROMPT,
            correct_answer="A",
            difficulty=3,
            q_type="Flaw",
            source=QuestionSource.official,
            approved=True,
        )
        session.add(q)
        session.commit()
        session.refresh(q)
        assert q.id is not None
        # Store the official vector through the real layer (commits + resets the
        # process cache) so the export route's fresh session reads it back.
        embeddings.embed_question(session, q, embedder=_bow)
        return q.id


def test_pasted_official_body_without_ref_is_redacted_on_export(client, monkeypatch):
    """A body near-identical to an official question but with NO official ref link
    is firewalled on export exactly like a linked-official artifact."""
    _seed_official_question_with_embedding()
    # The export guard embeds the body via llm.embed_sync — point it at the same
    # deterministic BoW so no network is touched and cosine is meaningful.
    monkeypatch.setattr(llm, "embed_sync", _bow)

    artifact = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Pasted official text (no ref link)",
            "body": _PASTED_OFFICIAL_BODY,
            # Deliberately NO refs -> the ref-based firewall does not flag it.
        },
    ).json()
    assert artifact["official_firewall"] is False  # ref firewall did not catch it

    exported = client.post(
        "/api/notebook-export",
        json={"title": "Paste leak export", "format": "markdown", "refs": [f"artifact:{artifact['id']}"]},
    ).json()
    assert exported["redacted_count"] == 1
    assert "presupposes a flaw" not in exported["body"]
    assert "zoning ordinance" not in exported["body"]
    assert "Official LSAT content redacted" in exported["body"]

    # JSON format surfaces the per-item flags: the artifact is marked firewalled.
    exported_json = client.post(
        "/api/notebook-export",
        json={"title": "Paste leak export json", "format": "json", "refs": [f"artifact:{artifact['id']}"]},
    ).json()
    item = exported_json["items"][0]
    assert item["redacted"] is True
    assert item["official_firewall"] is True
    assert "presupposes a flaw" not in (item["body"] or "")
    # Summary is blanked too so the markdown/html body<-summary fallback can't re-leak.
    assert "presupposes a flaw" not in (item["summary"] or "")


def test_benign_unrelated_body_exports_normally(client, monkeypatch):
    """A benign body that is NOT similar to any official item exports verbatim."""
    _seed_official_question_with_embedding()
    monkeypatch.setattr(llm, "embed_sync", _bow)

    artifact = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Benign personal note",
            "body": _BENIGN_BODY,
        },
    ).json()

    exported = client.post(
        "/api/notebook-export",
        json={"title": "Benign export", "format": "markdown", "refs": [f"artifact:{artifact['id']}"]},
    ).json()
    assert exported["redacted_count"] == 0
    assert "flashcard playlist" in exported["body"]
    assert "Official LSAT content redacted" not in exported["body"]


def test_embeddings_unavailable_degrades_to_ref_based_behaviour(client, monkeypatch):
    """When the embedder raises, the paste-leak guard must NOT crash and must NOT
    redact — the export falls back to the existing ref-based behaviour, so a body
    with no official ref exports normally even if it is in fact pasted official text."""
    _seed_official_question_with_embedding()

    def _boom(text, model=None):
        raise RuntimeError("embed model offline")

    monkeypatch.setattr(llm, "embed_sync", _boom)

    artifact = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Pasted official text, embedder down",
            "body": _PASTED_OFFICIAL_BODY,
        },
    ).json()

    exported = client.post(
        "/api/notebook-export",
        json={"title": "Degraded export", "format": "markdown", "refs": [f"artifact:{artifact['id']}"]},
    ).json()
    # No exception raised; ref-based firewall sees no official ref -> not redacted.
    assert exported["redacted_count"] == 0
    assert "presupposes a flaw" in exported["body"]


def test_ref_linked_official_still_redacted_with_guard_enabled(client, monkeypatch):
    """Regression: the existing ref-based redaction (a body LINKED to an official
    question) keeps working unchanged with the similarity guard in place."""
    qid = _seed_official_question_with_embedding()
    monkeypatch.setattr(llm, "embed_sync", _bow)

    official = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Linked official excerpt",
            "body": "Sensitive official local-only text.",
            "refs": [f"question:{qid}"],
        },
    ).json()
    assert official["official_firewall"] is True

    exported = client.post(
        "/api/notebook-export",
        json={"title": "Linked official redaction", "format": "markdown", "refs": [f"artifact:{official['id']}"]},
    ).json()
    assert exported["redacted_count"] == 1
    assert "Sensitive official" not in exported["body"]
    assert "Official LSAT content redacted" in exported["body"]
