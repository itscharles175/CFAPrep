"""Import open LSAT research datasets into the local question bank.

What this module does:

1. Downloads rows from a Hugging Face dataset using the datasets-server API
   (`/rows` endpoint, paginated JSON). No `datasets`/`pyarrow` dependency.
2. Normalizes rows via :mod:`app.dataset_normalizers` into a common shape.
3. Commits them into the existing PrepTest/Section/Passage/Question schema,
   idempotently: re-running an import skips rows already present by either
   ``external_id`` or ``content_hash``.

Why a custom downloader: the HF `datasets` library pulls in pyarrow + fsspec +
multiprocess + more. For a single-user local app the HF datasets-server JSON API
(100 rows/page) is plenty fast and adds zero new dependencies (the project
already uses ``httpx``).

CLI:

    uv run python -m app.import_dataset --sources agieval-lsat-lr,tasksource-lsat-rc

Each dataset becomes one ``PrepTest`` (one Section per LR/RC), with research
``QuestionSource``. Rows are content-hashed so AGIEval RC overlap with
tasksource RC dedups cleanly.
"""
from __future__ import annotations

import argparse
import json
import stat
import sys
import zipfile
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Optional

import httpx
from sqlmodel import Session, select

from . import dataset_normalizers as dn
from .db import engine, init_db
from .models import (
    AnswerChoice,
    Passage,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
)

# --- registry --------------------------------------------------------------
MAX_LOCAL_DATASET_BYTES = 50 * 1024 * 1024
MAX_JSONL_BYTES = 50 * 1024 * 1024
MAX_JSONL_ROWS = 25_000
MAX_JSONL_LINE_BYTES = 1 * 1024 * 1024
MAX_RECLOR_ZIP_BYTES = 50 * 1024 * 1024
MAX_RECLOR_ZIP_ENTRIES = 20
MAX_RECLOR_MEMBER_BYTES = 10 * 1024 * 1024
MAX_RECLOR_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
MAX_RECLOR_COMPRESSION_RATIO = 100
MAX_RECLOR_ROWS = 25_000
RECLOR_JSON_MEMBERS = {
    "train.json",
    "val.json",
    "valid.json",
    "validation.json",
    "dev.json",
    "test.json",
}


@dataclass(frozen=True)
class DatasetSpec:
    key: str                # local key (matches `dataset_normalizers.NORMALIZERS`)
    hf_dataset: str         # HF dataset id, e.g. "dmayhem93/agieval-lsat-lr"
    hf_split: str           # "train" | "test" | "validation"
    hf_config: str = "default"
    preptest_name: str = ""
    section_type: str = ""  # "LR" | "RC"
    license: str = ""       # provenance for redistribution decisions
    # Raw-row fields the normalizer needs; used to detect upstream schema drift.
    expected_fields: tuple[str, ...] = ()
    # Which ``QuestionSource`` bucket inserted rows land in. Defaults to
    # ``research`` (the safe, redistributable, non-commercial-friendly bucket).
    # ReClor overrides this to ``reclor`` so commercial builds can filter the
    # source out wholesale.
    question_source: QuestionSource = QuestionSource.research
    # ReClor and other non-HF sources don't go through datasets-server; they
    # require a user-supplied local path (zip / JSON). When True, the importer
    # refuses to run the network fetch and expects ``rows_iter`` to be supplied.
    requires_local_path: bool = False
    # If True, callers must pass ``nc_acknowledged=True`` before the importer
    # will commit rows. Surfaces in the UI as a non-commercial gate.
    requires_nc_acknowledgement: bool = False


DATASETS: dict[str, DatasetSpec] = {
    "agieval-lsat-lr": DatasetSpec(
        key="agieval-lsat-lr",
        hf_dataset="dmayhem93/agieval-lsat-lr",
        hf_split="test",
        preptest_name="AGIEval LSAT Logical Reasoning (research)",
        section_type="LR",
        license="MIT",
        expected_fields=("query", "choices", "gold"),
    ),
    "agieval-lsat-rc": DatasetSpec(
        key="agieval-lsat-rc",
        hf_dataset="dmayhem93/agieval-lsat-rc",
        hf_split="test",
        preptest_name="AGIEval LSAT Reading Comprehension (research)",
        section_type="RC",
        license="MIT",
        expected_fields=("query", "choices", "gold"),
    ),
    "tasksource-lsat-rc": DatasetSpec(
        key="tasksource-lsat-rc",
        hf_dataset="tasksource/lsat-rc",
        hf_split="train",
        preptest_name="tasksource LSAT Reading Comprehension (research)",
        section_type="RC",
        license="CC-BY-4.0",
        expected_fields=("context", "question", "answers", "label"),
    ),
    "tasksource-lsat-lr": DatasetSpec(
        key="tasksource-lsat-lr",
        hf_dataset="tasksource/lsat-lr",
        hf_split="train",
        preptest_name="tasksource LSAT Logical Reasoning (research)",
        section_type="LR",
        license="CC-BY-4.0",
        # Same parquet shape as tasksource/lsat-rc: each row is a fully-packed
        # LR item (context=stimulus, question=prompt, answers=5 strings,
        # label=0-based correct index).
        expected_fields=("context", "question", "answers", "label"),
    ),
    "reclor": DatasetSpec(
        key="reclor",
        hf_dataset="",  # not on HF — user supplies a local zip path
        hf_split="",
        preptest_name="ReClor LSAT items (non-commercial)",
        section_type="LR",
        license="Non-commercial / personal research only (Yu et al., ICLR 2020)",
        expected_fields=("context", "question", "answers", "label"),
        question_source=QuestionSource.reclor,
        requires_local_path=True,
        requires_nc_acknowledgement=True,
    ),
}


def safe_regular_file(
    path: str | Path,
    *,
    max_bytes: int = MAX_LOCAL_DATASET_BYTES,
    allowed_suffixes: set[str] | None = None,
) -> Path:
    p = Path(path)
    try:
        meta = p.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"Dataset file not found: {path}") from exc
    if stat.S_ISLNK(meta.st_mode):
        raise ValueError("dataset_path_symlink")
    if not stat.S_ISREG(meta.st_mode):
        raise ValueError("dataset_path_not_regular_file")
    if allowed_suffixes is not None and p.suffix.lower() not in allowed_suffixes:
        raise ValueError("dataset_path_unsupported_extension")
    if meta.st_size > max_bytes:
        raise ValueError("dataset_file_too_large")
    return p


def validate_rows(key: str, rows: Iterable[dict[str, Any]], *, sample: int = 5) -> dict:
    """Check a sample of raw rows for the fields the normalizer needs.

    Detects upstream schema drift before a silent zero-insert import: if a source
    renames/removes a field, this flags it instead of the importer quietly
    skipping every row.
    """
    if key not in DATASETS:
        raise ValueError(f"Unknown dataset key: {key}")
    expected = DATASETS[key].expected_fields
    checked = 0
    missing: Counter = Counter()
    for row in rows:
        checked += 1
        for f in expected:
            if f not in row:
                missing[f] += 1
        if checked >= sample:
            break
    return {
        "dataset": key,
        "checked": checked,
        "expected_fields": list(expected),
        "missing_fields": dict(missing),
        "schema_ok": checked > 0 and not missing,
    }


# --- download --------------------------------------------------------------
_ROWS_API = "https://datasets-server.huggingface.co/rows"


def fetch_rows(spec: DatasetSpec, *, limit: Optional[int] = None,
               page_size: int = 100,
               http_client: Optional[httpx.Client] = None) -> Iterator[dict[str, Any]]:
    """Yield raw HF rows for `spec`. Stops at `limit` if given.

    Uses the datasets-server `/rows` endpoint. `row["row"]` is the actual sample.
    Networking is the only thing this function does; downstream code never needs
    to know whether rows came from the network or a local fixture.
    """
    own_client = http_client is None
    client = http_client or httpx.Client(timeout=60.0)
    try:
        offset = 0
        yielded = 0
        while True:
            params = {
                "dataset": spec.hf_dataset,
                "config": spec.hf_config,
                "split": spec.hf_split,
                "offset": offset,
                "length": page_size,
            }
            resp = client.get(_ROWS_API, params=params)
            resp.raise_for_status()
            payload = resp.json()
            rows = payload.get("rows") or []
            if not rows:
                break
            for entry in rows:
                yield entry.get("row") or {}
                yielded += 1
                if limit is not None and yielded >= limit:
                    return
            total = payload.get("num_rows_total")
            offset += len(rows)
            if total is not None and offset >= int(total):
                break
    finally:
        if own_client:
            client.close()


def read_jsonl(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield rows from a JSONL fixture file. Skips blank lines.

    B29: tries UTF-8 first, falls back to UTF-8-BOM (utf-8-sig) then latin-1
    for files from tools that prepend a BOM or use the Windows-1252 superset.
    """
    p = safe_regular_file(path, max_bytes=MAX_JSONL_BYTES, allowed_suffixes={".jsonl"})
    data = p.read_bytes()
    text = ""
    decode_error: UnicodeDecodeError | None = None
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            text = data.decode(enc)
            decode_error = None
            break
        except UnicodeDecodeError as exc:
            decode_error = exc
            continue
    if decode_error is not None:
        raise decode_error
    for index, line in enumerate(text.splitlines(), start=1):
        if index > MAX_JSONL_ROWS:
            raise ValueError("jsonl_row_limit_exceeded")
        if len(line.encode("utf-8")) > MAX_JSONL_LINE_BYTES:
            raise ValueError("jsonl_line_too_large")
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)


# --- commit ---------------------------------------------------------------
@dataclass
class ImportResult:
    dataset: str
    preptest_id: Optional[int] = None
    inserted: int = 0
    skipped_duplicate: int = 0
    rows_seen: int = 0
    warnings: list[str] = field(default_factory=list)


def _existing_keys(session: Session) -> tuple[set[str], set[str]]:
    """Cache the (external_id, content_hash) values already in the bank.

    Two queries beat doing one SELECT per row for a 3k-row import.
    """
    ext_rows = session.exec(
        select(Question.external_id).where(Question.external_id.is_not(None))
    ).all()
    hash_rows = session.exec(
        select(Question.content_hash).where(Question.content_hash.is_not(None))
    ).all()
    return (
        {r for r in ext_rows if r},
        {r for r in hash_rows if r},
    )


def _get_or_create_preptest(session: Session, spec: DatasetSpec) -> PrepTest:
    pt = session.exec(
        select(PrepTest).where(PrepTest.name == spec.preptest_name)
    ).first()
    if pt is not None:
        return pt
    pt = PrepTest(
        name=spec.preptest_name,
        source=spec.key,
        is_official=False,
    )
    session.add(pt)
    session.flush()
    return pt


def _get_or_create_section(session: Session, preptest_id: int,
                           section_type: str) -> Section:
    sec = session.exec(
        select(Section)
        .where(Section.preptest_id == preptest_id)
        .where(Section.type == SectionType(section_type))
    ).first()
    if sec is not None:
        return sec
    sec = Section(
        preptest_id=preptest_id,
        type=SectionType(section_type),
        order=0,
    )
    session.add(sec)
    session.flush()
    return sec


def _import_embed_text(rec: dn.NormalizedQuestion) -> str:
    """Text embedded for import-time dedup — same shape as ``embeddings.question_text``."""
    choices = sorted(rec.get("choices", []), key=lambda c: c.get("label", ""))
    ch = " ".join(str(c.get("text", "")) for c in choices)
    if rec.get("section_type") == "RC":
        passage = rec.get("passage_text") or ""
        return f"{passage}\n{rec.get('prompt', '')}\n{ch}".strip()
    stem = rec.get("stem", "") or ""
    return f"{stem}\n{rec.get('prompt', '')}\n{ch}".strip()


def commit_records(session: Session, spec: DatasetSpec,
                   records: Iterable[dn.NormalizedQuestion],
                   *,
                   training_eligible: bool = False,
                   training_role: Optional[str] = None,
                   training_notes: Optional[str] = None,
                   embedder=None) -> ImportResult:
    """Persist normalized records into the bank. Idempotent on external_id/hash.

    ``training_eligible`` (and the related ``training_role``/``training_notes``)
    flag the whole import as user-curated training-corpus material — typically
    only set when the user is pulling a curated dataset they personally trust,
    or when the PDF import wizard marks an own-PDF as training data. Default
    off so research-grade open datasets aren't auto-promoted into the LoRA set.
    """
    from sqlalchemy.exc import IntegrityError

    from . import config, embeddings

    result = ImportResult(dataset=spec.key)
    try:
        with session.begin_nested():
            pt = _get_or_create_preptest(session, spec)
            result.preptest_id = pt.id
            section = _get_or_create_section(session, pt.id, spec.section_type)

            seen_ext, seen_hash = _existing_keys(session)
            passage_cache: dict[str, int] = {}

            effective_role = training_role
            if training_eligible and not effective_role:
                effective_role = "both"

            for rec in records:
                result.rows_seen += 1
                ext = rec.get("external_id")
                h = rec.get("content_hash")
                if (ext and ext in seen_ext) or (h and h in seen_hash):
                    result.skipped_duplicate += 1
                    continue

                # Wave 3.3 — embedding dedup at import (tiered thresholds).
                import_text = _import_embed_text(rec)
                near = embeddings.nearest_existing(
                    session, import_text, embedder=embedder,
                )
                quarantine_import = False
                if near:
                    score = near["score"]
                    if score >= config.IMPORT_DEDUP_SKIP:
                        result.skipped_duplicate += 1
                        continue
                    if score >= config.IMPORT_DEDUP_QUARANTINE:
                        quarantine_import = True

                try:
                    with session.begin_nested():
                        passage_id: Optional[int] = None
                        group = rec.get("passage_group")
                        if rec.get("section_type") == "RC" and group:
                            passage_id = passage_cache.get(group)
                            if passage_id is None:
                                ptext = rec.get("passage_text") or ""
                                existing = session.exec(
                                    select(Passage)
                                    .where(Passage.section_id == section.id)
                                    .where(Passage.text == ptext)
                                ).first()
                                if existing is not None:
                                    passage_id = existing.id
                                else:
                                    p = Passage(section_id=section.id, text=ptext, type="single")
                                    session.add(p)
                                    session.flush()
                                    passage_id = p.id
                                passage_cache[group] = passage_id

                        q = Question(
                            section_id=section.id,
                            passage_id=passage_id,
                            stem=rec.get("stem", "") if rec.get("section_type") == "LR" else "",
                            prompt=rec.get("prompt", ""),
                            correct_answer=rec.get("correct_answer", "A"),
                            difficulty=dn.clamp_difficulty(rec.get("difficulty")),
                            q_type=rec.get("q_type_hint") or _default_q_type(
                                rec.get("section_type", "LR")
                            ),
                            source=spec.question_source,
                            external_id=ext,
                            content_hash=h,
                            approved=not quarantine_import,
                            quarantined=quarantine_import,
                            tag_confidence="low" if quarantine_import else None,
                            training_eligible=training_eligible,
                            training_role=effective_role,
                            training_notes=training_notes,
                        )
                        session.add(q)
                        session.flush()
                        for c in rec.get("choices", []):
                            session.add(AnswerChoice(
                                question_id=q.id,
                                label=c.get("label", "?"),
                                text=c.get("text", ""),
                                is_correct=((c.get("label") or "").strip().upper()
                                            == (q.correct_answer or "").strip().upper()),
                                trap_type=None,
                            ))
                except IntegrityError:
                    result.skipped_duplicate += 1
                    continue

                if ext:
                    seen_ext.add(ext)
                if h:
                    seen_hash.add(h)
                result.inserted += 1
                if config.IMPORT_EMBED_ON_COMMIT or embedder is not None:
                    try:
                        embeddings.embed_question(session, q, embedder=embedder, commit=False)
                    except Exception:  # noqa: BLE001 — import must not fail on embed outage
                        pass
    except Exception:
        session.rollback()
        raise

    session.commit()
    return result


def _default_q_type(section_type: str) -> str:
    return "Inference" if section_type == "LR" else "Detail"


def _safe_reclor_zip_infos(infos: list[zipfile.ZipInfo]) -> list[zipfile.ZipInfo]:
    if len(infos) > MAX_RECLOR_ZIP_ENTRIES:
        raise ValueError("reclor_zip_too_many_entries")
    total_uncompressed = 0
    json_infos: list[zipfile.ZipInfo] = []
    for info in infos:
        if info.flag_bits & 0x1:
            raise ValueError("reclor_zip_encrypted_entry")
        normalized = info.filename.replace("\\", "/")
        member_path = PurePosixPath(normalized)
        if member_path.is_absolute() or any(part in {"", ".", ".."} for part in member_path.parts):
            raise ValueError("reclor_zip_invalid_member_path")
        total_uncompressed += info.file_size
        if total_uncompressed > MAX_RECLOR_TOTAL_UNCOMPRESSED_BYTES:
            raise ValueError("reclor_zip_uncompressed_too_large")
        if info.compress_size == 0 and info.file_size > 0:
            raise ValueError("reclor_zip_compression_ratio_too_high")
        if info.compress_size > 0 and info.file_size / info.compress_size > MAX_RECLOR_COMPRESSION_RATIO:
            raise ValueError("reclor_zip_compression_ratio_too_high")
        if info.is_dir() or not info.filename.lower().endswith(".json"):
            continue
        if member_path.name.lower() not in RECLOR_JSON_MEMBERS:
            raise ValueError("reclor_zip_unexpected_json_member")
        if info.file_size > MAX_RECLOR_MEMBER_BYTES:
            raise ValueError("reclor_zip_member_too_large")
        json_infos.append(info)
    return json_infos


def read_reclor_zip(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield raw ReClor rows from a user-supplied local zip.

    We never auto-fetch ReClor (its license is non-commercial / personal
    research only), so the caller passes a local path they downloaded
    themselves. The zip typically contains ``train.json``, ``val.json``, and
    ``test.json``; we read whichever JSON arrays we find inside.
    """
    p = safe_regular_file(path, max_bytes=MAX_RECLOR_ZIP_BYTES, allowed_suffixes={".zip"})
    yielded = 0
    with zipfile.ZipFile(p) as zf:
        for info in _safe_reclor_zip_infos(zf.infolist()):
            with zf.open(info) as fh:
                raw = fh.read()
            try:
                rows = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(rows, list):
                continue
            for row in rows:
                if isinstance(row, dict):
                    yielded += 1
                    if yielded > MAX_RECLOR_ROWS:
                        raise ValueError("reclor_row_limit_exceeded")
                    yield row


def import_dataset(session: Session, key: str, *,
                   limit: Optional[int] = None,
                   rows_iter: Optional[Iterable[dict[str, Any]]] = None,
                   local_path: Optional[str | Path] = None,
                   nc_acknowledged: bool = False,
                   training_eligible: bool = False,
                   training_role: Optional[str] = None,
                   training_notes: Optional[str] = None,
                   ) -> ImportResult:
    """Import one dataset by registry key.

    - ``rows_iter`` overrides the network (used by tests and fixture-based
      imports).
    - ``local_path`` is used by sources that don't go through datasets-server
      (currently ReClor): the file is read locally and normalized.
    - ``nc_acknowledged`` must be True for any spec with
      ``requires_nc_acknowledgement=True`` (ReClor).
    - ``training_eligible`` / ``training_role`` / ``training_notes`` propagate
      down to ``commit_records`` so the user can flag a curated import as
      training-corpus material in one shot.
    """
    if key not in DATASETS:
        raise ValueError(f"Unknown dataset key: {key}")
    spec = DATASETS[key]
    if spec.requires_nc_acknowledgement and not nc_acknowledged:
        raise ValueError(
            f"Dataset '{key}' requires nc_acknowledged=True (non-commercial use)."
        )
    normalizer = dn.NORMALIZERS[key]
    if rows_iter is None:
        if spec.requires_local_path:
            if not local_path:
                raise ValueError(
                    f"Dataset '{key}' requires a local_path (no auto-fetch allowed)."
                )
            if key == "reclor":
                rows_iter = read_reclor_zip(local_path)
            else:
                rows_iter = read_jsonl(local_path)
        else:
            rows_iter = fetch_rows(spec, limit=limit)
    records = normalizer(rows_iter)
    return commit_records(
        session,
        spec,
        records,
        training_eligible=training_eligible,
        training_role=training_role,
        training_notes=training_notes,
    )


# --- CLI -------------------------------------------------------------------
def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="app.import_dataset",
        description="Import open LSAT research datasets into the bank.",
    )
    parser.add_argument(
        "--sources",
        default=",".join(DATASETS.keys()),
        help="comma-separated dataset keys (default: all)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="cap rows per dataset (debug aid; default: all)",
    )
    parser.add_argument(
        "--fixtures-dir", default=None,
        help="if set, read each <key>.jsonl from here instead of the network",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    keys = [k.strip() for k in args.sources.split(",") if k.strip()]
    init_db()
    results: list[ImportResult] = []
    with Session(engine) as session:
        for key in keys:
            rows_iter = None
            if args.fixtures_dir:
                path = Path(args.fixtures_dir) / f"{key}.jsonl"
                if not path.exists():
                    print(f"[skip] no fixture file at {path}", file=sys.stderr)
                    continue
                rows_iter = read_jsonl(path)
            try:
                res = import_dataset(session, key, limit=args.limit, rows_iter=rows_iter)
            except (httpx.HTTPError, ValueError) as exc:
                print(f"[error] {key}: {exc}", file=sys.stderr)
                continue
            results.append(res)
            print(
                f"[{res.dataset}] preptest={res.preptest_id} "
                f"inserted={res.inserted} skipped_duplicate={res.skipped_duplicate} "
                f"rows_seen={res.rows_seen}"
            )
    return 0 if results else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
