// Wire-shape aliases sourced from the generated OpenAPI types (`api.gen.ts`).
//
// `api.gen.ts` is generated from a COMMITTED `openapi.json` snapshot and is the
// source of truth for request/response shapes going forward. Re-export the
// handful of schemas the client constructs (rather than importing the deep
// `components["schemas"]["…"]` path everywhere) so callers get a stable name and
// the build stays decoupled from a running backend.
//
// To regenerate after a backend contract change, run `npm run gen:api`
// (see package.json) — it re-dumps `openapi.json` and re-emits `api.gen.ts`.
import type { components } from "./api.gen";

type Schemas = components["schemas"];

/** 1.2 — one process-of-elimination interaction within an attempt. */
export type ChoiceEvent = Schemas["ChoiceEvent"];

/** Request body for POST /api/sessions/{id}/attempts (single, idempotent). */
export type AttemptCreateWire = Schemas["AttemptCreate"];

/** Request body for POST /api/sessions/{id}/attempts/batch. */
export type AttemptBatchWire = Schemas["AttemptBatch"];

/** 1.2 — the action a choice event records. */
export type ChoiceEventAction = "select" | "eliminate" | "restore";

/**
 * Per-item + summary result of the batch write. The endpoint returns plain
 * dicts (untyped in OpenAPI), so this mirrors the documented shape from
 * `app/routers/sessions.py::create_attempts_batch`.
 */
export interface AttemptBatchResult {
  results: {
    question_id: number;
    attempt_id: number | null;
    created: boolean;
    error?: string;
  }[];
  created: number;
  duplicates: number;
  total: number;
}
