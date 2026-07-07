"""BACK-1 — content-addressed cache for DETERMINISTIC LLM responses.

Why this exists
---------------
The generation gate runs the SAME deterministic solve / critique prompts over and
over (temp 0 + a fixed seed), and a resumed batch (BACK-3) re-issues prompts it
already answered. Re-running the local model for an identical (provider, model,
temperature, seed, prompt) wastes the slowest resource in the app — GPU inference.
A content-addressed cache turns the repeat into an O(1) lookup.

Host parity (CRITICAL)
----------------------
The host already content-addresses its own structured generations
(``src/lib/llm/determinism.js``: ``cacheKeyPreimage`` + ``CACHE_KEY_VERSION``).
The cache key MUST be byte-for-byte reproducible across host and backend so the
two agree on keys (a shared cache, and a detectable mismatch). This module
re-implements that frozen pre-image EXACTLY — see ``cache_key_preimage`` — and a
conformance test diffs it against the host's published vectors.

Determinism only
----------------
Only deterministic calls are cached: ``temperature == 0`` OR a pinned ``seed``.
A warm/creative call (no seed, temp > 0) is intentionally NOT cached — its output
is supposed to vary — so :func:`is_deterministic` gates every store/lookup.

Two tiers, both best-effort
---------------------------
- an in-process LRU (``_LRU``) is the hot tier — no DB round-trip on a repeat
  within a session;
- a SQLite ``LLMCacheEntry`` row is the durable tier so the cache survives a
  restart (and is shared by the request threads + the job worker).
Either tier failing is a no-op: a cache miss/insert that raises degrades to
"just call the model", never a crash.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional

_log = logging.getLogger("lsatlab.llm.cache")

# Mirror src/lib/llm/determinism.js CACHE_KEY_VERSION. Bump in BOTH places if the
# pre-image serialization below ever changes. Stale rows remain inert because
# the version tag is inside the hashed pre-image and new keys cannot match them.
CACHE_KEY_VERSION = 2

# In-memory LRU cap. Small: the durable SQLite tier is the real store; this is
# only the hot tier in front of it. Env-free (config.py is owned by another
# slice); a few hundred entries is plenty for a single study session.
_LRU_MAX = 512


def _canonical_number(value: object) -> str:
    """Host-parity numeric rendering for the key.

    Mirrors ``canonicalNumber`` in determinism.js: a FINITE number renders via
    its plain string form (``0`` -> "0", ``0.3`` -> "0.3", ``1311`` -> "1311");
    anything missing / non-finite -> "" (empty). An INTEGER-valued float renders
    WITHOUT a trailing ".0" (JS ``String(0)`` is "0", and so is ours) so e.g.
    ``temperature=0`` and ``temperature=0.0`` produce the SAME key as the host.
    """
    if value is None or isinstance(value, bool):
        # bool is an int subclass in Python; the host never passes a bool here,
        # and treating True/False as 1/0 would be a silent footgun, so -> "".
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):  # NaN/inf
            return ""
        if value.is_integer():
            return str(int(value))  # 0.0 -> "0" (matches JS String(0))
        return _float_str(value)
    return ""


def _float_str(value: float) -> str:
    """Render a non-integer float the way JS ``Number#toString`` would for the
    values we actually key on (small decimal temperatures like 0.3, 0.8).

    Python ``str(0.3)`` is "0.3" (shortest round-trip repr) and matches JS
    ``String(0.3)`` for these short decimals, so plain ``str`` is correct here.
    """
    return str(value)


def _str(value: object) -> str:
    """Host-parity ``str`` field: a string is trimmed; None -> ""; anything else
    is stringified then trimmed (mirrors determinism.js ``str``)."""
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def _contract_value(value: object) -> str:
    """Canonical rendering for output-affecting model contracts.

    ``system`` and ``format`` may contain newlines, equals signs, or JSON-schema
    dictionaries. Render them as compact JSON so the pre-image remains
    unambiguous and schema key ordering does not change the cache key.
    """
    if value is None:
        return ""
    try:
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if isinstance(value, (dict, list, tuple, bool, int, float)):
            return json.dumps(
                value,
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
    except (TypeError, ValueError):
        pass
    return json.dumps(str(value), ensure_ascii=False, separators=(",", ":"))


def cache_key_preimage(
    *,
    provider: object = None,
    model: object = None,
    system: object = None,
    format: object = None,
    temperature: object = None,
    top_p: object = None,
    seed: object = None,
    prompt: object = None,
) -> str:
    """The EXACT pre-image string SHA-256'd by :func:`cache_key`.

    Frozen contract — must equal ``cacheKeyPreimage`` in
    ``src/lib/llm/determinism.js`` byte-for-byte. Fields joined by a single
    newline, in THIS order, with the prompt LAST and verbatim::

        llm-cache
        v<CACHE_KEY_VERSION>
        provider=<provider>
        model=<model>
        system=<canonical system>
        format=<canonical response format/schema>
        temperature=<temperatureCanonical>
        top_p=<topPCanonical>
        seed=<seed>
        prompt=<prompt>

    Field rules (so host + backend agree byte-for-byte):
      - provider / model : trimmed string; missing -> "".
      - system / format  : JSON-canonical contract fields; missing -> "".
                           Dict/list schema values sort object keys recursively,
                           so semantically identical schemas share the same key.
      - temperature      : :func:`_canonical_number` (0 -> "0", 0.3 -> "0.3");
                           missing/non-finite -> "" so "no temperature" and
                           "temperature 0" are DISTINCT keys.
      - top_p            : :func:`_canonical_number`; missing -> "".
      - seed             : :func:`_canonical_number`; missing -> "".
      - prompt           : the full prompt VERBATIM (NOT trimmed — whitespace is
                           significant to the model and so to the key). Non-string
                           -> "". It is the LAST field, so a prompt containing
                           newlines or ``=`` can't be confused with a later field.
    """
    fields = [
        "llm-cache",
        f"v{CACHE_KEY_VERSION}",
        f"provider={_str(provider)}",
        f"model={_str(model)}",
        f"system={_contract_value(system)}",
        f"format={_contract_value(format)}",
        f"temperature={_canonical_number(temperature)}",
        f"top_p={_canonical_number(top_p)}",
        f"seed={_canonical_number(seed)}",
        f"prompt={prompt if isinstance(prompt, str) else ''}",
    ]
    return "\n".join(fields)


def cache_key(
    *,
    provider: object = None,
    model: object = None,
    system: object = None,
    format: object = None,
    temperature: object = None,
    top_p: object = None,
    seed: object = None,
    prompt: object = None,
) -> str:
    """Lowercase hex SHA-256 of :func:`cache_key_preimage` — the content key.

    Identical to ``cacheKey`` in determinism.js for the same inputs, so the host
    and backend produce the SAME 64-char key for the same logical call.
    """
    pre = cache_key_preimage(
        provider=provider, model=model, system=system, format=format,
        temperature=temperature, top_p=top_p, seed=seed, prompt=prompt,
    )
    return hashlib.sha256(pre.encode("utf-8")).hexdigest()


def is_deterministic(temperature: object, seed: object) -> bool:
    """A call is cacheable iff it is reproducible: temperature 0 OR a pinned seed.

    A warm call (seed=None and temperature > 0 / unset) is intentionally NOT
    cached because its output is meant to vary. ``temperature == 0`` is greedy
    decoding (deterministic on its own); a finite ``seed`` pins sampling.
    """
    if isinstance(seed, int) and not isinstance(seed, bool):
        return True
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        try:
            return float(temperature) == 0.0
        except (TypeError, ValueError):  # pragma: no cover - defensive
            return False
    return False


# --- counters (observability) ----------------------------------------------
_counter_lock = threading.Lock()
_hits = 0
_misses = 0
_stores = 0


def record_hit() -> None:
    global _hits
    with _counter_lock:
        _hits += 1


def record_miss() -> None:
    global _misses
    with _counter_lock:
        _misses += 1


def record_store() -> None:
    global _stores
    with _counter_lock:
        _stores += 1


def stats() -> dict:
    """Process-local cache counters for the observability surface (RAM-only,
    reset on restart, like the latency/contention gauges). ``hit_rate`` is over
    cacheable lookups (hits + misses); ``None`` until the first lookup."""
    with _counter_lock:
        hits, misses, stores = _hits, _misses, _stores
        lru = len(_LRU)
    total = hits + misses
    return {
        "hits": hits,
        "misses": misses,
        "stores": stores,
        "lookups": total,
        "hit_rate": round(hits / total, 4) if total else None,
        "lru_size": lru,
        "lru_max": _LRU_MAX,
        "key_version": CACHE_KEY_VERSION,
    }


def reset_stats() -> None:
    """Zero the counters AND the in-memory LRU. Test-only seam (the durable
    SQLite tier is unaffected; tests reset that by resetting the DB)."""
    global _hits, _misses, _stores
    with _counter_lock:
        _hits = _misses = _stores = 0
    with _lru_lock:
        _LRU.clear()


# --- in-memory LRU (hot tier) ----------------------------------------------
_LRU: "OrderedDict[str, str]" = OrderedDict()
_lru_lock = threading.Lock()


def _lru_get(key: str) -> Optional[str]:
    with _lru_lock:
        if key in _LRU:
            _LRU.move_to_end(key)
            return _LRU[key]
    return None


def _lru_put(key: str, value: str) -> None:
    with _lru_lock:
        _LRU[key] = value
        _LRU.move_to_end(key)
        while len(_LRU) > _LRU_MAX:
            _LRU.popitem(last=False)


# --- durable tier (SQLite) --------------------------------------------------
def _durable_get(key: str) -> Optional[str]:
    """Read the durable cache row for ``key`` and bump its hit bookkeeping.

    Best-effort: any DB error is swallowed (treated as a miss) so a cache problem
    never breaks generation. Uses a short-lived session off the shared engine so
    it works on both the request threads and the job worker thread.
    """
    try:
        from sqlmodel import Session, select

        from ..db import engine
        from ..models import LLMCacheEntry

        with Session(engine) as s:
            row = s.exec(
                select(LLMCacheEntry).where(LLMCacheEntry.cache_key == key)
            ).first()
            if row is None:
                return None
            row.hits = int(row.hits or 0) + 1
            row.last_hit_at = datetime.now(timezone.utc)
            s.add(row)
            s.commit()
            return row.response
    except Exception:  # noqa: BLE001 — cache must never break a model call
        _log.debug("llm cache durable get failed", exc_info=True)
        return None


def _durable_put(key: str, *, provider: str, model: str, response: str) -> None:
    """UPSERT the durable cache row for ``key`` (idempotent on the UNIQUE index).

    Best-effort: a write failure (locked table, race on the UNIQUE key) is logged
    and ignored — the in-memory tier still served/holds the value, and the next
    call simply re-computes. Never raises.
    """
    try:
        from sqlmodel import Session, select

        from ..db import engine
        from ..models import LLMCacheEntry

        with Session(engine) as s:
            existing = s.exec(
                select(LLMCacheEntry).where(LLMCacheEntry.cache_key == key)
            ).first()
            if existing is not None:
                # Already cached (a concurrent writer won the race) — keep the
                # first response; deterministic calls return the same text anyway.
                return
            s.add(LLMCacheEntry(
                cache_key=key,
                key_version=CACHE_KEY_VERSION,
                provider=provider or "",
                model=model or "",
                response=response,
            ))
            s.commit()
    except Exception:  # noqa: BLE001 — cache must never break a model call
        _log.debug("llm cache durable put failed", exc_info=True)


# --- public get/put (used by llm.offline_generate) --------------------------
def get(
    *,
    provider: str,
    model: str,
    temperature: object,
    seed: object,
    prompt: str,
    system: object = None,
    format: object = None,
    top_p: object = None,
) -> Optional[str]:
    """Return the cached response for a DETERMINISTIC call, or None.

    Non-deterministic calls return None WITHOUT touching the counters (they're
    not cacheable, so they don't belong in the hit-rate denominator). A cacheable
    miss records a miss; a hit (LRU or durable) records a hit and warms the LRU.
    """
    if not is_deterministic(temperature, seed):
        return None
    key = cache_key(
        provider=provider, model=model, system=system, format=format,
        temperature=temperature, top_p=top_p, seed=seed, prompt=prompt,
    )
    hit = _lru_get(key)
    if hit is not None:
        record_hit()
        return hit
    durable = _durable_get(key)
    if durable is not None:
        _lru_put(key, durable)
        record_hit()
        return durable
    record_miss()
    return None


def put(
    *,
    provider: str,
    model: str,
    temperature: object,
    seed: object,
    prompt: str,
    response: str,
    system: object = None,
    format: object = None,
    top_p: object = None,
) -> None:
    """Store a DETERMINISTIC call's response in both tiers (no-op otherwise).

    Skipped for non-deterministic calls and for an empty response (nothing worth
    caching; re-running may also be cheap/transient). Best-effort throughout.
    """
    if not is_deterministic(temperature, seed):
        return
    if not isinstance(response, str) or response == "":
        return
    key = cache_key(
        provider=provider, model=model, system=system, format=format,
        temperature=temperature, top_p=top_p, seed=seed, prompt=prompt,
    )
    _lru_put(key, response)
    _durable_put(key, provider=provider, model=model, response=response)
    record_store()
