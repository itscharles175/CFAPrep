#!/usr/bin/env node
/*
 * Build the StudyVault LSAT backend (FastAPI + SQLite, vendored from LSAT Lab)
 * into a one-file PyInstaller binary and drop it into
 * `electron/resources/services/lsat-backend/`, where electron-builder's
 * `extraResources` ships it and the Electron sidecar supervisor
 * launches it on `127.0.0.1:8100`.
 *
 * Mirrors scripts/build-onb-binary.mjs (same isolated-venv discipline) but
 * REUSES the backend's own, purpose-built `lsatlab.spec` (it already collects
 * the uvicorn/fastapi/sqlmodel/fsrs/mcp/pymupdf/sqlite_vec hidden-imports and
 * data files) instead of generating a generic spec.
 *
 * Usage:
 *   node scripts/build-lsat-binary.mjs            # isolated-venv build (default)
 *   node scripts/build-lsat-binary.mjs --ambient  # build against Python on PATH
 *   node scripts/build-lsat-binary.mjs --clean    # rm the PyInstaller work/dist dirs
 *
 * Prerequisites:
 *   - Python 3.12 on PATH (the backend requires-python >=3.12).
 *   - Network on first run (installs the backend's dependency tree).
 *
 * Default (isolated-venv) mode provisions `.venv-lsat` and runs:
 *     pip install "services/lsat-backend"   # authoritative deps from pyproject
 *     pip install pyinstaller==6.20.0
 * so the build never depends on — or mutates — the global site-packages.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordSidecarProvenance } from './sidecar-provenance.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '..', '..');
const BACKEND_DIR = join(REPO_ROOT, 'services', 'lsat-backend');
const SPEC = 'lsatlab.spec'; // the backend's own spec, run with cwd=BACKEND_DIR
const ENTRY = join(BACKEND_DIR, 'sidecar_main.py');
const PYINST_BUILD = join(REPO_ROOT, '.pyinstaller-lsat-build');
const PYINST_DIST = join(REPO_ROOT, '.pyinstaller-lsat-dist');
const OUT_DIR = join(REPO_ROOT, 'electron', 'resources', 'services', 'lsat-backend');
const VENV_DIR = join(REPO_ROOT, '.venv-lsat');
const PYINSTALLER_VERSION = '6.20.0';
const EXE_NAME = process.platform === 'win32' ? 'lsatlab-backend.exe' : 'lsatlab-backend';

const args = new Set(process.argv.slice(2));
const CLEAN = args.has('--clean');
const AMBIENT = args.has('--ambient');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts });
}
function ensure(cond, msg) {
  if (!cond) {
    console.error(`\nERROR: ${msg}\n`);
    process.exit(1);
  }
}
function exists(p) {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}
function resolveBasePython() {
  for (const cmd of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore', shell: true });
      return cmd;
    } catch {
      /* next */
    }
  }
  ensure(false, "Neither 'python' nor 'python3' is on PATH. Install Python 3.12 and re-run.");
  return 'python';
}
function venvPython() {
  return process.platform === 'win32' ? join(VENV_DIR, 'Scripts', 'python.exe') : join(VENV_DIR, 'bin', 'python');
}

ensure(existsSync(BACKEND_DIR), `Missing vendored backend at ${BACKEND_DIR}.`);
ensure(existsSync(ENTRY), `Missing PyInstaller entry ${ENTRY}.`);
ensure(existsSync(join(BACKEND_DIR, SPEC)), `Missing ${SPEC} in ${BACKEND_DIR}.`);

if (CLEAN) {
  for (const p of [PYINST_BUILD, PYINST_DIST]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  console.log('Cleaned PyInstaller work/dist dirs.');
}
mkdirSync(OUT_DIR, { recursive: true });

// Resolve the interpreter that runs PyInstaller.
let pythonCmd;
if (AMBIENT) {
  pythonCmd = resolveBasePython();
  console.log(`\nAmbient build: using ${pythonCmd} on PATH (no isolation).`);
  try {
    execSync(`${pythonCmd} -c "import PyInstaller"`, { stdio: 'ignore', shell: true });
  } catch {
    ensure(
      false,
      `PyInstaller not installed for ${pythonCmd}. Run: ${pythonCmd} -m pip install pyinstaller==${PYINSTALLER_VERSION}`,
    );
  }
} else {
  const basePython = resolveBasePython();
  if (!existsSync(venvPython())) {
    console.log(`\nCreating isolated build venv at ${VENV_DIR} …`);
    run(`${basePython} -m venv "${VENV_DIR}"`);
  }
  pythonCmd = `"${venvPython()}"`;
  run(`${pythonCmd} -m pip install --upgrade pip wheel`);
  // Install the backend from its own pyproject — authoritative dependency set.
  run(`${pythonCmd} -m pip install "${BACKEND_DIR}"`);
  run(`${pythonCmd} -m pip install pyinstaller==${PYINSTALLER_VERSION}`);
}

// Build using the backend's own spec, from the backend dir so its relative
// pathex (".") and data-file globs resolve.
run(`${pythonCmd} -m PyInstaller ${SPEC} --noconfirm ` + `--distpath "${PYINST_DIST}" --workpath "${PYINST_BUILD}"`, {
  cwd: BACKEND_DIR,
});

const built = join(PYINST_DIST, EXE_NAME);
ensure(exists(built), `PyInstaller did not produce ${built}.`);
const dest = join(OUT_DIR, EXE_NAME);
if (existsSync(dest)) rmSync(dest);
copyFileSync(built, dest);
if (process.platform !== 'win32') chmodSync(dest, 0o755);
const provenance = await recordSidecarProvenance({
  service: 'LSAT backend',
  binaryPath: dest,
  source: 'scripts/build-lsat-binary.mjs',
  optional: false,
});

console.log(`\n✓ Bundled LSAT backend -> ${dest.split(sep).slice(-4).join(sep)}`);
console.log(`  Provenance -> ${provenance.sha256.slice(0, 12)}… (${provenance.size} bytes)`);
console.log('  StudyVault release builds include it through extraResources;');
console.log('  the Electron supervisor launches it on 127.0.0.1:8100.');
