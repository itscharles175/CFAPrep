#!/usr/bin/env node
/*
 * Wave 2 API contract safety - direct LSAT sidecar fetch inventory gate.
 *
 * The desired end state is that production frontend code reaches the LSAT
 * backend sidecar through approved API adapters only. This script does not
 * rewrite existing callers. It inventories the current direct
 * http://127.0.0.1:8100 / http://localhost:8100 fetch surface outside those
 * adapters and fails only when a new direct fetch appears outside the committed
 * baseline. As callers migrate onto typed/generated clients, remove their
 * baseline entries to ratchet the budget down.
 *
 * Usage:
 *   node scripts/check-direct-sidecar-fetches.mjs
 *   node scripts/check-direct-sidecar-fetches.mjs --json
 *   node scripts/check-direct-sidecar-fetches.mjs --inventory-only [--json]
 *
 * Exit codes: 0 = no new direct fetches; 1 = at least one new direct fetch;
 * 2 = the scan or baseline could not be read.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASELINE_PATH = join(SCRIPT_DIR, 'direct-sidecar-fetches-baseline.json');

const ROOTS = [join(REPO_ROOT, 'src')];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.vite',
  '_meta',
]);
const SKIP_FILE_RE = /(\.test\.|\.spec\.|\.stories\.|setupTests\.|vite-env\.d\.ts$)/;

const APPROVED_ADAPTERS = new Set([
  'src/domains/lsat/lib/api.ts',
  'src/lib/lsatBackend.ts',
  'src/lib/lsatSidecarClient.ts',
]);

const DIRECT_SIDECAR_RE =
  /\bhttps?:\/\/(?:127\.0\.0\.1|localhost):8100\b[^'"`\s)\]}]*/;
const FETCH_RE = /\bfetch\s*\(/;
const VAR_ASSIGN_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/;

function relPath(file) {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

function isCommentOnlyLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function normalizeSnippet(line) {
  return line.trim().replace(/\s+/g, ' ').slice(0, 180);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasIdentifier(text, identifier) {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(text);
}

function parseArgs(argv) {
  const out = { asJson: false, inventoryOnly: false };
  for (const arg of argv) {
    if (arg === '--json') out.asJson = true;
    else if (arg === '--inventory-only') out.inventoryOnly = true;
    else {
      console.error(`check-direct-sidecar-fetches: unknown arg ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

function isExistingDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read directory ${dir}: ${err.message}`, { cause: err });
  }

  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walk(full);
    } else if (ent.isFile()) {
      if (!SCAN_EXTENSIONS.has(extname(ent.name))) continue;
      if (SKIP_FILE_RE.test(ent.name)) continue;
      yield full;
    }
  }
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`, { cause: err });
  }
}

function collectSidecarIdentifiers(lines) {
  const identifiers = new Set();

  for (const line of lines) {
    if (isCommentOnlyLine(line)) continue;
    const m = line.match(VAR_ASSIGN_RE);
    if (m && DIRECT_SIDECAR_RE.test(m[2])) identifiers.add(m[1]);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const line of lines) {
      if (isCommentOnlyLine(line)) continue;
      const m = line.match(VAR_ASSIGN_RE);
      if (!m || identifiers.has(m[1])) continue;
      for (const id of identifiers) {
        if (hasIdentifier(m[2], id)) {
          identifiers.add(m[1]);
          changed = true;
          break;
        }
      }
    }
  }

  return identifiers;
}

function scanFile(file) {
  const rel = relPath(file);
  const lines = readLines(file);
  const sidecarIdentifiers = collectSidecarIdentifiers(lines);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnlyLine(line) || !FETCH_RE.test(line)) continue;

    const windowText = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
    const literal = DIRECT_SIDECAR_RE.test(windowText);
    const via = [...sidecarIdentifiers].find((id) => hasIdentifier(windowText, id));
    if (!literal && !via) continue;

    const snippet = normalizeSnippet(line);
    findings.push({
      file: rel,
      line: i + 1,
      via: literal ? 'literal' : via,
      key: `${rel} :: ${snippet}`,
      snippet,
    });
  }

  return findings;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`baseline missing: ${relPath(BASELINE_PATH)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`baseline is not valid JSON: ${err.message}`, { cause: err });
  }

  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error('baseline must contain a findings array');
  }

  const keys = new Set();
  const entries = [];
  for (const entry of parsed.findings) {
    const key = typeof entry === 'string' ? entry : entry?.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('baseline finding is missing a non-empty key');
    }
    if (keys.has(key)) {
      throw new Error(`baseline contains duplicate key: ${key}`);
    }
    keys.add(key);
    entries.push(typeof entry === 'string' ? { key } : entry);
  }

  return { entries, keys };
}

function scanAll() {
  const findings = [];
  let scanned = 0;

  for (const root of ROOTS) {
    if (!isExistingDirectory(root)) throw new Error(`scan root missing: ${relPath(root)}`);

    for (const file of walk(root)) {
      scanned++;
      const rel = relPath(file);
      if (APPROVED_ADAPTERS.has(rel)) continue;
      findings.push(...scanFile(file));
    }
  }

  findings.sort((a, b) => a.key.localeCompare(b.key));
  return { scanned, findings };
}

function printInventory(findings) {
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  via ${f.via}`);
    console.log(`      ${f.snippet}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let scan;
  try {
    scan = scanAll();
  } catch (err) {
    console.error(`check-direct-sidecar-fetches: ${err.message}`);
    process.exit(2);
  }

  if (args.inventoryOnly) {
    if (args.asJson) {
      console.log(JSON.stringify({
        scanned: scan.scanned,
        approvedAdapters: [...APPROVED_ADAPTERS],
        findings: scan.findings,
      }, null, 2));
    } else {
      console.log(
        `check-direct-sidecar-fetches: inventory - ${scan.findings.length} ` +
          'direct LSAT sidecar fetch(es) outside approved adapters:',
      );
      printInventory(scan.findings);
    }
    process.exit(0);
  }

  let baseline;
  try {
    baseline = loadBaseline();
  } catch (err) {
    console.error(`check-direct-sidecar-fetches: ${err.message}`);
    console.error('  Run with --inventory-only to inspect current findings, then commit a ratchet baseline.');
    process.exit(2);
  }

  const currentKeys = new Set(scan.findings.map((f) => f.key));
  const newFindings = scan.findings.filter((f) => !baseline.keys.has(f.key));
  const resolvedFindings = baseline.entries.filter((f) => !currentKeys.has(f.key));
  const pass = newFindings.length === 0;

  if (args.asJson) {
    console.log(JSON.stringify({
      scanned: scan.scanned,
      approvedAdapters: [...APPROVED_ADAPTERS],
      baselineSize: baseline.entries.length,
      findings: scan.findings,
      newFindings,
      resolvedFindings,
      pass,
    }, null, 2));
  }

  if (pass) {
    const ratchet = resolvedFindings.length
      ? ` ${resolvedFindings.length} baseline entr${resolvedFindings.length === 1 ? 'y is' : 'ies are'} now resolved; remove them to ratchet.`
      : '';
    console.log(
      `check-direct-sidecar-fetches: OK - ${scan.findings.length} existing direct ` +
        `LSAT sidecar fetch(es) match the baseline; no new unapproved fetches.${ratchet}`,
    );
    process.exit(0);
  }

  console.error(
    `\ncheck-direct-sidecar-fetches: FAIL - found ${newFindings.length} new direct ` +
      'LSAT sidecar fetch(es) outside approved adapters:\n',
  );
  printInventory(newFindings);
  console.error(
    '\nRoute new callers through an approved API adapter (`src/domains/lsat/lib/api.ts` ' +
      'or `src/lib/lsatBackend.ts`). If a caller is intentionally deferred, add a ' +
      'reviewed entry to scripts/direct-sidecar-fetches-baseline.json so the debt remains explicit.\n',
  );
  process.exit(1);
}

main();
