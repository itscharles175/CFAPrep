#!/usr/bin/env node
/*
 * GAP-EGRESS-1 — build-time static "no-cloud" gate (StudyVault stack-upgrade W1).
 *
 * StudyVault's central invariant is "works on a plane": no cloud, no telemetry,
 * no account. Today that invariant is CONVENTION, not enforced — a stray
 * `fetch('https://…')` in shipped source would compile, build, and ship green,
 * silently breaking offline-only operation. This is the gate that makes the
 * invariant real: a conservative static scan of the SHIPPED runtime source —
 * the host app (`src/`) and the LSAT backend (`services/lsat-backend/app/`) —
 * that FAILS the build when it finds non-loopback network egress OUTSIDE an
 * explicit, documented allowlist.
 *
 * What counts as egress (flagged): a non-loopback `https://HOST/…` /
 * `http://HOST/…` URL that is ACTUALLY USED AS A NETWORK ENDPOINT — i.e. it is
 *   - the argument of a network primitive on the same line — `fetch(…)`,
 *     `httpx.<verb>(…)`, `client.<verb>(…)`, `requests.<verb>(…)`,
 *     `new WebSocket(…)`, `new EventSource(…)`, `XMLHttpRequest`/`.open(…)`,
 *     `axios(…)`, `sendBeacon(…)`, or
 *   - assigned to an endpoint-shaped constant (`…_URL`, `…_API`, `…_ENDPOINT`,
 *     `baseUrl`, `base_url`) that the call sites then fetch.
 *
 * The allowlist is the ONE intentional, opt-in cloud path plus the research
 * dataset-import egress the product deliberately ships (all behind explicit user
 * action), each documented inline below. Doc / test / fixture files are skipped
 * wholesale — they describe or exercise egress, they don't perform it.
 *
 * Design bias: LOW false positives. We deliberately do NOT flag the many
 * non-network URL literals shipped source legitimately contains:
 *   - XML / SVG / OOXML namespace URIs (`xmlns=…`, w3.org/2000/svg,
 *     schemas.openxmlformats.org) — identifiers, never fetched;
 *   - JSON-schema `$schema` URLs;
 *   - documentation / "learn more" links — `href=` anchors (ollama.com,
 *     lmstudio.ai) and `url:` metadata fields (cfainstitute.org curriculum
 *     pointers) — opened by the user's browser, not the app;
 *   - any URL only mentioned in a comment.
 * Only a literal that BOTH looks like a runtime endpoint AND sits outside the
 * allowlist fails. A NEW `fetch('https://evil.example/collect')` fails; the
 * existing intentional paths pass. To add a legitimately-new egress point,
 * extend ALLOWLIST with a reason.
 *
 * Usage:
 *   node scripts/check-no-egress.mjs            # scan; exit 1 on any finding
 *   node scripts/check-no-egress.mjs --json     # machine-readable findings
 *
 * Exit codes: 0 = clean (only allowlisted egress); 1 = at least one finding;
 * 2 = the scan itself could not run (missing dir, read error).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

// --- scan scope -------------------------------------------------------------
// Only SHIPPED runtime source. Build scripts (scripts/), the docs tree, and the
// vendored test suites are intentionally out of scope: a build script fetching a
// dataset at dev time is not a shipped-runtime egress, and this very file plus
// the docs name plenty of hosts in prose.
const ROOTS = [
  join(REPO_ROOT, 'src'),
  join(REPO_ROOT, 'services', 'lsat-backend', 'app'),
];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

// Directories never worth scanning (build output, deps, caches, generated meta).
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', '.venv-lsat',
  'coverage', '.pytest_cache', '.mypy_cache', '_meta',
]);

// File-name patterns that DESCRIBE or TEST egress rather than perform it at
// runtime — skipped wholesale so they never produce false positives.
const SKIP_FILE_RE = /(\.test\.|\.spec\.|test_|_test\.|\.stories\.)/;

// --- allowlist --------------------------------------------------------------
// Each entry pins a (repo-relative file, host) pair that is INTENTIONAL, opt-in,
// and documented. A finding whose file+host matches an entry is suppressed; a
// finding outside the list fails the gate. Keep this list SHORT and justified —
// it is the audit trail for every byte that may leave the device.
const ALLOWLIST = [
  {
    file: 'services/lsat-backend/app/llm/cloud.py',
    host: 'api.anthropic.com',
    reason:
      'Opt-in Tier-B cloud generation (GEN_PROVIDER=cloud + API key). Offline ' +
      'tiers only, never realtime/score-affecting; fenced by the W1 cloud gate.',
  },
  {
    file: 'services/lsat-backend/app/config.py',
    host: 'api.anthropic.com',
    reason:
      'Default CLOUD_API_URL for the opt-in cloud path above. Env-overridable; ' +
      'inert unless GEN_PROVIDER=cloud and a key is present.',
  },
  {
    file: 'services/lsat-backend/app/import_dataset.py',
    host: 'datasets-server.huggingface.co',
    reason:
      'Research dataset importer (POST /api/research/import). User-initiated, ' +
      'per-source license/NC acknowledgement, builds the local question bank; ' +
      'no auto-fetch on boot. Public read-only HF datasets-server.',
  },
];

// --- detection --------------------------------------------------------------
// A URL literal with an explicit scheme + authority. We require a host segment
// so bare paths ('/api/x') and scheme-relative comments don't match.
const URL_RE = /\bhttps?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?(?=[/"'`\s)>]|$)/g;

// Hosts that are NEVER a runtime endpoint — XML / SVG / OOXML / RDF namespace
// authorities. A URL on one of these hosts is an identifier (xmlns, schema URI),
// not something the app fetches. Suppressed regardless of context.
const NAMESPACE_HOSTS = new Set([
  'www.w3.org',
  'schemas.openxmlformats.org',
  'schemas.microsoft.com',
  'purl.org',
  'ns.adobe.com',
  'www.inkscape.org',
  'sodipodi.sourceforge.net',
]);

// Tokens that mark an ACTUAL network call. If one of these appears on the same
// line as a non-loopback URL, the URL is being used as an endpoint -> a finding.
const NETWORK_CALL_RE =
  /\b(?:fetch|axios|sendBeacon|XMLHttpRequest|EventSource|WebSocket)\b|\.(?:get|post|put|patch|delete|head|request|open|stream)\s*\(|\b(?:httpx|requests|urllib|aiohttp)\b/;

// Endpoint-shaped LHS: a const/var whose NAME says "this is a URL we'll call".
// `const X_API = "https://…"`, `BASE_URL = "https://…"`, `baseUrl: "https://…"`.
const ENDPOINT_ASSIGN_RE =
  /(?:[A-Z0-9_]*(?:_URL|_API|_ENDPOINT|_HOST|_BASE)\b|base_?url|api_?base|endpoint)\s*[:=]\s*['"`]https?:/i;

// Contexts that prove a URL is DOCUMENTATION / METADATA, not a runtime endpoint:
// an anchor href, a JSON-schema $schema, an xmlns binding, or a descriptive
// `url:`/`href:` field in a data record. Suppressed even if non-loopback.
const DOC_CONTEXT_RE = /\bhref\s*=|\$schema|xmlns(?::[a-z0-9]+)?\s*=|\burl:\s*['"`]/i;

function isLoopbackHost(host) {
  const h = host.toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local')
  );
}

function isAllowlisted(relFile, host) {
  const norm = relFile.split('\\').join('/');
  return ALLOWLIST.some((e) => e.file === norm && e.host === host.toLowerCase());
}

/** A URL only mentioned in a comment never performs egress. Conservative: we
 * drop FULL-line `//…` / `#…` comments and the `* …`/`/*` body of a block
 * comment. A URL inside running code (even with a trailing comment) is still
 * seen. */
function isCommentOnlyLine(line) {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('#') ||
    t.startsWith('*') ||
    t.startsWith('/*')
  );
}

/** Is this non-loopback URL actually used as a network endpoint on this line?
 * True only when a network-call token or an endpoint-shaped assignment is
 * present AND the line is not a documentation/metadata context. This is what
 * keeps the gate at LOW false positives: a bare URL literal in a data record or
 * a namespace string is never a finding; only a real fetch/endpoint is. */
function isEgressContext(line, host) {
  if (NAMESPACE_HOSTS.has(host.toLowerCase())) return false;
  if (DOC_CONTEXT_RE.test(line)) return false;
  return NETWORK_CALL_RE.test(line) || ENDPOINT_ASSIGN_RE.test(line);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`check-no-egress: cannot read directory ${dir}`, { cause: err });
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walk(full);
    } else if (ent.isFile()) {
      const dot = ent.name.lastIndexOf('.');
      const ext = dot >= 0 ? ent.name.slice(dot) : '';
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      if (SKIP_FILE_RE.test(ent.name)) continue;
      yield full;
    }
  }
}

function scanFile(file) {
  const findings = [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`check-no-egress: cannot read ${file}`, { cause: err });
  }
  const rel = relative(REPO_ROOT, file);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnlyLine(line)) continue;
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(line)) !== null) {
      const host = m[1];
      if (isLoopbackHost(host)) continue;
      if (!isEgressContext(line, host)) continue;
      if (isAllowlisted(rel, host)) continue;
      findings.push({
        file: rel.split('\\').join('/'),
        line: i + 1,
        host,
        snippet: line.trim().slice(0, 160),
      });
    }
  }
  return findings;
}

function main() {
  const asJson = process.argv.includes('--json');
  const allFindings = [];
  let scanned = 0;
  try {
    for (const root of ROOTS) {
      let ok = true;
      try {
        ok = statSync(root).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) {
        console.error(`check-no-egress: scan root missing: ${relative(REPO_ROOT, root)}`);
        process.exit(2);
      }
      for (const file of walk(root)) {
        scanned++;
        allFindings.push(...scanFile(file));
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify({ scanned, findings: allFindings }, null, 2));
  }

  if (allFindings.length === 0) {
    console.log(
      `check-no-egress: OK — scanned ${scanned} shipped source files; ` +
      `no non-loopback egress outside the allowlist (${ALLOWLIST.length} entries).`,
    );
    process.exit(0);
  }

  console.error(
    `\ncheck-no-egress: FAIL — found ${allFindings.length} non-loopback egress ` +
    `point(s) in shipped source outside the allowlist:\n`,
  );
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}  ->  ${f.host}`);
    console.error(`      ${f.snippet}`);
  }
  console.error(
    '\nStudyVault ships offline-only ("works on a plane"). If this egress is a ' +
    'NEW, intentional, opt-in path, add it to ALLOWLIST in scripts/check-no-egress.mjs ' +
    'with a justification. Otherwise remove it or route it through a loopback sidecar.\n',
  );
  process.exit(1);
}

main();
