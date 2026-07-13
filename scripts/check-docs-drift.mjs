#!/usr/bin/env node
/*
 * DX-1 — docs-drift gate for docs/ARCHITECTURE.md (StudyVault stack-upgrade W1).
 *
 * ARCHITECTURE.md is the umbrella doc people read to understand how the app
 * boots and where things live. When the code moves and the doc doesn't, the doc
 * becomes an actively misleading map — the worst kind. The clearest live example:
 * the K4-12/K4-13 cutover retired the split-shell (the per-domain HostApp <->
 * LsatRoot swap booted straight from `src/main.jsx` via `src/host-entry.jsx`)
 * and replaced it with a SINGLE unified root (`src/components/UnifiedRoot.tsx`).
 * `host-entry.jsx` and `LsatRoot.tsx` are gone, yet a stale doc could still
 * describe them as the boot path.
 *
 * This gate is MINIMAL and CONSERVATIVE on purpose. It does NOT lint prose or
 * grade writing quality. It checks a small, explicit set of HARD assertions that
 * are objectively true-or-false against the current tree:
 *   1. structural truth — files the doc treats as load-bearing must exist (or be
 *      gone) in agreement with the doc's claims;
 *   2. boot-path truth — the doc must not describe a retired boot mechanism that
 *      the live `src/main.jsx` has replaced.
 * Each assertion fails with a precise message pointing at the exact remediation.
 * Add an assertion only when the drift is unambiguous; never on fuzzy wording.
 *
 * Usage:
 *   node scripts/check-docs-drift.mjs            # run all assertions
 *   node scripts/check-docs-drift.mjs --json     # machine-readable result
 *
 * Exit codes: 0 = doc matches the tree; 1 = at least one drift assertion failed;
 * 2 = the check itself could not run (a referenced doc/source is unreadable).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ARCH_PATH = join(REPO_ROOT, 'docs', 'ARCHITECTURE.md');

function fileExists(rel) {
  return existsSync(join(REPO_ROOT, rel));
}

function readArch() {
  try {
    return readFileSync(ARCH_PATH, 'utf8');
  } catch (err) {
    console.error(`check-docs-drift: cannot read docs/ARCHITECTURE.md: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Each assertion returns { ok, name, detail }. `ok=false` is drift. Assertions
 * are pure (no side effects) and read the doc text + the file tree only.
 */
function buildAssertions(arch) {
  const assertions = [];

  // --- 1. boot-path truth --------------------------------------------------
  // The live entry. If main.jsx ever stops booting UnifiedRoot this whole gate's
  // premise changed and the assertions below must be revisited — so assert it.
  const mainJsx = (() => {
    try {
      return readFileSync(join(REPO_ROOT, 'src', 'main.jsx'), 'utf8');
    } catch {
      return '';
    }
  })();

  assertions.push({
    name: 'main.jsx boots UnifiedRoot',
    ok: /UnifiedRoot/.test(mainJsx),
    detail:
      'src/main.jsx no longer references UnifiedRoot. The boot path changed; ' +
      'update docs/ARCHITECTURE.md and this gate to match the new entry.',
  });

  // The retired split-shell entry. If the doc still names host-entry.jsx /
  // mountHost as the live boot mechanism while that file is gone, that is drift.
  const hostEntryGone = !fileExists('src/host-entry.jsx');
  const docNamesHostEntry = /host-entry\.jsx|mountHost/.test(arch);
  assertions.push({
    name: 'doc does not describe retired host-entry.jsx boot path',
    ok: !(hostEntryGone && docNamesHostEntry),
    detail:
      'docs/ARCHITECTURE.md still describes src/host-entry.jsx / mountHost as a ' +
      'boot path, but that file was removed in the unified-root cutover (K4-12/13). ' +
      'Rewrite the routing section to describe src/components/UnifiedRoot.tsx.',
  });

  // The retired direct LsatRoot mount from main.jsx. Same drift class.
  const lsatRootGone = !fileExists('src/domains/lsat/LsatRoot.tsx');
  const docNamesLsatRootMount = /main\.jsx[\s\S]{0,200}LsatRoot\.tsx/.test(arch);
  assertions.push({
    name: 'doc does not describe retired LsatRoot.tsx direct mount',
    ok: !(lsatRootGone && docNamesLsatRootMount),
    detail:
      'docs/ARCHITECTURE.md describes src/main.jsx mounting src/domains/lsat/' +
      'LsatRoot.tsx directly, but LsatRoot.tsx was removed in the unified-root ' +
      'cutover. Update the routing section to the UnifiedRoot/LsatUnifiedMount path.',
  });

  // --- 2. structural truth -------------------------------------------------
  // A curated set of paths the doc treats as load-bearing (boot, shared bridges,
  // sidecar source, CI). Each must exist; a doc that points at a moved/deleted
  // file is a broken map. Kept SMALL + explicit, not a fuzzy crawl of every
  // backtick in the file.
  const REQUIRED_PATHS = [
    'src/main.jsx',
    'src/App.jsx',
    'src/components/UnifiedRoot.tsx',
    'src/lib/lsatBackend.ts',
    'src/lib/lsatReviewBridge.ts',
    'src-tauri/src/lib.rs',
    'services/lsat-backend',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
  ];
  for (const rel of REQUIRED_PATHS) {
    // Only assert paths the doc actually references, so the gate stays coupled to
    // the doc's claims rather than to an arbitrary file list.
    const referenced = arch.includes(rel) ||
      arch.includes(rel.split('/').pop());
    if (!referenced) continue;
    assertions.push({
      name: `referenced path exists: ${rel}`,
      ok: fileExists(rel),
      detail:
        `docs/ARCHITECTURE.md references "${rel}" but it does not exist in the ` +
        'tree. Update the doc to the current path (or restore the file).',
    });
  }

  return assertions;
}

function main() {
  const asJson = process.argv.includes('--json');
  const arch = readArch();
  const assertions = buildAssertions(arch);
  const failures = assertions.filter((a) => !a.ok);

  if (asJson) {
    console.log(JSON.stringify(
      { checked: assertions.length, failures: failures.map((f) => f.name) },
      null,
      2,
    ));
  }

  if (failures.length === 0) {
    console.log(
      `check-docs-drift: OK — docs/ARCHITECTURE.md passes all ${assertions.length} ` +
      'structural + boot-path assertions.',
    );
    process.exit(0);
  }

  console.error(
    `\ncheck-docs-drift: FAIL — docs/ARCHITECTURE.md drifted from the code ` +
    `(${failures.length}/${assertions.length} assertion(s)):\n`,
  );
  for (const f of failures) {
    console.error(`  [${f.name}]`);
    console.error(`      ${f.detail}\n`);
  }
  process.exit(1);
}

main();
