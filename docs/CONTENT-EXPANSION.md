# Content Expansion — Pillar 10

`npm run content:expand` bulk-generates AI questions + flashcards for every
(level, topic) combo that has ingested curriculum, then writes them to
`public/cfa-generated.json`. On the next browser load, `bootstrapAiContent`
seeds those into the same `db.settings` caches the in-app AI panels use, so
the user sees populated questions + flashcards immediately rather than paying
LLM generation latency on every visit.

Fully offline: the script never reaches outside `localhost`.

## Why

The hand-authored Level I packs are deep; Level II and III packs are thinner.
Rather than hand-authoring hundreds more items, run the LLM over the user's
ingested curriculum once and ship the cached output as a side bundle.

## Run it

```bash
# Make sure your local model server is up (LM Studio or Ollama).
# LM Studio:  load gemma-4-e4b-it at -c 32768 and serve on :1234/v1.
# Ollama:     ollama pull gemma4:e4b && ollama serve (with OLLAMA_ORIGINS=*).

# Generate for all 3 levels, 5 questions + 8 flashcards per topic:
npm run content:expand

# Preview the plan without calling the model or writing anything:
npm run content:expand -- --dry-run

# Only Level 2 + 3, more flashcards per topic, into a custom output:
npm run content:expand -- --levels level2,level3 --flashcards 12 --out public/cfa-generated.json

# Use Ollama instead of LM Studio:
npm run content:expand -- --base-url http://localhost:11434/v1 --model llama3.1

# Skip topics already in the existing output (resume a long run):
npm run content:expand -- --skip-existing
```

The script writes the output after every topic completes, so a long run can
be interrupted (Ctrl-C) without losing earlier work.

## Output shape

```json
{
  "app": "QuantVault",
  "kind": "cfa-generated-content",
  "bundleVersion": 1,
  "generatedAt": "2026-05-28T01:23:45.000Z",
  "model": "gemma-4-e4b-it",
  "baseUrl": "http://localhost:1234/v1",
  "byTopic": {
    "level2": {
      "fixed-income": {
        "title": "Fixed Income",
        "questions": [{ "id": "ai-1", "question": "...", "options": [...], "correct": 1, "explanation": "..." }],
        "flashcards": [{ "id": "flash-1", "front": "...", "back": "...", "locator": "p.10" }],
        "sourceChunkCount": 14,
        "generatedAt": "2026-05-28T01:23:00.000Z"
      }
    }
  }
}
```

The browser app reads this via `bootstrapAiContent.js` on startup and writes
to `db.settings` under `ai-questions:<level>:<topic>` and
`flash-cards:<level>:<topic>` — the same keys the CfaModule AI-practice and
AI-flashcards panels already look up. The bootstrap is idempotent: it skips
any (level, topic) where the user has generated their own content, and a
per-bundle marker stops it from re-running on every page load.

## Caveats

- **Quality depends on the model.** Gemma 4 E4B at 32 K context produces
  reasonable exam-prep items; smaller or untuned models will produce drift.
  Review the generated bundle before committing it to `public/`.
- **The source bundle is the truth.** Output is only as good as the chunks
  in `public/cfa-source.qvsource`. If a topic has no chunks (e.g., L3 is
  not yet ingested), no content is generated for it — that's by design.
- **Generated content is grounded.** Prompts include the curriculum
  excerpts and tell the model to use ONLY those excerpts. Items occasionally
  miss the locator or misnumber the correct option; the validator
  (`extractJsonArray` + filters) drops malformed entries.
- **Not a substitute for ingestion.** Run `cfa:source:ingest` first to
  populate the bundle from your PDF folder; otherwise `content:expand` has
  nothing to work from.

## See also

- `scripts/cfa-source-vault.mjs` — the source-ingestion CLI that produces
  `public/cfa-source.qvsource` (the input here).
- `src/lib/bootstrapAiContent.js` — the runtime loader.
- `src/lib/localLlm.js` — the in-app counterpart helpers
  (`generateQuestionsFromCurriculum`, `generateFlashcardsFromCurriculum`)
  that this script mirrors.
