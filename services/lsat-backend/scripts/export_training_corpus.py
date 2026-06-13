#!/usr/bin/env python3
"""Wave 6 — export accepted AI-generated items for QLoRA fine-tuning.

Usage (from backend/):
    uv run python scripts/export_training_corpus.py --out training.jsonl

Requires ~3k accepted items before training is worthwhile (see plan Wave 6).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlmodel import Session, select

from app.db import engine, init_db
from app.models import AnswerChoice, Question, QuestionSource


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="training.jsonl")
    parser.add_argument("--min-items", type=int, default=1)
    args = parser.parse_args()
    init_db()
    rows: list[dict] = []
    with Session(engine) as session:
        qs = session.exec(
            select(Question)
            .where(Question.source == QuestionSource.ai_generated)
            .where(Question.approved == True)  # noqa: E712
            .where(Question.quarantined == False)  # noqa: E712
            .where(Question.deleted_at.is_(None))
        ).all()
        for q in qs:
            choices = session.exec(
                select(AnswerChoice).where(AnswerChoice.question_id == q.id)
            ).all()
            rows.append({
                "id": q.id,
                "q_type": q.q_type,
                "stem": q.stem,
                "prompt": q.prompt,
                "correct_answer": q.correct_answer,
                "choices": [
                    {"label": c.label, "text": c.text, "trap_type": c.trap_type}
                    for c in sorted(choices, key=lambda x: x.label)
                ],
            })
    if len(rows) < args.min_items:
        print(f"Only {len(rows)} items (need {args.min_items})", file=sys.stderr)
        sys.exit(1)
    out = Path(args.out)
    with out.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    print(f"Wrote {len(rows)} items to {out}")


if __name__ == "__main__":
    main()
