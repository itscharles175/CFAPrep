#!/usr/bin/env node
/*
 * QA-2 — cross-domain end-to-end + live-sidecar integration harness.
 *
 * Proves the real cross-domain Review-Inbox path works against a LIVE LSAT
 * sidecar (not a mocked fetch): the host Review Inbox pulls the LSAT due queue
 * over HTTP via the bridge, the user deep-links into the vendored LSAT SRS flow,
 * completes a card, returns to the inbox, and the due count has decremented.
 *
 * What it does, in order:
 *   1. Resolve a Chromium-compatible browser the same way the a11y gate does
 *      (system Chrome/Edge → Playwright-managed chromium; see a11y-helpers.mjs).
 *   2. Seed a throwaway SQLite DB exactly like a real sidecar boot
 *      (`python -c "app.seed.seed(reset=True)"` with LSATLAB_DB pointed at it),
 *      so `GET /api/srs/due` answers with a non-empty queue (the seed makes SRS
 *      cards due `now - 1h`). This mirrors the `seeded_sidecar_db` pytest fixture
 *      in services/lsat-backend/tests/conftest.py.
 *   3. Boot the sidecar (`sidecar_main.py`) on 127.0.0.1:8100 — the port the
 *      BUILT host bundle + LSAT app are hard-wired to (VITE_API_BASE default,
 *      baked at build time), so this must match.
 *   4. `vite preview` the production `dist/` build (same as a11y-check.mjs).
 *   5. Drive the flow with Playwright and assert the decrement.
 *
 * Robust + actionable failures: a missing browser, missing build, missing
 * sidecar entry/venv, or an unhealthy sidecar each fail FAST with a message that
 * says exactly what to provide. This harness needs BOTH a browser AND a runnable
 * Python sidecar in the environment; in a sandbox lacking either it will exit
 * non-zero with that explanation rather than hang (see QA-2 followups).
 *
 * Usage:
 *   node --import ./scripts/register-ts-loader.mjs scripts/e2e-integration.mjs
 *   (env overrides: LSAT_E2E_PORT, LSAT_E2E_PYTHON, LSAT_E2E_TIMEOUT_MS)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from './a11y-helpers.mjs';

/* global document */

const REPO_ROOT = process.cwd();
const BACKEND_ROOT = resolve(REPO_ROOT, 'services/lsat-backend');
const SIDECAR_ENTRY = resolve(BACKEND_ROOT, 'sidecar_main.py');
// The built host + LSAT app default to 127.0.0.1:8100 (VITE_API_BASE, baked at
// build time). The live sidecar MUST listen there for the bridge to reach it.
const SIDECAR_PORT = Number(process.env.LSAT_E2E_PORT || 8100);
const SIDECAR_HEALTH = `http://127.0.0.1:${SIDECAR_PORT}/api/health`;
const SIDECAR_DUE = `http://127.0.0.1:${SIDECAR_PORT}/api/srs/due`;
// Deep-link target the host hard-navigates to (mirrors LSAT_REVIEW_PATH in
// src/lib/lsatReviewBridge.ts — kept as a literal so this script imports no
// `@/`-aliased TS module graph).
const LSAT_SRS_PATH = '/lsat/srs';
const BOOT_TIMEOUT_MS = Number(process.env.LSAT_E2E_TIMEOUT_MS || 60000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`\ne2e-integration: FAILED — ${message}\n`);
  process.exitCode = 1;
}

/** Resolve the Python interpreter for the sidecar: explicit override → venv. */
function resolvePython() {
  const override = process.env.LSAT_E2E_PYTHON;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`LSAT_E2E_PYTHON=${override} does not exist.`);
  }
  const candidates =
    process.platform === 'win32'
      ? [resolve(REPO_ROOT, '.venv-lsat/Scripts/python.exe')]
      : [resolve(REPO_ROOT, '.venv-lsat/bin/python')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No LSAT backend venv Python found (looked at ${candidates.join(', ')}). ` +
      'Create it (see services/lsat-backend) or set LSAT_E2E_PYTHON to a Python ' +
      'with the backend deps installed.',
  );
}

/** Probe an HTTP URL once; resolve { ok, detail }. */
async function probe(url, expectOk) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    if (!expectOk) return { ok: true, detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return body && body.ok === true
      ? { ok: true, detail: 'ok:true' }
      : { ok: false, detail: `body=${JSON.stringify(body)}` };
  } catch (e) {
    return { ok: false, detail: e.code || e.name || String(e) };
  }
}

/** Seed a throwaway DB the same way a real sidecar boot does (child Python). */
function seedTestDb(python, dbPath) {
  const child = [
    'import json',
    'from datetime import datetime, timezone',
    'from sqlmodel import Session, select',
    'from app import seed as seed_mod',
    'from app.db import engine',
    'from app.models import SRSCard',
    'seed_mod.seed(reset=True)',
    'now = datetime.now(timezone.utc)',
    'due = 0',
    'with Session(engine) as s:',
    '    for c in s.exec(select(SRSCard)).all():',
    '        d = c.due_date',
    '        if d.tzinfo is None:',
    '            d = d.replace(tzinfo=timezone.utc)',
    '        if d <= now:',
    '            due += 1',
    'print(json.dumps({"due_count": due}))',
  ].join('\n');
  return new Promise((resolveSeed, rejectSeed) => {
    const proc = spawn(python, ['-c', child], {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        LSATLAB_DB: dbPath,
        LSATLAB_JOBS_WORKER: '0',
        LSATLAB_ERRORLOG_AUTODIAGNOSE: '0',
        LSATLAB_OLLAMA_URL: 'http://127.0.0.1:1',
        LSATLAB_LMSTUDIO_URL: 'http://127.0.0.1:1/v1',
        LSATLAB_LLM_RETRIES: '0',
      },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (b) => (out += b.toString()));
    proc.stderr.on('data', (b) => (err += b.toString()));
    proc.on('error', rejectSeed);
    proc.on('exit', (code) => {
      if (code !== 0) {
        rejectSeed(new Error(`seed subprocess exited ${code}.\n--- stderr ---\n${err}\n--- stdout ---\n${out}`));
        return;
      }
      const line = (out.trim().split(/\r?\n/).pop() || '').trim();
      try {
        resolveSeed(JSON.parse(line));
      } catch {
        rejectSeed(new Error(`could not parse seed summary: ${line || '(empty)'}\n--- stdout ---\n${out}`));
      }
    });
  });
}

/** Spawn the sidecar against the seeded DB; resolve once it answers ok:true. */
async function bootSidecar(python, dbPath) {
  const child = spawn(python, [SIDECAR_ENTRY, '--host', '127.0.0.1', '--port', String(SIDECAR_PORT), '--log-level', 'warning'], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      LSATLAB_DB: dbPath,
      LSATLAB_PORT: String(SIDECAR_PORT),
      LSATLAB_JOBS_WORKER: '0',
      LSATLAB_ERRORLOG_AUTODIAGNOSE: '0',
      LSATLAB_OLLAMA_URL: 'http://127.0.0.1:1',
      LSATLAB_LMSTUDIO_URL: 'http://127.0.0.1:1/v1',
      LSATLAB_LLM_RETRIES: '0',
    },
    windowsHide: true,
  });

  let logTail = '';
  const capture = (b) => { logTail = (logTail + b.toString()).slice(-4000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `sidecar exited early (code=${exited.code} sig=${exited.sig}) before becoming healthy.\n` +
          `--- output tail ---\n${logTail}`,
      );
    }
    const r = await probe(SIDECAR_HEALTH, true);
    if (r.ok) {
      console.log(`e2e-integration: sidecar healthy at ${SIDECAR_HEALTH}`);
      return { child, logTail: () => logTail };
    }
    await sleep(1000);
  }
  child.kill();
  throw new Error(
    `sidecar never became healthy at ${SIDECAR_HEALTH} within ${BOOT_TIMEOUT_MS}ms.\n` +
      `--- output tail ---\n${logTail}`,
  );
}

/** The current due_count straight from the sidecar (ground truth for asserts). */
async function sidecarDueCount() {
  const res = await fetch(SIDECAR_DUE, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET /api/srs/due returned HTTP ${res.status}`);
  const body = await res.json();
  return typeof body.due_count === 'number' ? body.due_count : (body.cards || []).length;
}

async function waitForBodyText(page, text, label) {
  await page
    .waitForFunction((expected) => document.body.innerText.includes(expected), text, { timeout: 20000 })
    .catch((error) => {
      throw new Error(`Timed out waiting for ${label} (text: ${JSON.stringify(text)}): ${error.message}`);
    });
}

async function main() {
  // --- preflight: build present, browser present, sidecar entry + venv present.
  await access('dist/index.html').catch(() => {
    throw new Error('Production dist is missing. Run `npm run build` before e2e-integration.');
  });
  if (!existsSync(SIDECAR_ENTRY)) {
    throw new Error(`Sidecar entry not found at ${SIDECAR_ENTRY}.`);
  }
  const python = resolvePython();
  const executablePath = await resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      'No Chromium-compatible browser found. Install a system Chrome/Edge, set ' +
        'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run `npx playwright install chromium` (CI does this).',
    );
  }

  const dbPath = join(mkdtempSync(join(tmpdir(), 'lsat-e2e-')), 'lsatlab_e2e.db');

  // --- seed the throwaway DB, then boot the sidecar against it.
  const seed = await seedTestDb(python, dbPath);
  if (!seed.due_count || seed.due_count < 1) {
    throw new Error(`seeded DB has no due SRS cards (due_count=${seed.due_count}); the inbox would be empty.`);
  }
  console.log(`e2e-integration: seeded DB at ${dbPath} (due_count=${seed.due_count})`);

  const sidecar = await bootSidecar(python, dbPath);

  // --- serve the production build (same as a11y-check.mjs).
  const server = await preview({
    preview: { host: '127.0.0.1', port: 4176, strictPort: false, open: false },
  });
  const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4176/';
  const browser = await chromium.launch({ executablePath, headless: true });

  try {
    const dueBefore = await sidecarDueCount();
    if (dueBefore < 1) throw new Error(`expected >=1 due card before review, got ${dueBefore}.`);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    // 1) Open the Review Inbox and confirm it loaded.
    await page.goto(new URL('/review', address).toString(), { waitUntil: 'networkidle' });
    await waitForBodyText(page, 'Review Inbox', 'host Review Inbox');

    // 2) Assert the LSAT due section populated via the bridge. The inbox renders
    //    an "LSAT reviews — N due" heading only when the sidecar is reachable
    //    (lsatDue.ok). Poll briefly: the bridge fetch is fired in an effect.
    await page
      .waitForFunction(() => /LSAT reviews/i.test(document.body.innerText), null, { timeout: 15000 })
      .catch(() => {
        throw new Error('LSAT due section never populated in the Review Inbox — the bridge did not reach the sidecar.');
      });
    const inboxText = await page.evaluate(() => document.body.innerText);
    if (!/LSAT reviews\s*—\s*\d+\s*due/i.test(inboxText) && !/LSAT reviews\s*—\s*all caught up/i.test(inboxText)) {
      throw new Error(`Unexpected LSAT review section text in inbox.\n--- inbox text ---\n${inboxText.slice(0, 800)}`);
    }
    console.log('e2e-integration: Review Inbox shows the live LSAT due section.');

    // 3) Deep-link into the LSAT SRS flow (the host hard-navigates here).
    await page.goto(new URL(LSAT_SRS_PATH, address).toString(), { waitUntil: 'networkidle' });
    await waitForBodyText(page, 'SRS', 'LSAT SRS page');

    // 4) Complete exactly one card: select a choice → Reveal & rate → grade.
    //    The SRS page (src/domains/lsat/pages/Srs.tsx) renders a ChoiceList, then
    //    a "Reveal & rate" button, then four grade buttons (Again/Hard/Good/Easy).
    await page
      .waitForSelector('button:has-text("Reveal")', { timeout: 15000 })
      .catch(() => {
        throw new Error('LSAT SRS card did not render a "Reveal & rate" affordance (no due card to review?).');
      });
    // Pick the first answer choice so Reveal becomes enabled. Choices are buttons
    // inside the choice list; click the first that is not the Reveal/grade button.
    const picked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const choice = btns.find((b) => /^[A-E]\b/.test((b.textContent || '').trim()));
      if (choice) {
        choice.click();
        return true;
      }
      return false;
    });
    if (!picked) {
      // Some card layouts use radio/listitem choices; fall back to the first
      // interactive choice-list element.
      await page.locator('[role="radio"], li button, .choice, [data-choice]').first().click({ timeout: 5000 }).catch(() => {});
    }
    await page.getByRole('button', { name: /reveal/i }).click({ timeout: 10000 });
    // Grade "Good" (rating 3) — fires exactly one POST /api/srs/{id}/review.
    await page.getByRole('button', { name: /^good$/i }).click({ timeout: 10000 });

    // The review POST is fired optimistically in the background; give it a moment
    // to land on the sidecar before we read the authoritative due count.
    await sleep(1500);

    // 5) Back to the Review Inbox and assert the due count decremented. We assert
    //    against the SIDECAR's own due_count (ground truth) so the check doesn't
    //    depend on the inbox's display formatting.
    const dueAfter = await sidecarDueCount();
    if (dueAfter >= dueBefore) {
      throw new Error(`due count did not decrement after completing a card (before=${dueBefore}, after=${dueAfter}).`);
    }
    console.log(`e2e-integration: due count decremented ${dueBefore} → ${dueAfter} after one review.`);

    // Re-open the inbox to confirm it still renders the (now-smaller) LSAT section.
    await page.goto(new URL('/review', address).toString(), { waitUntil: 'networkidle' });
    await waitForBodyText(page, 'Review Inbox', 'host Review Inbox (return)');
    await page
      .waitForFunction(() => /LSAT reviews/i.test(document.body.innerText), null, { timeout: 15000 })
      .catch(() => {
        throw new Error('LSAT section disappeared after returning to the inbox.');
      });

    console.log('\ne2e-integration: PASS — cross-domain Review-Inbox → /lsat/srs → review → decrement verified.');
  } finally {
    await browser.close().catch(() => {});
    await new Promise((res) => server.httpServer.close(res));
    sidecar.child.kill();
    await sleep(250);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
