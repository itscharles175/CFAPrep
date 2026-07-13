"""PDF import: parse (heuristic + AI-mocked) and commit flow."""
from __future__ import annotations

import io
import os
import tempfile

from app import import_pdf


def _fixture_pdf_bytes() -> bytes:
    path = os.path.join(tempfile.gettempdir(), "lsatlab_fixture.pdf")
    import_pdf.write_fixture_pdf(path)
    with open(path, "rb") as f:
        return f.read()


def test_extract_text_from_fixture():
    data = _fixture_pdf_bytes()
    text = import_pdf.extract_text(data)
    assert "weakens the argument" in text
    assert "Question 1" in text


def test_parse_heuristic_fallback():
    data = _fixture_pdf_bytes()
    # no structurer + no live model -> heuristic parser kicks in
    parsed, warnings = import_pdf.parse_pdf(data)
    assert parsed["sections"]
    q = parsed["sections"][0]["questions"][0]
    assert len(q["choices"]) == 5
    assert q["correct_answer"] == "B"


def test_parse_with_mocked_ai():
    data = _fixture_pdf_bytes()

    def structurer(raw_text):
        return {
            "name": "Mock Test",
            "sections": [{
                "type": "LR", "passages": [],
                "questions": [{
                    "stem": "Some stem.", "prompt": "Which weakens?",
                    "q_type": "Weaken", "difficulty": 3, "correct_answer": "C",
                    "choices": [{"label": l, "text": f"opt {l}"} for l in "ABCDE"],
                }],
            }],
        }

    parsed, warnings = import_pdf.parse_pdf(data, structurer=structurer)
    assert parsed["name"] == "Mock Test"
    assert parsed["sections"][0]["questions"][0]["correct_answer"] == "C"


def test_parse_and_commit_endpoints(client):
    data = _fixture_pdf_bytes()
    files = {"file": ("test.pdf", io.BytesIO(data), "application/pdf")}
    r = client.post("/api/import/parse", files=files)
    assert r.status_code == 200
    body = r.json()
    assert "job_id" in body and "parsed" in body and "warnings" in body
    assert body["import_run_id"]

    # commit the (unedited) parsed structure as a sample import. force=True keeps
    # this endpoint round-trip deterministic regardless of what the live
    # structuring model returns (the D1 integrity gate is covered by
    # test_import_gate.py).
    parsed = body["parsed"]
    r2 = client.post("/api/import/commit",
                     json={"job_id": body["job_id"], "parsed": parsed,
                           "source": "sample", "force": True})
    assert r2.status_code == 200
    pid = r2.json()["preptest_id"]
    assert pid
    run_id = r2.json()["import_run_id"]
    run = client.get(f"/api/import/runs/{run_id}").json()
    assert run["status"] == "done"
    assert run["preptest_id"] == pid
    assert run["row_counts"]["questions"] >= 1
    assert run["file_hash"]

    # the committed preptest is retrievable
    pt = client.get(f"/api/preptests/{pid}").json()
    assert pt["sections"]
