#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASELINE_CATALOG_SCHEMA = 'studyvault.baseline-catalog.v1';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_CATALOG_PATH = join(REPO_ROOT, 'tests', 'baseline-catalog.json');
const DEFAULT_DOC_PATH = join(REPO_ROOT, 'docs', 'TESTING-BASELINES.md');

function toSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relPath(repoRoot, target) {
  return toSlash(relative(repoRoot, target));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function firstLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function validateCommand(command, { repoRoot, packageScripts, failures, scope }) {
  if (!command || typeof command !== 'string') {
    failures.push(`${scope}: command must be a non-empty string`);
    return;
  }

  const npmRunRe = /\bnpm(?:\.cmd)?\s+run\s+([^\s&|]+)/g;
  for (const match of command.matchAll(npmRunRe)) {
    const scriptName = match[1].replace(/^["']|["']$/g, '');
    if (!packageScripts[scriptName]) {
      failures.push(`${scope}: npm script "${scriptName}" is not defined in package.json`);
    }
  }

  const scriptRefRe = /(?:^|[\s"'`])(\.?\/?scripts\/[A-Za-z0-9._/-]+\.(?:mjs|js|py))\b/g;
  for (const match of command.matchAll(scriptRefRe)) {
    const ref = match[1].replace(/^\.\//, '');
    if (!existsSync(join(repoRoot, ref))) {
      failures.push(`${scope}: referenced script "${ref}" does not exist`);
    }
  }
}

export function validateBaselineCatalog(catalog, { repoRoot = REPO_ROOT } = {}) {
  const failures = [];
  const warnings = [];
  const packageJsonPath = join(repoRoot, 'package.json');
  const packageScripts = existsSync(packageJsonPath) ? readJson(packageJsonPath).scripts || {} : {};

  if (!isObject(catalog)) {
    return { ok: false, failures: ['catalog must be a JSON object'], warnings, baselineCount: 0 };
  }
  if (catalog.schemaVersion !== BASELINE_CATALOG_SCHEMA) {
    failures.push(`schemaVersion must be ${BASELINE_CATALOG_SCHEMA}`);
  }
  if (!Array.isArray(catalog.baselines) || catalog.baselines.length === 0) {
    failures.push('baselines must be a non-empty array');
  }

  const ids = new Set();
  for (const [index, entry] of (catalog.baselines || []).entries()) {
    const scope = entry?.id ? `baseline ${entry.id}` : `baseline[${index}]`;
    if (!isObject(entry)) {
      failures.push(`${scope}: entry must be an object`);
      continue;
    }
    for (const key of ['id', 'title', 'kind', 'owner', 'storage', 'failureMode']) {
      if (!entry[key] || typeof entry[key] !== 'string') failures.push(`${scope}: ${key} must be a non-empty string`);
    }
    if (entry.id) {
      if (ids.has(entry.id)) failures.push(`${scope}: duplicate baseline id`);
      ids.add(entry.id);
    }

    const paths = Array.isArray(entry.paths) ? entry.paths : [];
    if (entry.storage === 'committed' && paths.length === 0) {
      failures.push(`${scope}: committed baselines must list at least one path`);
    }
    for (const pathEntry of paths) {
      if (!isObject(pathEntry) || typeof pathEntry.path !== 'string' || !pathEntry.path) {
        failures.push(`${scope}: every path entry must have a non-empty path`);
        continue;
      }
      const pathType = pathEntry.type || 'file';
      const abs = join(repoRoot, pathEntry.path);
      const required = entry.storage === 'committed' || pathEntry.required !== false;
      if (!existsSync(abs)) {
        const message = `${scope}: path ${pathEntry.path} is missing`;
        if (required) failures.push(message);
        else warnings.push(message);
        continue;
      }
      const stats = statSync(abs);
      if (pathType === 'file') {
        if (!stats.isFile()) failures.push(`${scope}: path ${pathEntry.path} must be a file`);
      } else if (pathType === 'directory') {
        if (!stats.isDirectory()) {
          failures.push(`${scope}: path ${pathEntry.path} must be a directory`);
        } else if (Number.isInteger(pathEntry.minFiles) && listFiles(abs).length < pathEntry.minFiles) {
          failures.push(`${scope}: directory ${pathEntry.path} has fewer than ${pathEntry.minFiles} files`);
        }
      } else {
        failures.push(`${scope}: unsupported path type ${pathType}`);
      }
    }

    for (const field of ['refresh', 'verify', 'ci']) {
      if (!isObject(entry[field])) {
        failures.push(`${scope}: ${field} must be an object`);
      } else {
        validateCommand(entry[field].command, {
          repoRoot,
          packageScripts,
          failures,
          scope: `${scope}.${field}`,
        });
      }
    }
    if (!Array.isArray(entry.docs) || entry.docs.length === 0) {
      failures.push(`${scope}: docs must list at least one documentation path`);
    } else {
      for (const docPath of entry.docs) {
        if (typeof docPath !== 'string' || !docPath) {
          failures.push(`${scope}: docs entries must be non-empty strings`);
        } else if (!existsSync(join(repoRoot, docPath))) {
          failures.push(`${scope}: documentation path ${docPath} is missing`);
        }
      }
    }
    if (entry.workingDirectory && !existsSync(join(repoRoot, entry.workingDirectory))) {
      failures.push(`${scope}: workingDirectory ${entry.workingDirectory} is missing`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    baselineCount: catalog.baselines?.length || 0,
  };
}

function pathSummary(entry) {
  if (!Array.isArray(entry.paths) || entry.paths.length === 0) return 'n/a';
  return entry.paths
    .map((pathEntry) => {
      const suffix = pathEntry.required === false ? ' (external/cache)' : '';
      return `${pathEntry.path}${suffix}`;
    })
    .join('<br>');
}

export function renderBaselineCatalogMarkdown(catalog) {
  const sortedBaselines = [...(catalog.baselines || [])].sort((a, b) => a.id.localeCompare(b.id));
  const rows = [
    '| ID | Storage | Paths | Verify | Refresh |',
    '|---|---|---|---|---|',
  ];
  for (const entry of sortedBaselines) {
    rows.push(
      [
        entry.id,
        entry.storage,
        pathSummary(entry),
        firstLine(entry.verify?.command),
        firstLine(entry.refresh?.command),
      ].map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    );
  }

  const sections = sortedBaselines.map((entry) => [
    `## ${entry.title}`,
    '',
    `- ID: \`${entry.id}\``,
    `- Kind: ${entry.kind}`,
    `- Owner: ${entry.owner}`,
    `- Storage: ${entry.storage}`,
    `- Failure mode: ${entry.failureMode}`,
    `- CI gate: \`${entry.ci?.command}\``,
    `- Verify: \`${entry.verify?.command}\``,
    `- Refresh: \`${entry.refresh?.command}\``,
    entry.workingDirectory ? `- Working directory: \`${entry.workingDirectory}\`` : null,
    entry.review ? `- Review rule: ${entry.review}` : null,
    '',
  ].filter(Boolean).join('\n'));

  return [
    '# Testing Baselines and Golden Fixtures',
    '',
    '<!-- Generated by npm run baseline:catalog. Edit tests/baseline-catalog.json, then regenerate. -->',
    '',
    'This catalog is the source of truth for committed and externally approved baselines used by CI and local release trust.',
    '',
    ...rows,
    '',
    sections.join('\n\n'),
  ].join('\n');
}

export function checkBaselineCatalog({
  repoRoot = REPO_ROOT,
  catalogPath = DEFAULT_CATALOG_PATH,
  docsPath = DEFAULT_DOC_PATH,
  writeDoc = false,
} = {}) {
  const catalog = readJson(catalogPath);
  const markdown = renderBaselineCatalogMarkdown(catalog);
  if (writeDoc) {
    mkdirSync(dirname(docsPath), { recursive: true });
    writeFileSync(docsPath, `${markdown}\n`);
  }
  const validation = validateBaselineCatalog(catalog, { repoRoot });
  const expected = `${markdown}\n`;
  const actual = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : null;
  const docMatches = actual === expected;
  const failures = [...validation.failures];
  if (!docMatches) {
    failures.push(`${relPath(repoRoot, docsPath)} is out of sync with ${relPath(repoRoot, catalogPath)}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings: validation.warnings,
    baselineCount: validation.baselineCount,
    docMatches,
  };
}

function parseArgs(argv) {
  const args = { writeDoc: false, asJson: false };
  for (const arg of argv) {
    if (arg === '--write-doc') args.writeDoc = true;
    else if (arg === '--json') args.asJson = true;
    else {
      console.error(`check-baseline-catalog: unknown arg ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = checkBaselineCatalog({ writeDoc: args.writeDoc });
  } catch (err) {
    console.error(`check-baseline-catalog: ${err.message}`);
    process.exit(2);
  }

  if (args.asJson) console.log(JSON.stringify(result, null, 2));

  if (result.ok) {
    const warnings = result.warnings.length ? ` (${result.warnings.length} optional path warning(s))` : '';
    console.log(`check-baseline-catalog: OK - ${result.baselineCount} baseline entries are documented${warnings}.`);
    process.exit(0);
  }

  console.error(`check-baseline-catalog: FAIL - ${result.failures.length} issue(s):`);
  for (const failure of result.failures) console.error(`  - ${failure}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
