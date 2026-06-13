"""D1 — the commit integrity gate (a wrong/missing answer key can't ship)."""
from __future__ import annotations

from app import import_pdf


def _q(ans: str, n_choices: int = 5) -> dict:
    return {
        "stem": "s", "prompt": "p?", "q_type": "Weaken", "difficulty": 3,
        "correct_answer": ans,
        "choices": [{"label": l, "text": "t"} for l in "ABCDE"[:n_choices]],
    }


def _parsed(q: dict) -> dict:
    return {"name": "X", "sections": [{"type": "LR", "passages": [], "questions": [q]}]}


def test_clean_structure_has_no_issues():
    assert import_pdf.commit_issues(_parsed(_q("B"))) == []


def test_flags_missing_answer_and_choice_count():
    issues = import_pdf.commit_issues(_parsed(_q("", n_choices=3)))
    kinds = {i["kind"] for i in issues}
    assert "missing_answer" in kinds
    assert "choice_count" in kinds


def test_flags_answer_not_in_choices():
    # 'E' is a valid letter but absent from a 4-choice question.
    issues = import_pdf.commit_issues(_parsed(_q("E", n_choices=4)))
    kinds = {i["kind"] for i in issues}
    assert "answer_not_in_choices" in kinds
    assert "choice_count" in kinds


def test_no_sections_flagged():
    issues = import_pdf.commit_issues({"name": "x", "sections": []})
    assert any(i["kind"] == "no_sections" for i in issues)


def test_commit_endpoint_blocks_then_force(client):
    bad = _parsed(_q(""))
    r = client.post("/api/import/commit", json={"parsed": bad, "source": "sample"})
    assert r.status_code == 409
    assert r.json()["code"] == "unresolved_integrity_issues"
    assert r.json()["detail"]["error"] == "unresolved_integrity_issues"
    assert r.json()["detail"]["issues"]

    r2 = client.post(
        "/api/import/commit", json={"parsed": bad, "source": "sample", "force": True}
    )
    assert r2.status_code == 200
    assert r2.json()["preptest_id"]


def test_commit_endpoint_allows_valid(client):
    good = _parsed(_q("C"))
    r = client.post("/api/import/commit", json={"parsed": good, "source": "sample"})
    assert r.status_code == 200
    assert r.json()["preptest_id"]
