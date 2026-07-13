# LSATLab FastAPI Backend Deployment Readiness Audit

## Executive Summary

This audit covered `backend/app/**`, `backend/tests/**`, `backend/pyproject.toml`, and backend packaging files for a local-first, single-user Windows desktop deployment. The core architecture is aligned with that target: the packaged sidecar binds to `127.0.0.1` by default (`backend/app/sidecar_main.py:44`), SQLite is configured for WAL, foreign keys, and busy timeout on each connection (`backend/app/db.py:19`), startup runs integrity checks and orphan reconciliation (`backend/app/main.py:122`), and the bank portable export has a strong official-content firewall.

I found no P0 deployment blockers and no evidence that `/api/bank/export` leaks official LSAT content when called through the HTTP route. The main readiness risks are conditional but concrete: "local" LMStudio URLs are not constrained to loopback before realtime official prompts are sent, notebook URL import follows redirects before private-host validation, portable bank import is not atomic, cloud budget enforcement can overshoot, large PDF uploads are read into memory without a cap, and official previews depend on the backend staying loopback-only.

Verification limit: I could not run the backend test suite in this environment. The checked-in `.venv` launcher points at a missing Python 3.12 install, and `uv run` could not repair or redirect the environment because removal/creation operations were denied. The findings below are based on source and test inspection only.

## Severity Counts

- P0: 0
- P1: 6
- P2: 5

## Official-Content Firewall Assessment

`/api/bank/export` does not appear to leak official LSAT content. The HTTP route hardcodes `include_official=False` (`backend/app/routers/dataset_routes.py:381`), and the exporter skips official PrepTests (`backend/app/bank_export.py:141`), official questions (`backend/app/bank_export.py:157`), passages not referenced by exportable questions (`backend/app/bank_export.py:166`), attempts/sessions tied only to non-exportable official questions (`backend/app/bank_export.py:236`), and official question embeddings or note vectors tied to official attempts (`backend/app/bank_export.py:315`). The regression tests use an official sentinel and assert that the default export and HTTP export do not contain it (`backend/tests/test_bank_export.py:151`, `backend/tests/test_bank_export.py:218`).

Full SQLite backups intentionally contain the local database, including official content, but the backup manifest labels the portable export as the sanitized path and states that official content should not leave the machine (`backend/app/backup.py:373`). Notebook exports also redact official-firewalled artifact bodies (`backend/app/notebook_os.py:1743`), with tests covering official import/export redaction (`backend/tests/test_notebook_os_expansion.py:416`, `backend/tests/test_notebook_os_expansion.py:614`). The remaining official-content risk is not `/api/bank/export`; it is that local browse/realtime routes can expose official snippets if the unauthenticated sidecar is ever bound off-loopback, covered as a P1 finding below.

## P0 Findings

None found.

## P1 Findings

### 1. LMStudio URL can route realtime official prompts to an arbitrary HTTP endpoint

Severity: P1

Evidence: `lmstudio_url` is accepted as a plain string in settings (`backend/app/routers/settings_routes.py:31`), and the settings validators only check provider name and retention bounds, not URL host/scheme (`backend/app/settings_store.py:50`). `local_provider()` selects LMStudio when configured (`backend/app/llm/__init__.py:68`), realtime explanations send the question prompt through that provider (`backend/app/ai.py:157`), and the explanation prompt includes stem, prompt, choices, and the correct answer (`backend/app/ai.py:177`). LMStudio then posts to the configured base URL (`backend/app/llm/lmstudio.py:43`, `backend/app/llm/lmstudio.py:113`).

Why it matters: The app treats LMStudio as a local provider, but the persisted setting can point to a non-local URL. A misconfiguration or malicious local settings write could send official LSAT content from realtime explain flows off-device, bypassing the intended rule that cloud is optional, offline-only, and never realtime.

Suggested fix: Validate `lmstudio_url` before saving and before provider construction. Default should allow only loopback hosts such as `localhost`, `127.0.0.1`, and `::1`, with no credentials and only expected paths. If remote LMStudio is ever desired, require an explicit env-only override such as `LSATLAB_ALLOW_REMOTE_LLM=1`, display a local warning, and add tests proving official realtime content cannot leave under default settings.

### 2. Notebook URL import follows redirects before private-host validation

Severity: P1

Evidence: `source_from_url()` validates the initially supplied hostname (`backend/app/notebook_os.py:480`), then performs `httpx.Client(timeout=12, follow_redirects=True).get(url)` (`backend/app/notebook_os.py:489`), and validates the final host only after the request has completed (`backend/app/notebook_os.py:495`). `_validate_public_url()` blocks localhost and private/link-local/reserved IP ranges (`backend/app/notebook_os.py:518`), and tests cover direct private URLs (`backend/tests/test_notebook_os_expansion.py:674`).

Why it matters: A public URL can redirect to `http://127.0.0.1`, a LAN host, or another private address. The app may reject the response after the redirect, but the private request has already been sent. That is SSRF behavior, even if content is not returned to the caller.

Suggested fix: Disable automatic redirects. Follow redirects manually, validating every `Location` target before the next request. Also consider pinning the resolved IP used for the request or using a transport/resolver guard so DNS rebinding cannot pass validation and then connect to a private address. Add tests for public-to-private redirects.

### 3. Portable bank import is not atomic and can leave the import ledger inaccurate

Severity: P1

Evidence: `/api/bank/import-backup` creates an `ImportRun`, commits it, then calls `bank_export.import_bank()` (`backend/app/routers/dataset_routes.py:400`). The route only catches `ValueError` for newer-schema rejection (`backend/app/routers/dataset_routes.py:419`) and marks success afterward (`backend/app/routers/dataset_routes.py:425`). Inside the importer, helper functions commit incrementally while ensuring PrepTests, sections, and questions (`backend/app/bank_export.py:445`, `backend/app/bank_export.py:465`, `backend/app/bank_export.py:506`, `backend/app/bank_export.py:521`), and user data import also commits in phases (`backend/app/bank_export.py:717`, `backend/app/bank_export.py:754`, `backend/app/bank_export.py:803`, `backend/app/bank_export.py:832`).

Why it matters: A malformed portable JSON file can partially write PrepTests, sections, questions, sessions, attempts, or user data before a later error. Non-`ValueError` failures can also leave the `ImportRun` stuck in `committing` or incorrectly reported. Dataset import has an atomic rollback path, but portable bank import does not.

Suggested fix: Make portable bank import a single transaction. Replace internal `commit()` calls with `flush()` where IDs are needed, wrap the whole import in `session.begin_nested()` or an explicit transaction, and catch broad exceptions in the route to rollback and mark the run failed or rolled back. Add a regression test with a malformed later record proving no earlier records remain.

### 4. Cloud monthly budget can be exceeded by one call and ledger write failures undercount spend

Severity: P1

Evidence: The cloud budget comment says the app refuses cloud generation once month-to-date spend would exceed the configured limit (`backend/app/config.py:288`). The actual check reads current spend and allows the call when `spend < budget` (`backend/app/llm/__init__.py:108`, `backend/app/llm/__init__.py:121`), then offline generation calls Anthropic (`backend/app/llm/__init__.py:155`). Actual usage is recorded only after the response (`backend/app/llm/cloud.py:125`), and `persist_cloud_usage()` is best-effort: on write failure it rolls back and returns `0` (`backend/app/observability.py:242`).

Why it matters: A single large request can push spend over the configured monthly budget because there is no pre-call estimate or reservation. If usage persistence fails after a paid call, future budget checks can undercount real spend and keep allowing calls.

Suggested fix: Before cloud calls, estimate worst-case cost from prompt size, requested `max_tokens`, and configured per-token prices, then require `spend + estimate <= budget`. For budgeted cloud usage, persist a reservation or pending ledger row before the call in a transaction, reconcile it after the response, and fail closed if ledger writes fail.

### 5. PDF parse endpoint reads the entire upload into memory without a size cap

Severity: P1

Evidence: `/api/import/parse` reads the complete uploaded PDF with `data = await file.read()` (`backend/app/routers/import_routes.py:63`) before calling the parser (`backend/app/routers/import_routes.py:75`). By contrast, notebook source uploads enforce `MAX_SOURCE_UPLOAD_BYTES` before parsing (`backend/app/notebook_os.py:450`, `backend/app/notebook_os.py:459`).

Why it matters: A large or accidental scanned PDF can consume sidecar memory before validation. In a single-user desktop app this is not a remote abuse scenario by default, but it can still hang or crash the local backend during normal daily use.

Suggested fix: Add a maximum upload size for PDF import, return HTTP 413 for oversized files, and stream to a temp file or bounded buffer. Reuse the notebook upload cap if appropriate, or define a dedicated PDF cap in config.

### 6. Official browse previews rely on strict loopback binding, but host override is not guarded

Severity: P1

Evidence: The sidecar host can be set by CLI or `LSATLAB_HOST` (`backend/app/sidecar_main.py:44`) and is passed directly to uvicorn (`backend/app/sidecar_main.py:76`). CORS limits browser origins but is not authentication (`backend/app/main.py:255`). The dataset question listing route returns local question previews, including `stem_preview` and `prompt_preview`, without filtering out official source rows (`backend/app/routers/dataset_routes.py:66`, `backend/app/routers/dataset_routes.py:96`).

Why it matters: Under the default `127.0.0.1` binding, this is expected local UI behavior. If the backend is accidentally started on `0.0.0.0` or a LAN address, unauthenticated API callers could read official-content previews and other local study data. That would turn local browse routes into a content leak even though `/api/bank/export` is safe.

Suggested fix: Reject non-loopback bind hosts by default in `sidecar_main.py`, or require an explicit `LSATLAB_ALLOW_REMOTE_API=1` override with a loud startup warning. If remote binding is ever supported, add authentication and avoid returning official previews without an explicit local reveal gate.

## P2 Findings

### 7. Backup restore maps invalid or corrupt backups to HTTP 404

Severity: P2

Evidence: `restore_backup()` raises `ValueError` for invalid backup names, failed integrity checks, and failed foreign-key checks (`backend/app/backup.py:969`, `backend/app/backup.py:975`, `backend/app/backup.py:979`). The restore route catches any `ValueError` and returns `404 backup_not_found` (`backend/app/routers/backup_routes.py:52`).

Why it matters: A corrupt backup or invalid path is operationally different from a missing backup. Returning 404 hides the correct recovery action and weakens the local restore workflow.

Suggested fix: Use typed exceptions or inspect the failure reason. Return 400 for invalid names, 404 for missing snapshots, and 409 or 422 for integrity/FK failures. Add route tests for each case.

### 8. OpenAPI coverage is present but too broad to catch response drift

Severity: P2

Evidence: Custom OpenAPI generation injects a broad `LegacySuccessResponse` schema (`backend/app/main.py:313`) and then adds it to many 200 responses (`backend/app/main.py:338`). The contract test checks that `/api` routes have schemas and standard error envelopes (`backend/tests/test_openapi_contract.py:28`), but the backend audit did not find a committed backend OpenAPI snapshot. Packaging only includes a frontend OpenAPI artifact if present (`backend/lsatlab.spec:86`).

Why it matters: The current OpenAPI gate proves that schemas exist, but a very broad `anyOf` success schema can hide route-level drift and serialization mismatches. That matters for a Tauri frontend that depends on stable local API contracts.

Suggested fix: Generate and commit a backend OpenAPI snapshot as part of the backend gate, compare it in tests, and replace legacy fallback success schemas with precise `response_model` coverage on high-use routes first.

### 9. LMStudio timeout and keep-alive behavior is inconsistent with Ollama

Severity: P2

Evidence: Ollama embeddings use `config.EMBED_REQUEST_TIMEOUT_S` (`backend/app/llm/ollama.py:147`), while LMStudio embeddings hardcode `timeout=30.0` (`backend/app/llm/lmstudio.py:168`). Ollama also implements `set_keep_alive()` (`backend/app/llm/ollama.py:122`); LMStudio has no equivalent in the inspected provider. I did not find a current backend caller that requires `set_keep_alive`, so this is not a functional break today.

Why it matters: Local model resource behavior is harder to tune consistently across providers. If the app later adds warm/unload controls or relies on configured embedding timeouts, LMStudio will behave differently from Ollama.

Suggested fix: Use `config.EMBED_REQUEST_TIMEOUT_S` in LMStudio embeddings. Add a provider-level optional keep-alive/unload interface with a no-op default so future calls are explicit and tested across both providers.

### 10. Production foreign-key behavior is under-tested by the default backend fixtures

Severity: P2

Evidence: Test setup sets `LSATLAB_SQLITE_FK=0` before importing the app (`backend/tests/conftest.py:14`), while production config defaults SQLite foreign keys on (`backend/app/config.py:56`) and the DB connection hook enforces `PRAGMA foreign_keys=ON` when enabled (`backend/app/db.py:33`).

Why it matters: The test suite can miss failures that only occur with production FK enforcement, especially in import, restore, cascade-delete, and worker reconciliation flows. This is important because the owner will rely on the local database daily.

Suggested fix: Keep fast loose fixtures if needed, but add a small FK-on integration suite or release gate that runs import/export, backup/restore, parse commit, and job reconciliation with `LSATLAB_SQLITE_FK=1`.

### 11. Deduplication indexes can be skipped if legacy duplicates already exist

Severity: P2

Evidence: Migration 6 checks for duplicate `content_hash` and `external_id` values before creating unique partial indexes (`backend/app/migrations.py:203`). If duplicates exist, it logs a warning and skips index creation (`backend/app/migrations.py:217`, `backend/app/migrations.py:220`).

Why it matters: A legacy database with duplicates can continue running without the intended uniqueness protection. In normal single-process use this may be tolerable, but request handlers and the job worker can still create concurrent writes, and app-level dedup checks are not as strong as database constraints.

Suggested fix: Add a readiness check that fails or warns prominently when these unique indexes are missing. Prefer a repair migration that quarantines or merges duplicates, then creates the indexes, rather than silently leaving the DB weaker.

