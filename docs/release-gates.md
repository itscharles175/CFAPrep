# QuantVault Release Gates

QuantVault is a local-first CFA mastery app. A public-grade release must pass these gates from the repo root:

- `npm run release:gates` to run the executable gate suite and generate command-result metadata.
- `npm run verify` for lint, unit tests, TypeScript, and production build.
- `npm run audit` for production dependency vulnerabilities.
- `npm run content:validate` for content catalog, curriculum map, and Level I release gates.
- `npm run build && npm run bundle:report` for route bundle thresholds.
- `npm run smoke` for desktop route smoke coverage across learning, vault, analytics, tools, and system health surfaces.
- `npm run fresh-import:check` for export/import restore into a clean IndexedDB profile.
- `npm run content:report && npm run release:checklist` for generated release artifacts under `dist/reports/`, including `release-manifest.json`.

Level I saturation packs are currently structurally validated. They should not be called public exam-ready until template-generated provenance has been replaced with editorial-authored rows and the release report shows `exam-ready`.

The System Health page reads the generated release manifest when available and falls back to the same runtime release-health contract during local development.
