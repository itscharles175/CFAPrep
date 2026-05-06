# QuantVault Release Gates

QuantVault is a local-first CFA mastery app. A public-grade release must pass these gates from the repo root:

- `npm run release:gates` to run the executable gate suite and generate command-result metadata.
- `npm run verify` for lint, unit tests, TypeScript, and production build.
- `npm run audit` for production dependency vulnerabilities.
- `npm run content:validate` for content catalog, curriculum map, and strict Level I/II/III editorial gates.
- `npm run build && npm run bundle:report` for route bundle thresholds.
- `npm run smoke` for desktop route smoke coverage across learning, vault, analytics, tools, and system health surfaces.
- `npm run browser:regression` for production-preview CFA async loading, Level II/III case flows, mock resume, offline reload, and PWA update prompt coverage.
- `npm run visual:regression` for desktop/mobile screenshot-route checks against blank frames and obvious overflow.
- `npm run a11y:check` for serious/critical axe checks across the same screenshot route manifest.
- `npm run fresh-import:check` for export/import restore into a clean IndexedDB profile.
- `npm run content:report && npm run release:checklist` for generated release artifacts under `dist/reports/`, including `release-manifest.json`.

Level I, Level II, and Level III are active all-or-nothing public gates. A level can be called exam-ready only when every active topic pack has original learner-facing rows, `generatedFromTemplate: false`, reviewer/date provenance, promotion evidence, zero template rows, zero missing evidence, and a release report status of `exam-ready`.

Level III uses the six active topics in the current QuantVault taxonomy: Ethics, Asset Allocation, Portfolio Construction, Performance Measurement, Derivatives And Risk Management, and Portfolio Management Pathway. Future taxonomy expansion should land as diagnostics until a new all-or-nothing authoring gate is opened.

The System Health page reads the generated release manifest when available and falls back to the same runtime release-health contract during local development. Release gate definitions live in `src/lib/releaseGateManifest.ts`; update that manifest first when adding, removing, or renaming a gate so scripts, docs, checklist output, and UI stay aligned.
