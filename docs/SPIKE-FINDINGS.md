# Wave-0 Spike Findings (2026-05-27)

De-risking spike for the desktop / embedded-open-notebook / SurrealDB / Gemma 4 E4B architecture.
**Result: every layer of the maximal-ambition stack runs locally & offline, and a full RAG answer
was produced end-to-end through open-notebook.**

## Proven

| Layer | Evidence |
|---|---|
| Native toolchain | Rust 1.95 / cargo / MSVC fetch + compile + link → Tauri buildable |
| Vector DB | SurrealDB **v2.6.5** binary runs (open-notebook needs v2, NOT v3) |
| Notebook backend | Forked open-notebook (`uv sync`) → FastAPI on :5055, 77 endpoints, auto-migrated SurrealDB to v14 |
| Job worker | `surreal-commands-worker --import-modules commands` (separate process, like Docker supervisord) |
| Local model | LM Studio `gemma-4-e4b-it` (chat) + `text-embedding-nomic-embed-text-v1.5` (embed), OpenAI-compatible :1234 |
| RAG end-to-end | Notebook → text source → worker-embedded → `/api/search/ask/simple` → 200 + cited, accurate answer |

## Gotchas (carry into the real build)

- **Two processes, not one:** must run the API (`run_api.py`) AND the worker; embedding/podcasts are queued jobs.
- **Windows console encoding:** worker (rich) crashes printing emoji on cp1252 → set `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`.
- **SurrealDB v2, not v3:** open-notebook pins `surrealdb:v2`; v3 has breaking changes.
- **LM Studio context window:** models load with a small default (4096) → "context size exceeded" on synthesis. Use `lms load gemma-4-e4b-it -c 32768` (Gemma 4 E4B supports 128K). A 32K load + ingesting the duration-module pages produced a polished, cited modified-duration answer.
- **open-notebook wiring:** provider `openai_compatible`, credential `base_url=http://localhost:1234/v1`; register a `language` model + an `embedding` model; set defaults; then notebook → source(embed=true) → ask.

## Repro (bare-metal, pre-Tauri)

```
# 1. SurrealDB v2
spike/bin/surreal2.exe start --user root --pass root rocksdb:spike/surreal_data/db
# 2. open-notebook API  (env in spike/open-notebook/.env)
uv run --directory spike/open-notebook python run_api.py
# 3. job worker
PYTHONUTF8=1 uv run --directory spike/open-notebook --env-file spike/open-notebook/.env surreal-commands-worker --import-modules commands
# 4. LM Studio: lms load gemma-4-e4b-it -c 32768
# 5. wire + ask:  python spike/onb-ask-final.py
```

## Next: Wave 0 — Tauri shell that supervises these three sidecars + the QuantVault UI as the webview.
