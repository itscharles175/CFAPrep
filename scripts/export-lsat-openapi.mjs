#!/usr/bin/env node
/*
 * Export + drift-gate the LSAT backend's OpenAPI contract (Roadmap DATA-1, K1).
 *
 * The host↔sidecar boundary is the integration spine: `src/lib/lsatBackend.ts`
 * and `src/lib/lsatReviewBridge.ts` (and the LSAT domain's generated
 * `src/domains/lsat/lib/api.gen.ts`) all speak the contract this script freezes.
 * A committed `services/lsat-backend/openapi-baseline.json` snapshot lets CI catch
 * a `/api/srs/due` rename — or any removed path/field — at build time instead of
 * at runtime against a dead fetch.
 *
 * OFFLINE + npm-FREE invocation. We never boot the server or hit the network:
 * we import the FastAPI app in-process and call `app.openapi()`, exactly the way
 * `npm run gen:api:dump` does, but driving the backend's own interpreter so this
 * runs in a checkout with no Python on PATH and no extra npm dep:
 *
 *     services/lsat-backend/.venv-lsat/Scripts/python.exe -c \
 *       "import json,sys; from app.main import app; json.dump(app.openapi(), sys.stdout)"
 *
 * (cwd = services/lsat-backend so `app` resolves; the venv lives at the repo root
 * as `.venv-lsat`, hence the `../../` hop from the backend dir.)
 *
 * Usage:
 *   node scripts/export-lsat-openapi.mjs            # write the baseline if absent,
 *                                                   # else diff against it
 *   node scripts/export-lsat-openapi.mjs --write    # (re)write the baseline snapshot
 *   node scripts/export-lsat-openapi.mjs --check     # diff only; never write
 *   node scripts/export-lsat-openapi.mjs --python <path-to-python>
 *
 * Exit codes: 0 = baseline written, or live spec is a backward-COMPATIBLE
 * superset of the baseline (additive diffs are fine); 1 = a BREAKING diff
 * (removed path, removed method, or removed/narrowed response field) — the gate
 * fails; 2 = could not produce the spec (backend import error, missing venv).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BACKEND_DIR = join(REPO_ROOT, 'services', 'lsat-backend');
const BASELINE_PATH = join(BACKEND_DIR, 'openapi-baseline.json');
// audit M18 — the typed client's codegen INPUT. api.gen.ts is generated from this
// file (openapi-typescript). The `--client` mode below fails when this snapshot is
// behind the live backend, so the client can't silently rot 41 paths behind again.
const CLIENT_SPEC_PATH = join(REPO_ROOT, 'src', 'domains', 'lsat', '_meta', 'openapi.json');

/** The backend's own interpreter, relative to the backend dir (see header). */
function defaultPython() {
  const rel = process.platform === 'win32'
    ? join('..', '..', '.venv-lsat', 'Scripts', 'python.exe')
    : join('..', '..', '.venv-lsat', 'bin', 'python');
  return rel;
}

function parseArgs(argv) {
  const out = { mode: 'sync', python: defaultPython() };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === '--write') out.mode = 'write';
    else if (a === '--check') out.mode = 'check';
    else if (a === '--client') out.mode = 'client';
    else if (a === '--write-client') out.mode = 'write-client';
    else if (a === '--python') out.python = rest.shift();
    else {
      console.error(`export-lsat-openapi: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Drive the backend interpreter to dump `app.openapi()` as JSON on stdout. Runs
 * with cwd = the backend dir so `from app.main import app` resolves the package.
 */
function dumpLiveSpec(python) {
  const py = [
    'import json,sys',
    '_contract_stdout=sys.stdout',
    'sys.stdout=sys.stderr',
    'from app.main import app',
    'sys.stdout=_contract_stdout',
    'json.dump(app.openapi(), sys.stdout)',
  ].join('; ');
  const res = spawnSync(python, ['-c', py], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`export-lsat-openapi: could not launch python (${python}): ${res.error.message}`);
    console.error('  Did the backend venv get created? Expected .venv-lsat at the repo root.');
    process.exit(2);
  }
  if (res.status !== 0) {
    console.error(`export-lsat-openapi: python exited ${res.status} while dumping the spec.`);
    if (res.stderr) console.error(res.stderr.trim());
    process.exit(2);
  }
  let spec;
  try {
    spec = JSON.parse(res.stdout);
  } catch (err) {
    console.error(`export-lsat-openapi: spec stdout was not valid JSON — ${err.message}`);
    process.exit(2);
  }
  if (!spec || typeof spec !== 'object' || !spec.paths) {
    console.error('export-lsat-openapi: dumped spec has no `paths` — refusing to use it.');
    process.exit(2);
  }
  return spec;
}

/** Stable, 2-space JSON with a trailing newline (matches the repo's JSON style). */
function serialize(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

/**
 * Walk every schema reachable from a response/component, resolving `$ref`s into
 * `components.schemas`, and collect the set of object property names that the
 * baseline guaranteed. A name disappearing from the live spec is a breaking
 * removal a host caller may already read. `allOf`/`oneOf`/`anyOf` and array
 * `items` are descended; `$ref` cycles are guarded by a visited set.
 */
function collectFieldNames(node, schemas, into, seenRefs) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectFieldNames(item, schemas, into, seenRefs);
    return;
  }
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    const name = ref.replace('#/components/schemas/', '');
    collectFieldNames(schemas[name], schemas, into, seenRefs);
    return;
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const prop of Object.keys(node.properties)) into.add(prop);
    for (const value of Object.values(node.properties)) {
      collectFieldNames(value, schemas, into, seenRefs);
    }
  }
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(node[key])) collectFieldNames(node[key], schemas, into, seenRefs);
  }
  if (node.items) collectFieldNames(node.items, schemas, into, seenRefs);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    collectFieldNames(node.additionalProperties, schemas, into, seenRefs);
  }
}

/** Field-name set for one operation's 2xx response body (the host-read surface). */
function responseFields(op, schemas) {
  const into = new Set();
  const responses = op?.responses || {};
  for (const code of Object.keys(responses)) {
    if (!/^2\d\d$/.test(code)) continue;
    const content = responses[code]?.content || {};
    for (const media of Object.values(content)) {
      collectFieldNames(media?.schema, schemas, into, new Set());
    }
  }
  return into;
}

/**
 * Diff the live spec against the committed baseline. Returns `{ breaking[],
 * additive[] }`. Breaking = a removed path, a removed method on a kept path, or
 * a 2xx response field the baseline exposed that the live spec dropped. Adding
 * paths/methods/fields is additive (always allowed).
 */
function diffContract(baseline, live) {
  const breaking = [];
  const additive = [];
  const baseSchemas = baseline.components?.schemas || {};
  const liveSchemas = live.components?.schemas || {};
  const basePaths = baseline.paths || {};
  const livePaths = live.paths || {};

  for (const path of Object.keys(basePaths)) {
    if (!(path in livePaths)) {
      breaking.push(`removed path: ${path}`);
      continue;
    }
    const baseOps = basePaths[path];
    const liveOps = livePaths[path];
    for (const method of Object.keys(baseOps)) {
      if (method === 'parameters') continue;
      if (!(method in liveOps)) {
        breaking.push(`removed method: ${method.toUpperCase()} ${path}`);
        continue;
      }
      const baseFields = responseFields(baseOps[method], baseSchemas);
      const liveFields = responseFields(liveOps[method], liveSchemas);
      for (const field of baseFields) {
        if (!liveFields.has(field)) {
          breaking.push(`removed response field "${field}" from ${method.toUpperCase()} ${path}`);
        }
      }
    }
  }

  for (const path of Object.keys(livePaths)) {
    if (!(path in basePaths)) {
      additive.push(`new path: ${path}`);
      continue;
    }
    for (const method of Object.keys(livePaths[path])) {
      if (method === 'parameters') continue;
      if (!(method in basePaths[path])) {
        additive.push(`new method: ${method.toUpperCase()} ${path}`);
      }
    }
  }

  return { breaking, additive };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const live = dumpLiveSpec(args.python);
  const liveJson = serialize(live);

  // audit M18 — refresh the typed client's codegen input from the live spec.
  // `npm run gen:api` runs this then openapi-typescript to regenerate api.gen.ts.
  if (args.mode === 'write-client') {
    writeFileSync(CLIENT_SPEC_PATH, liveJson);
    console.log(
      `export-lsat-openapi: wrote client spec (${Object.keys(live.paths).length} paths) → ${CLIENT_SPEC_PATH}`,
    );
    process.exit(0);
  }

  // audit M18 — client-drift gate. Fail when the committed client spec is BEHIND
  // the backend (a backend path the client codegen never saw). The original gate
  // only diffed live-vs-backend-baseline, so the client could (and did) rot 41
  // paths behind invisibly — a backend field RENAME on those routes shipped green.
  if (args.mode === 'client') {
    if (!existsSync(CLIENT_SPEC_PATH)) {
      console.error(`export-lsat-openapi: --client requires ${CLIENT_SPEC_PATH}. Run \`npm run gen:api\`.`);
      process.exit(2);
    }
    let clientSpec;
    try {
      clientSpec = JSON.parse(readFileSync(CLIENT_SPEC_PATH, 'utf8'));
    } catch (err) {
      console.error(`export-lsat-openapi: client spec is not valid JSON — ${err.message}`);
      process.exit(2);
    }
    const livePaths = Object.keys(live.paths || {});
    const clientPaths = new Set(Object.keys(clientSpec.paths || {}));
    const missing = livePaths.filter((p) => !clientPaths.has(p));
    if (missing.length) {
      console.error(`export-lsat-openapi: the typed client is ${missing.length} path(s) BEHIND the backend:`);
      for (const m of missing) console.error(`  - ${m}`);
      console.error('');
      console.error('  Regenerate the client: `npm run gen:api`, then commit');
      console.error('  src/domains/lsat/_meta/openapi.json + src/domains/lsat/lib/api.gen.ts.');
      process.exit(1);
    }
    console.log(
      `export-lsat-openapi: typed client is current (${clientPaths.size} client paths cover all ${livePaths.length} backend paths).`,
    );
    process.exit(0);
  }

  const baselineExists = existsSync(BASELINE_PATH);

  if (args.mode === 'write' || (args.mode === 'sync' && !baselineExists)) {
    writeFileSync(BASELINE_PATH, liveJson);
    const pathCount = Object.keys(live.paths).length;
    console.log(
      `export-lsat-openapi: wrote baseline (${pathCount} paths, OpenAPI ${live.openapi}) → ${BASELINE_PATH}`,
    );
    process.exit(0);
  }

  if (!baselineExists) {
    console.error(`export-lsat-openapi: --check requires an existing baseline at ${BASELINE_PATH}.`);
    console.error('  Run `node scripts/export-lsat-openapi.mjs --write` to create it.');
    process.exit(2);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`export-lsat-openapi: baseline is not valid JSON — ${err.message}`);
    process.exit(2);
  }

  const { breaking, additive } = diffContract(baseline, live);

  if (breaking.length) {
    console.error('export-lsat-openapi: BREAKING contract drift detected:');
    for (const b of breaking) console.error(`  - ${b}`);
    console.error('');
    console.error('  A removed path/method/field breaks an existing host consumer. If this');
    console.error('  removal is intentional, update the host client + regenerate api.gen.ts,');
    console.error('  then re-baseline with `node scripts/export-lsat-openapi.mjs --write`.');
    process.exit(1);
  }

  if (additive.length) {
    console.log(`export-lsat-openapi: ${additive.length} additive change(s) (compatible):`);
    for (const a of additive) console.log(`  + ${a}`);
    console.log('  Re-baseline with `--write` to record them.');
  } else if (liveJson === serialize(baseline)) {
    console.log('export-lsat-openapi: contract matches the baseline exactly.');
  } else {
    console.log('export-lsat-openapi: no path/method/field removals (compatible).');
  }
  process.exit(0);
}

main();
