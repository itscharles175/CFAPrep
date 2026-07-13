from __future__ import annotations

import asyncio
import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlmodel import Session

from app import notebook_os
from app.db import engine
from app.models import AnswerChoice, NotebookNote, Question, QuestionSource, StudyArtifact
from app.routers import notebook_os_routes


def _official_question_id() -> int:
    with Session(engine) as session:
        q = Question(
            stem="Official local-only stem placeholder",
            prompt="Official local-only prompt placeholder",
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
        return q.id


def _official_question_with_choice() -> tuple[int, int]:
    with Session(engine) as session:
        q = Question(
            stem="Official choice stem placeholder",
            prompt="Official choice prompt placeholder",
            correct_answer="A",
            difficulty=2,
            q_type="Inference",
            source=QuestionSource.official,
            approved=True,
        )
        session.add(q)
        session.flush()
        choice = AnswerChoice(
            question_id=q.id or 0,
            label="A",
            text="Official answer choice text that must never be exported.",
            is_correct=True,
        )
        session.add(choice)
        session.commit()
        session.refresh(q)
        session.refresh(choice)
        assert q.id is not None
        assert choice.id is not None
        return q.id, choice.id


class _RecordingUpload:
    filename = "large.txt"
    content_type = "text/plain"

    def __init__(self, payload: bytes):
        self.payload = payload
        self.read_sizes: list[int] = []

    async def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if size is None or size < 0:
            return self.payload
        return self.payload[:size]


def test_notebook_os_workbench_round_trip(client):
    ws = client.get("/api/workspaces/default").json()
    assert ws["key"] == "default"

    source = client.post(
        "/api/notebook-sources",
        json={
            "title": "Flaw family research",
            "source_type": "markdown",
            "content": "Causal reversal and equivocation notes.",
            "provider": "local",
        },
    )
    assert source.status_code == 200
    source_payload = source.json()
    assert source_payload["artifact_id"]

    note = client.post(
        "/api/notebook-notes",
        json={
            "title": "Causal reversal trap",
            "note_type": "manual",
            "content": "When the author treats a possible effect as the cause.",
            "citations": [f"artifact:{source_payload['artifact_id']}"],
        },
    )
    assert note.status_code == 200
    assert note.json()["artifact_id"]

    search = client.get("/api/notebook-search?q=causal").json()
    assert any(row["title"] == "Causal reversal trap" for row in search["notes"])
    assert any(row["title"] == "Flaw family research" for row in search["sources"])
    assert any(row["title"] == "Flaw family research" for row in search["artifacts"])

    activity = client.get("/api/activity").json()
    assert any(row["kind"] in {"source_ingest", "note"} for row in activity)


def test_notebook_note_update_versions_backlinks_and_search(client):
    source = client.post(
        "/api/notebook-sources",
        json={
            "title": "Evidence source for editing",
            "source_type": "text",
            "content": "The source anchors a note revision.",
        },
    ).json()
    ref = f"artifact:{source['artifact_id']}"
    note = client.post(
        "/api/notebook-notes",
        json={
            "title": "Draft note",
            "note_type": "manual",
            "content": "Initial draft.",
            "citations": [ref],
        },
    ).json()

    updated = client.patch(
        f"/api/notebook-notes/{note['id']}",
        json={
            "title": "Revised note",
            "content": "Updated zpd-bridge wording for the linked source.",
            "citations": [ref],
        },
    )
    assert updated.status_code == 200
    updated_note = updated.json()
    assert updated_note["title"] == "Revised note"
    assert "zpd-bridge" in updated_note["content"]

    versions = client.get(f"/api/evidence/artifacts/{note['artifact_id']}/versions").json()
    assert versions[0]["version"] >= 2
    assert versions[0]["reason"] == "note_update"
    assert versions[0]["snapshot"]["title"] == "Revised note"

    backlinks = client.get(f"/api/backlinks/{ref}").json()
    assert any(
        row["source_artifact_id"] == note["artifact_id"]
        and row["source_title"] == "Revised note"
        and "zpd-bridge" in row["source_summary"]
        for row in backlinks
    )

    search = client.get("/api/notebook-search?q=zpd-bridge").json()
    assert any(row["title"] == "Revised note" for row in search["notes"])
    assert any(row["title"] == "Revised note" for row in search["artifacts"])


def test_notebook_os_firewall_citations_and_backlinks(client):
    qid = _official_question_id()
    capture = client.post(
        "/api/evidence/capture",
        json={
            "kind": "rationale",
            "title": "Official BR rationale",
            "body": "I picked B because the conclusion felt too broad.",
            "refs": [f"question:{qid}"],
        },
    )
    assert capture.status_code == 200
    artifact = capture.json()
    assert artifact["official_firewall"] is True
    assert artifact["cloud_allowed"] is False
    assert artifact["export_eligible"] is False

    citation = client.get(f"/api/citations/question:{qid}").json()
    assert citation["official_firewall"] is True
    assert "local-only" in citation["snippet"]

    backlinks = client.get(f"/api/backlinks/question:{qid}").json()
    assert any(row["source_artifact_id"] == artifact["id"] for row in backlinks)

    inbox = client.get("/api/knowledge-inbox").json()
    assert any(row["artifact_id"] == artifact["id"] for row in inbox)

    blocked = client.post(
        "/api/transformations/run",
        json={
            "template_key": "weekly_study_sheet",
            "provider": "cloud",
            "input_refs": [f"question:{qid}"],
        },
    )
    assert blocked.status_code == 403


def test_knowledge_inbox_items_can_be_triaged(client):
    artifact = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Inbox triage fixture",
            "body": "This captured idea should move through the inbox.",
        },
    ).json()
    inbox = client.get("/api/knowledge-inbox?status=open").json()
    item = next(row for row in inbox if row["artifact_id"] == artifact["id"])

    updated = client.patch(
        f"/api/knowledge-inbox/{item['id']}",
        json={"status": "resolved", "priority": 7, "reason": "Folded into study sheet"},
    )
    assert updated.status_code == 200
    payload = updated.json()
    assert payload["status"] == "resolved"
    assert payload["priority"] == 7
    assert payload["resolved_at"]

    open_items = client.get("/api/knowledge-inbox?status=open").json()
    assert all(row["id"] != item["id"] for row in open_items)
    resolved_items = client.get("/api/knowledge-inbox?status=resolved").json()
    assert any(row["id"] == item["id"] for row in resolved_items)
    activity = client.get("/api/activity").json()
    assert any(row["kind"] == "knowledge_inbox" for row in activity)


def test_notebook_os_chat_transform_podcast_and_presets(client):
    source = client.post(
        "/api/notebook-sources",
        json={
            "title": "Safe source",
            "source_type": "text",
            "content": "A safe local source about causal reversal and conditional logic.",
        },
    ).json()
    ref = f"artifact:{source['artifact_id']}"

    chat = client.post(
        "/api/notebook-chat/sessions",
        json={"title": "Scope chat", "mode": "summary", "model": "local", "context": {"refs": [ref]}},
    ).json()
    turn = client.post(
        f"/api/notebook-chat/sessions/{chat['id']}/messages",
        json={"content": "What should I review?", "refs": [ref]},
    )
    assert turn.status_code == 200
    assert turn.json()["assistant"]["role"] == "assistant"
    assert "Evidence-grounded tutor turn" in turn.json()["assistant"]["content"]
    assert "A safe local source about causal reversal" in turn.json()["assistant"]["content"]
    assert turn.json()["assistant"]["meta"]["evidence_count"] >= 1
    assistant_artifact_id = turn.json()["assistant"]["meta"]["artifact_id"]
    assert assistant_artifact_id
    backlinks = client.get(f"/api/backlinks/{ref}").json()
    assert any(
        row["source_artifact_id"] == assistant_artifact_id
        and row["source_kind"] == "tutor_turn"
        for row in backlinks
    )

    transform = client.post(
        "/api/transformations/run",
        json={"template_key": "summarize", "input_refs": [ref], "provider": "local"},
    )
    assert transform.status_code == 200
    assert transform.json()["status"] == "done"
    transform_payload = transform.json()
    assert transform_payload["output_artifact_id"]
    assert transform_payload["metrics"]["evidence_count"] >= 1
    transformed_artifact = client.get(
        f"/api/evidence/artifacts/{transform_payload['output_artifact_id']}"
    ).json()
    assert "A safe local source about causal reversal" in transformed_artifact["body"]
    assert "Evidence Scope" in transformed_artifact["body"]

    podcast = client.post(
        "/api/podcasts",
        json={"title": "Weekly briefing", "episode_type": "weekly_briefing", "source_refs": [ref]},
    )
    assert podcast.status_code == 200
    podcast_payload = podcast.json()
    assert podcast_payload["status"] == "transcript_ready"
    assert "A safe local source about causal reversal" in podcast_payload["transcript"]
    assert "Privacy note" in podcast_payload["transcript"]

    presets = client.get("/api/context-presets").json()
    assert {p["name"] for p in presets} >= {"Off", "Summary", "Official-firewalled"}

    preview = client.get("/api/observability/migrations/dry-run").json()
    assert preview["latest_expected_version"] >= 19


def test_podcast_audio_generation_and_stream(client, monkeypatch, tmp_path):
    monkeypatch.setattr(notebook_os.config, "EXPORT_DIR", tmp_path)

    def fake_synth(*, episode_id: int, title: str, transcript: str):
        path = notebook_os._podcast_audio_dir() / f"{episode_id}-{title}.wav"
        path.write_bytes(b"RIFF0000WAVEfmt local briefing")
        return str(path), {"status": "audio_ready", "format": "wav", "bytes": path.stat().st_size}

    monkeypatch.setattr(notebook_os, "_synthesize_podcast_audio", fake_synth)
    source = client.post(
        "/api/notebook-sources",
        json={
            "title": "Audio source",
            "source_type": "text",
            "content": "A local non-official source for an audio briefing.",
        },
    ).json()
    podcast = client.post(
        "/api/podcasts",
        json={
            "title": "Audio briefing",
            "episode_type": "weekly_briefing",
            "source_refs": [f"artifact:{source['artifact_id']}"],
            "generate_audio": True,
        },
    ).json()

    assert podcast["status"] == "audio_ready"
    assert podcast["audio_path"]
    assert podcast["firewall_decision"]["local_tts"]["status"] == "audio_ready"
    audio = client.get(f"/api/podcasts/{podcast['id']}/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/wav")
    assert audio.content.startswith(b"RIFF")


def test_notebook_source_import_and_export_bundle(client):
    uploaded = client.post(
        "/api/notebook-sources/import",
        data={"title": "Imported markdown", "source_type": "auto", "provider": "local"},
        files={"file": ("rules.md", b"# Rules\n\nConditional logic contrapositives.", "text/markdown")},
    )
    assert uploaded.status_code == 200
    source = uploaded.json()
    assert source["source_type"] == "markdown"
    assert source["processing"]["chars"] > 20

    ref = f"artifact:{source['artifact_id']}"
    exported = client.post(
        "/api/notebook-export",
        json={"title": "Rules export", "format": "markdown", "refs": [ref]},
    )
    assert exported.status_code == 200
    bundle = exported.json()
    assert bundle["format"] == "markdown"
    assert "Conditional logic contrapositives" in bundle["body"]
    assert bundle["redacted_count"] == 0


def test_notebook_import_round_trips_lsatlab_json_export(client):
    source = client.post(
        "/api/notebook-sources",
        json={
            "title": "Roundtrip source",
            "source_type": "text",
            "content": "Roundtrip import keeps ZPD packet evidence searchable.",
            "provider": "local",
        },
    ).json()
    note = client.post(
        "/api/notebook-notes",
        json={
            "title": "Roundtrip note",
            "content": "Roundtrip note cites the imported source.",
            "citations": [f"source:{source['id']}"],
        },
    ).json()
    exported = client.post(
        "/api/notebook-export",
        json={
            "title": "Roundtrip export",
            "format": "json",
            "refs": [f"source:{source['id']}", f"note:{note['id']}"],
        },
    ).json()

    imported = client.post(
        "/api/notebook-import",
        json={
            "title": "Imported roundtrip export",
            "format": "json",
            "content": json.dumps(exported["body"]),
            "tags": ["roundtrip"],
        },
    )
    assert imported.status_code == 200
    payload = imported.json()
    assert payload["schema"] == "lsatlab.notebook_import.v1"
    assert payload["created"]["sources"] >= 1
    assert payload["created"]["notes"] >= 1
    assert payload["created_refs"]
    assert payload["firewall_decision"]["cloud_allowed"] is True

    search = client.get("/api/notebook-search?q=ZPD%20packet").json()
    assert any("Roundtrip source" in row["title"] for row in search["sources"])


def test_notebook_import_accepts_notebooklm_markdown_sections(client):
    markdown = (
        "# NotebookLM export\n\n"
        "## Source: Imported conditional packet\n"
        "- Kind: `source`\n"
        "- Source type: `markdown`\n"
        "- Official firewall: `false`\n\n"
        "Imported bundle source explains sufficient assumption triggers.\n\n"
        "## Note: Imported trap synthesis\n"
        "- Kind: `note`\n\n"
        "A tempting answer widens the scope beyond the conclusion.\n"
    )
    imported = client.post(
        "/api/notebook-import",
        json={"title": "Markdown import", "format": "markdown", "content": markdown},
    )
    assert imported.status_code == 200
    payload = imported.json()
    assert payload["format"] == "markdown"
    assert payload["created"]["sources"] == 1
    assert payload["created"]["notes"] == 1

    search = client.get("/api/notebook-search?q=sufficient%20assumption%20triggers").json()
    assert any(row["title"] == "Imported conditional packet" for row in search["sources"])


def test_notebook_import_preserves_official_firewall_and_blocks_cloud(client):
    bundle = {
        "title": "Official import",
        "items": [
            {
                "kind": "source",
                "title": "Imported official excerpt",
                "body": "Imported official local-only phrase",
                "official_firewall": True,
            }
        ],
    }
    blocked = client.post(
        "/api/notebook-import",
        json={"title": "Blocked official import", "format": "json", "content": json.dumps(bundle), "provider": "cloud"},
    )
    assert blocked.status_code == 403

    imported = client.post(
        "/api/notebook-import",
        json={"title": "Official local import", "format": "json", "content": json.dumps(bundle), "provider": "local"},
    )
    assert imported.status_code == 200
    assert imported.json()["firewall_decision"]["cloud_allowed"] is False

    exported = client.post(
        "/api/notebook-export",
        json={"title": "Official import redaction", "format": "markdown", "refs": imported.json()["created_refs"]},
    ).json()
    assert exported["redacted_count"] == 1
    assert "Imported official local-only phrase" not in exported["body"]


def test_notebook_transcript_import_normalizes_cues(client):
    srt = (
        "1\n"
        "00:00:01,000 --> 00:00:04,000\n"
        "<v Tutor>Predict the conclusion before reading choices.\n\n"
        "2\n"
        "00:00:05,000 --> 00:00:08,000\n"
        "Then name the trap in one sentence.\n"
    )
    uploaded = client.post(
        "/api/notebook-sources/import",
        data={"title": "BR walkthrough transcript", "source_type": "auto", "provider": "local"},
        files={"file": ("walkthrough.srt", srt.encode("utf-8"), "text/plain")},
    )
    assert uploaded.status_code == 200
    source = uploaded.json()
    assert source["source_type"] == "video_transcript"

    exported = client.post(
        "/api/notebook-export",
        json={
            "title": "Transcript export",
            "format": "markdown",
            "refs": [f"artifact:{source['artifact_id']}"],
        },
    ).json()
    assert "Predict the conclusion before reading choices." in exported["body"]
    assert "Then name the trap" in exported["body"]
    assert "00:00:01" not in exported["body"]
    assert "-->" not in exported["body"]
    assert "<v Tutor>" not in exported["body"]


def test_notebook_source_rejects_empty_source_without_refs(client):
    direct = client.post(
        "/api/notebook-sources",
        json={"title": "Empty research source", "source_type": "text", "content": "  "},
    )
    assert direct.status_code == 400
    assert "Source needs" in direct.json()["detail"]

    imported = client.post(
        "/api/notebook-sources/import",
        data={"title": "Empty imported source", "source_type": "text", "content": "  "},
    )
    assert imported.status_code == 400
    assert "Source needs" in imported.json()["detail"]


def test_notebook_audio_transcript_upload_keeps_requested_type(client):
    transcript = (
        "WEBVTT\n\n"
        "NOTE exported from local STT\n"
        "hidden metadata\n\n"
        "00:00:00.000 --> 00:00:02.000\n"
        "Review conditional logic slowly.\n"
    )
    uploaded = client.post(
        "/api/notebook-sources/import",
        data={
            "title": "Commute recap transcript",
            "source_type": "audio_transcript",
            "provider": "local",
        },
        files={"file": ("recap.txt", transcript.encode("utf-8"), "text/plain")},
    )
    assert uploaded.status_code == 200
    source = uploaded.json()
    assert source["source_type"] == "audio_transcript"

    exported = client.post(
        "/api/notebook-export",
        json={
            "title": "Audio transcript export",
            "format": "markdown",
            "refs": [f"artifact:{source['artifact_id']}"],
        },
    ).json()
    assert "Review conditional logic slowly." in exported["body"]


def test_empty_scope_transformation_recomputes_firewall_from_retrieved_official_artifact(client):
    capture = client.post(
        "/api/evidence/capture",
        json={
            "kind": "source",
            "title": "Official sentinel retrieval scope",
            "body": "Official local-only text must not become export safe.",
            "official_firewall": True,
        },
    )
    assert capture.status_code == 200

    local_run = client.post(
        "/api/transformations/run",
        json={
            "template_key": "summarize",
            "title": "Official sentinel retrieval scope",
            "prompt": "Official sentinel retrieval scope",
            "provider": "local",
            "input_refs": [],
        },
    )
    assert local_run.status_code == 200
    payload = local_run.json()
    assert payload["firewall_decision"]["official_firewall"] is True
    assert payload["firewall_decision"]["export_eligible"] is False
    transformed = client.get(
        f"/api/evidence/artifacts/{payload['output_artifact_id']}"
    ).json()
    assert transformed["official_firewall"] is True
    assert transformed["export_eligible"] is False

    cloud_run = client.post(
        "/api/transformations/run",
        json={
            "template_key": "summarize",
            "title": "Official sentinel retrieval scope",
            "prompt": "Official sentinel retrieval scope",
            "provider": "cloud",
            "input_refs": [],
        },
    )
    assert cloud_run.status_code == 403


def test_choice_citations_resolve_through_answer_choice_question_firewall(client):
    _, choice_id = _official_question_with_choice()

    citation = client.get(f"/api/citations/choice:{choice_id}")
    assert citation.status_code == 200
    payload = citation.json()
    assert payload["exists"] is True
    assert payload["official_firewall"] is True
    assert "local-only" in payload["snippet"]
    assert "Official answer choice text" not in payload["snippet"]

    blocked = client.post(
        "/api/transformations/run",
        json={
            "template_key": "summarize",
            "provider": "cloud",
            "input_refs": [f"choice:{choice_id}"],
        },
    )
    assert blocked.status_code == 403


def test_official_note_citation_uses_central_redaction(client):
    qid = _official_question_id()
    note = client.post(
        "/api/notebook-notes",
        json={
            "title": "Official linked note",
            "content": "My private rationale about official question text.",
            "citations": [f"question:{qid}"],
        },
    ).json()

    citation = client.get(f"/api/citations/note:{note['id']}").json()
    assert citation["official_firewall"] is True
    assert "local-only" in citation["snippet"]
    assert "private rationale" not in citation["snippet"]


def test_official_source_type_and_registry_force_firewall(client):
    direct = client.post(
        "/api/notebook-sources",
        json={
            "title": "Official pasted source",
            "source_type": "official",
            "content": "Official passage text pasted locally.",
            "provider": "local",
        },
    )
    assert direct.status_code == 200
    source = direct.json()
    assert source["official_firewall"] is True
    exported = client.post(
        "/api/notebook-export",
        json={"refs": [f"source:{source['id']}"], "format": "markdown"},
    ).json()
    assert exported["redacted_count"] == 1
    assert "Official passage text" not in exported["body"]

    client.post(
        "/api/content/sources",
        json={
            "key": "official-registry",
            "label": "Official registry",
            "source_type": "official",
            "license": "user-owned",
            "firewall": {"cloud": "deny", "training": "deny", "export": "deny"},
        },
    )
    blocked = client.post(
        "/api/notebook-sources",
        json={
            "title": "Cloud official registry source",
            "source_registry_key": "official-registry",
            "content": "Registry marked official.",
            "provider": "cloud",
        },
    )
    assert blocked.status_code == 403


def test_content_health_blocks_notebook_firewall_violations(client):
    with Session(engine) as session:
        session.add(
            StudyArtifact(
                kind="note",
                title="Bad official artifact",
                body="Should be blocked by trust",
                official_firewall=True,
                cloud_allowed=True,
                export_eligible=True,
            )
        )
        session.commit()

    health = client.get("/api/content/health").json()
    assert health["official_firewall"]["ok"] is False
    assert health["official_firewall"]["notebook_violations"]["artifact_ids"]


def test_notebook_source_import_blocks_private_urls_and_large_uploads(client, monkeypatch):
    private_url = client.post(
        "/api/notebook-sources/import",
        data={
            "title": "Localhost URL",
            "source_type": "web",
            "url": "http://127.0.0.1:8000/private",
            "provider": "local",
        },
    )
    assert private_url.status_code == 400
    assert "Private or local network" in private_url.json()["detail"]

    monkeypatch.setattr(notebook_os, "MAX_SOURCE_UPLOAD_BYTES", 8)
    too_large = client.post(
        "/api/notebook-sources/import",
        data={"title": "Oversized upload", "source_type": "text", "provider": "local"},
        files={"file": ("large.txt", b"0123456789", "text/plain")},
    )
    assert too_large.status_code == 413


def test_notebook_source_import_reads_uploads_with_route_limit(db_session, monkeypatch):
    monkeypatch.setattr(notebook_os, "MAX_SOURCE_UPLOAD_BYTES", 8)
    upload = _RecordingUpload(b"0123456789abcdef")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            notebook_os_routes.import_source(
                title="Bounded upload",
                source_type="text",
                content_type="text/plain",
                content="",
                url="",
                provider="local",
                source_registry_key="",
                refs="[]",
                tags="[]",
                official_firewall=False,
                file=upload,  # type: ignore[arg-type]
                session=db_session,
            )
        )

    assert exc.value.status_code == 413
    assert upload.read_sizes == [9]


def test_notebook_source_import_rejects_oversized_refs_and_tags(client):
    too_many_refs = client.post(
        "/api/notebook-sources/import",
        data={
            "title": "Too many refs",
            "source_type": "text",
            "content": "Local notebook source.",
            "provider": "local",
            "refs": json.dumps([f"source:{idx}" for idx in range(101)]),
        },
    )
    assert too_many_refs.status_code == 422
    assert "Too many source refs" in too_many_refs.json()["detail"]

    too_many_tags = client.post(
        "/api/notebook-sources/import",
        data={
            "title": "Too many tags",
            "source_type": "text",
            "content": "Local notebook source.",
            "provider": "local",
            "tags": json.dumps([f"tag-{idx}" for idx in range(41)]),
        },
    )
    assert too_many_tags.status_code == 422
    assert "Too many source tags" in too_many_tags.json()["detail"]


def test_notebook_source_import_rejects_extracted_content_over_limit(client, monkeypatch):
    monkeypatch.setattr(notebook_os, "MAX_SOURCE_CONTENT_CHARS", 8)

    too_large = client.post(
        "/api/notebook-sources/import",
        data={"title": "Too much extracted text", "source_type": "text", "provider": "local"},
        files={"file": ("note.txt", b"0123456789", "text/plain")},
    )

    assert too_large.status_code == 413
    assert "Source content is too large" in too_large.json()["detail"]


def test_notebook_capabilities_and_search_health_are_public(client):
    capabilities = client.get("/api/notebook-capabilities").json()
    assert capabilities["schema"] == "lsatlab.notebook_capabilities.v1"
    assert "auto" in capabilities["source_types"]
    assert "after_reveal" in capabilities["context_modes"]
    assert any(row["key"] == "wrong_answer_packet" for row in capabilities["transformation_templates"])
    assert capabilities["limits"]["max_upload_bytes"] > 0

    health = client.get("/api/notebook-search/health").json()
    assert health["detail"]["table"] == "knowledge_fts"
    assert health["status"] in {"ok", "warn"}


def test_notebook_search_reports_fallback_metadata(client):
    created = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Fallback searchable note",
            "body": "rare fallback phrase notebook evidence",
        },
    ).json()
    with Session(engine) as session:
        session.execute(
            text("DELETE FROM knowledge_fts WHERE entity = 'artifact' AND entity_id = :id"),
            {"id": created["id"]},
        )
        session.commit()

    result = client.get("/api/notebook-search?q=rare%20fallback%20phrase").json()
    assert result["artifact_search"]["fallback_used"] is True
    assert any(row["id"] == created["id"] for row in result["artifacts"])


def test_study_context_for_targets_uses_safe_notebook_artifacts(client):
    with Session(engine) as session:
        safe = StudyArtifact(
            kind="note",
            title="Flaw trap tells",
            body="Scope shifts often move from a committee to a council.",
            summary="Scope shift tell.",
            q_type="Flaw",
            official_firewall=False,
        )
        unsafe = StudyArtifact(
            kind="note",
            title="Official-only trap tells",
            body="Protected official body.",
            q_type="Flaw",
            official_firewall=True,
        )
        session.add(safe)
        session.add(unsafe)
        session.commit()
        session.refresh(safe)
        session.add(
            NotebookNote(
                artifact_id=safe.id,
                title="Scope shift note",
                content="Compare exact subject changes before eliminating.",
            )
        )
        session.commit()

        ctx = notebook_os.study_context_for_targets(
            session, q_types=["Flaw"], labels=["scope shift"], limit=5,
        )

    assert ctx["count"] >= 2
    titles = {item["title"] for item in ctx["items"]}
    assert "Flaw trap tells" in titles
    assert "Scope shift note" in titles
    assert "Official-only trap tells" not in titles
    assert any("Scope shift tell" in note for note in ctx["notes"])


def test_content_health_detects_official_body_in_knowledge_index(client):
    official = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Official indexed leak fixture",
            "body": "official local-only index leak phrase",
            "official_firewall": True,
        },
    ).json()
    with Session(engine) as session:
        session.execute(
            text("DELETE FROM knowledge_fts WHERE entity = 'artifact' AND entity_id = :id"),
            {"id": official["id"]},
        )
        session.execute(
            text(
                "INSERT INTO knowledge_fts(entity, entity_id, title, body, summary, tags) "
                "VALUES ('artifact', :id, 'Official indexed leak fixture', "
                "'official local-only index leak phrase', '', '')"
            ),
            {"id": official["id"]},
        )
        session.commit()

    health = client.get("/api/content/health").json()
    assert "knowledge_fts_official_body_leak" in health["warnings"]
    assert official["id"] in health["index_health"]["knowledge_fts"]["detail"]["official_body_leak_ids"]


def test_create_source_rolls_back_artifact_when_aggregate_write_fails(monkeypatch):
    original_activity = notebook_os._activity

    def fail_source_activity(*args, **kwargs):
        if kwargs.get("kind") == "source_ingest":
            raise RuntimeError("source row side failed")
        return original_activity(*args, **kwargs)

    monkeypatch.setattr(notebook_os, "_activity", fail_source_activity)
    with Session(engine) as session:
        try:
            notebook_os.create_source(
                session,
                {
                    "title": "Atomic source fixture",
                    "content": "This source should roll back with its artifact.",
                    "provider": "local",
                },
            )
        except RuntimeError:
            session.rollback()
        rows = session.exec(
            text("SELECT COUNT(*) FROM studyartifact WHERE title = 'Atomic source fixture'")
        ).first()
    assert rows[0] == 0


def test_notebook_chat_can_use_explicit_local_model(monkeypatch, client):
    class FakeProvider:
        name = "ollama"

        def generate(self, model, prompt, system=None, timeout=None, **kwargs):
            assert model == "notebook-test-model"
            assert "Evidence digest" in prompt
            assert "answer keys hidden" in (system or "")
            return "<think>hidden</think>Model-backed Socratic notebook turn."

    monkeypatch.setattr(notebook_os.llm, "local_provider", lambda: FakeProvider())
    source = client.post(
        "/api/notebook-sources",
        json={
            "title": "Model evidence",
            "source_type": "text",
            "content": "A scope shift made the tempting answer too broad.",
            "provider": "local",
        },
    ).json()
    chat = client.post(
        "/api/notebook-chat/sessions",
        json={"title": "Model chat", "mode": "summary", "model": "notebook-test-model"},
    ).json()
    turn = client.post(
        f"/api/notebook-chat/sessions/{chat['id']}/messages",
        json={"content": "Diagnose my mistake.", "refs": [f"source:{source['id']}"]},
    ).json()

    assert turn["assistant"]["content"] == "Model-backed Socratic notebook turn."
    assert turn["assistant"]["meta"]["generation"]["mode"] == "model"
    assert turn["assistant"]["meta"]["generation"]["model"] == "notebook-test-model"


def test_notebook_docx_import_and_official_export_redaction(client):
    docx = io.BytesIO()
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>DOCX flaw pattern note.</w:t></w:r></w:p></w:body>"
        "</w:document>"
    )
    with zipfile.ZipFile(docx, "w") as archive:
        archive.writestr("word/document.xml", document_xml)

    imported = client.post(
        "/api/notebook-sources/import",
        data={"title": "Imported docx", "source_type": "auto", "provider": "local"},
        files={
            "file": (
                "note.docx",
                docx.getvalue(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert imported.status_code == 200
    assert imported.json()["source_type"] == "docx"

    qid = _official_question_id()
    official = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Official excerpt note",
            "body": "Sensitive official local-only text.",
            "refs": [f"question:{qid}"],
        },
    ).json()
    exported = client.post(
        "/api/notebook-export",
        json={"title": "Official redaction", "format": "markdown", "refs": [f"artifact:{official['id']}"]},
    ).json()
    assert exported["redacted_count"] == 1
    assert "Sensitive official" not in exported["body"]
    assert "Official LSAT content redacted" in exported["body"]

    resolved = client.get(f"/api/citations/artifact:{official['id']}").json()
    assert "Sensitive official" not in resolved["snippet"]
    assert "local-only" in resolved["snippet"]

    search = client.get("/api/notebook-search?q=Sensitive").json()
    assert not any(row["id"] == official["id"] for row in search["artifacts"])

    blocked = client.post(
        "/api/notebook-sources/import",
        data={
            "title": "Unsafe official cloud source",
            "source_type": "text",
            "provider": "cloud",
            "official_firewall": "true",
            "content": "official summary",
        },
    )
    assert blocked.status_code == 403


def test_notebook_docx_import_rejects_oversized_document_xml(client, monkeypatch):
    monkeypatch.setattr(notebook_os, "MAX_DOCX_DOCUMENT_XML_BYTES", 32)
    docx = io.BytesIO()
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>This document XML is intentionally too large.</w:t></w:r></w:p></w:body>"
        "</w:document>"
    )
    with zipfile.ZipFile(docx, "w") as archive:
        archive.writestr("word/document.xml", document_xml)

    imported = client.post(
        "/api/notebook-sources/import",
        data={"title": "Oversized docx", "source_type": "auto", "provider": "local"},
        files={
            "file": (
                "note.docx",
                docx.getvalue(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )

    assert imported.status_code == 413
    assert "Source upload is too large" in imported.json()["detail"]


def test_official_evidence_grounding_redacts_chat_transform_and_podcast(client):
    qid = _official_question_id()
    official = client.post(
        "/api/evidence/capture",
        json={
            "kind": "note",
            "title": "Official sensitive artifact",
            "body": "Never quote this official content in generated outputs.",
            "refs": [f"question:{qid}"],
        },
    ).json()
    ref = f"artifact:{official['id']}"

    chat = client.post(
        "/api/notebook-chat/sessions",
        json={"title": "Official chat", "mode": "official_firewalled", "model": "local", "context": {"refs": [ref]}},
    ).json()
    turn = client.post(
        f"/api/notebook-chat/sessions/{chat['id']}/messages",
        json={"content": "Help without revealing content.", "refs": [ref]},
    )
    assert turn.status_code == 200
    assistant = turn.json()["assistant"]
    assert assistant["meta"]["redacted_count"] >= 1
    assert "Never quote this official" not in assistant["content"]
    assert "Official LSAT content is in scope locally" in assistant["content"]

    transform = client.post(
        "/api/transformations/run",
        json={"template_key": "summarize", "input_refs": [ref], "provider": "local"},
    ).json()
    artifact = client.get(f"/api/evidence/artifacts/{transform['output_artifact_id']}").json()
    assert artifact["official_firewall"] is True
    assert "Never quote this official" not in artifact["body"]
    assert "Official LSAT content is in scope locally" in artifact["body"]

    podcast = client.post(
        "/api/podcasts",
        json={"title": "Official briefing", "episode_type": "wrong_answer_review", "source_refs": [ref]},
    ).json()
    assert "Never quote this official" not in podcast["transcript"]
    assert "official local-only" in podcast["transcript"].lower()
