/**
 * QA-4 — the vendored LSAT domain is now a typed project reference.
 *
 * Previously this file declared `@lsat/*` as an ambient module, which resolved
 * every cross-domain import to `any` so the host's strict `tsc` never pulled the
 * subtree in. That blanket `any` is gone: the host `tsconfig.json` now maps
 * `@lsat/*` to `src/domains/lsat/*` (with a `references` entry to
 * `tsconfig.lsat.json`, the subtree's own strict project), so cross-domain
 * imports resolve to the REAL subtree types and are type-checked end-to-end.
 *
 * Type-safety inside the subtree itself remains owned by `tsconfig.lsat.json`
 * (run via `npx tsc -p tsconfig.lsat.json`); see TESTING.md for the two-project
 * layout. This file is intentionally left as documentation only — no ambient
 * `declare module` — so nothing silently degrades a cross-domain import to `any`.
 */
export {};
