"""Orchestrator: take the bank from `seed` to a target size end-to-end.

Pipeline (idempotent and resumable):

    1. Import open research datasets (skips rows already in the bank).
    2. Auto-tag research items with the heuristic + model classifier.
    3. Queue Tier-B generation jobs by q_type, rotating parents, until total
       question count crosses the target.

This module is the entry point a user runs once to grow the bank to ~5k items:

    uv run python -m app.bank_bootstrap --target-total 5000

It uses the same plumbing as the HTTP endpoints so behavior matches the UI.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import Optional

from sqlmodel import Session, func, select

from . import generation, import_dataset, tagging
from .db import engine, init_db
from .models import GenJob, GenStatus, Question, QuestionSource

# How many generated variations we are willing to queue for one q_type per run.
# Caps prevent the orchestrator from grinding through 1000 jobs of one type when
# its anchor count is huge.
_PER_TYPE_CAP_DEFAULT = 50


@dataclass
class BankStats:
    total: int = 0
    by_source: dict[str, int] = None
    by_q_type: dict[str, int] = None

    def __post_init__(self) -> None:
        self.by_source = self.by_source or {}
        self.by_q_type = self.by_q_type or {}


def bank_stats(session: Session) -> BankStats:
    """Snapshot of the bank for the dashboard and orchestrator."""
    rows = session.exec(select(Question.source, Question.q_type)).all()
    by_source: Counter[str] = Counter()
    by_q_type: Counter[str] = Counter()
    for source, q_type in rows:
        source_value = source.value if hasattr(source, "value") else str(source)
        by_source[source_value] += 1
        if q_type:
            by_q_type[q_type] += 1
    return BankStats(
        total=sum(by_source.values()),
        by_source=dict(by_source),
        by_q_type=dict(by_q_type),
    )


def _eligible_q_types(session: Session) -> list[tuple[str, int]]:
    """q_types with at least one non-AI anchor question. (q_type, anchor_count)."""
    rows = session.exec(
        select(Question.q_type, func.count(Question.id))
        .where(Question.source != QuestionSource.ai_generated)
        .where(Question.q_type.is_not(None))
        .group_by(Question.q_type)
    ).all()
    return [(qt, int(n)) for qt, n in rows if qt]


def plan_generation_jobs(session: Session, *, target_total: int,
                         per_type_cap: int = _PER_TYPE_CAP_DEFAULT,
                         min_anchors: int = 2) -> list[tuple[str, int]]:
    """Return a list of (q_type, count) describing jobs to queue.

    Strategy: split the deficit (target - current) across eligible q_types
    proportionally to ``sqrt(anchor_count)``. Square-root weights so a q_type
    with 200 anchors doesn't drown out one with 20 — we want broad coverage,
    not concentration. Each type is also capped by ``per_type_cap``.
    """
    stats = bank_stats(session)
    deficit = max(0, target_total - stats.total)
    if deficit == 0:
        return []

    types = [(qt, n) for (qt, n) in _eligible_q_types(session) if n >= min_anchors]
    if not types:
        return []

    weights = [(qt, n, n ** 0.5) for (qt, n) in types]
    total_weight = sum(w for _, _, w in weights) or 1.0
    jobs: list[tuple[str, int]] = []
    for qt, _n, w in weights:
        share = int(round(deficit * (w / total_weight)))
        share = min(share, per_type_cap)
        if share > 0:
            jobs.append((qt, share))
    return jobs


def queue_generation_jobs(session: Session, plan: list[tuple[str, int]],
                          *, runner: Callable[[int], None] = generation.run_job,
                          run_inline: bool = False,
                          status: GenStatus = GenStatus.queued) -> list[int]:
    """Insert GenJob rows from a plan. Returns the new job ids.

    ``status`` is ``queued`` (the durable worker will drain it) or ``planned``
    (a preview the worker ignores until activated). ``run_inline`` runs each job
    synchronously here — used by the CLI, which has no background worker.
    """
    job_ids: list[int] = []
    for q_type, count in plan:
        job = GenJob(q_type=q_type, count=count, status=status)
        session.add(job)
        session.commit()
        session.refresh(job)
        job_ids.append(job.id)
    if run_inline:
        # Run sequentially: a single Ollama instance saturates the GPU, so
        # parallelism only causes timeouts.
        for jid in job_ids:
            runner(jid)
    return job_ids


@dataclass
class BootstrapResult:
    starting_total: int
    final_total: int
    inserted_research: int
    tagged: int
    job_ids: list[int]


def bootstrap(session: Session, *, target_total: int = 5000,
              fixtures_dir: Optional[str] = None,
              tag_limit: int = 500,
              per_type_cap: int = _PER_TYPE_CAP_DEFAULT,
              run_generation: bool = True,
              runner: Callable[[int], None] = generation.run_job,
              import_sources: Optional[list[str]] = None,
              ) -> BootstrapResult:
    """Run all three phases. Each is independently skipable for resumption."""
    starting = bank_stats(session).total

    # Phase 1: research import.
    inserted = 0
    sources = import_sources or list(import_dataset.DATASETS.keys())
    for key in sources:
        rows_iter = None
        if fixtures_dir:
            from pathlib import Path
            path = Path(fixtures_dir) / f"{key}.jsonl"
            if not path.exists():
                continue
            rows_iter = import_dataset.read_jsonl(path)
        try:
            res = import_dataset.import_dataset(session, key, rows_iter=rows_iter)
            inserted += res.inserted
        except Exception:
            # Importer surface failures (network, parse) are logged but never
            # block the rest of the bootstrap.
            continue

    # Phase 2: auto-tag.
    tag_res = tagging.batch_tag(session, limit=tag_limit, only_research=True)

    # Phase 3: queue generation if we still need volume.
    plan = plan_generation_jobs(
        session, target_total=target_total, per_type_cap=per_type_cap,
    )
    job_ids: list[int] = []
    if plan:
        # run_generation=True (e.g. the CLI, with no worker) runs jobs inline and
        # marks them queued; otherwise we record a 'planned' preview the durable
        # worker ignores until the caller activates it.
        job_ids = queue_generation_jobs(
            session, plan, runner=runner,
            run_inline=run_generation,
            status=GenStatus.queued if run_generation else GenStatus.planned,
        )

    final_total = bank_stats(session).total
    return BootstrapResult(
        starting_total=starting,
        final_total=final_total,
        inserted_research=inserted,
        tagged=tag_res.updated,
        job_ids=job_ids,
    )


# --- CLI -------------------------------------------------------------------
def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.bank_bootstrap")
    parser.add_argument("--target-total", type=int, default=5000)
    parser.add_argument(
        "--per-type-cap", type=int, default=_PER_TYPE_CAP_DEFAULT,
        help="max generated items per q_type per run",
    )
    parser.add_argument(
        "--tag-limit", type=int, default=500,
        help="max items to auto-tag in this run",
    )
    parser.add_argument(
        "--fixtures-dir", default=None,
        help="if set, read research datasets from <key>.jsonl files here",
    )
    parser.add_argument(
        "--plan-only", action="store_true",
        help="print the planned jobs but do not run generation",
    )
    parser.add_argument(
        "--no-import", action="store_true",
        help="skip the research-dataset import phase",
    )
    args = parser.parse_args(argv or sys.argv[1:])
    init_db()

    with Session(engine) as session:
        result = bootstrap(
            session,
            target_total=args.target_total,
            fixtures_dir=args.fixtures_dir,
            tag_limit=args.tag_limit,
            per_type_cap=args.per_type_cap,
            run_generation=not args.plan_only,
            import_sources=[] if args.no_import else None,
        )
        stats = bank_stats(session)

    print(
        f"starting_total={result.starting_total} final_total={result.final_total}"
    )
    print(
        f"inserted_research={result.inserted_research} tagged={result.tagged} "
        f"jobs_queued={len(result.job_ids)}"
    )
    print("by_source:")
    for src, n in sorted(stats.by_source.items()):
        print(f"  {src}: {n}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
