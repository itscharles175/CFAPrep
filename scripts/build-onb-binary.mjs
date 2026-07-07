#!/usr/bin/env node
/*
 * Build the open-notebook FastAPI backend into a platform-native binary
 * via PyInstaller, then copy it into `src-tauri/resources/services/`
 * where `tauri.conf.json` -> `bundle.resources` will pick it up and ship
 * it inside the .msi / .dmg / .deb installer.
 *
 * Usage:
 *   node scripts/build-onb-binary.mjs               # isolated-venv build (default)
 *   node scripts/build-onb-binary.mjs --ambient     # build against Python on PATH
 *   node scripts/build-onb-binary.mjs --debug       # keep PyInstaller temp files
 *   node scripts/build-onb-binary.mjs --clean       # rm -rf build/ + dist/
 *
 * Prerequisites:
 *   - Python 3.11 or 3.12 on PATH (a base interpreter; the default mode then
 *     creates an isolated `.venv-onb` and installs everything into it).
 *   - Network access on first run, to install open-notebook's dependency tree.
 *
 * Default (isolated-venv) mode provisions `.venv-onb` and runs:
 *     pip install "spike/open-notebook"     # authoritative deps from pyproject
 *     pip install pyinstaller==6.20.0
 * so the build never depends on — or mutates — the global site-packages. Use
 * `--ambient` only when the Python on PATH already carries open-notebook's full
 * (langchain 1.x + surrealdb) tree.
 *
 * Output paths (relative to repo root):
 *   - Windows:  src-tauri/resources/services/open-notebook/open-notebook.exe
 *   - macOS:    src-tauri/resources/services/open-notebook/open-notebook
 *   - Linux:    src-tauri/resources/services/open-notebook/open-notebook
 *
 * Production runtime: services_dir() in src-tauri/src/lib.rs already searches
 *   exe_dir/resources/services/  (Windows / Linux)
 *   exe_dir/../Resources/services/  (macOS bundle)
 * so once the binary lands in those slots it boots automatically as a sidecar.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOpenNotebookSourcePin } from './check-onb-source-pin.mjs';
import { recordSidecarProvenance } from './sidecar-provenance.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '..', '..');
const ONB_DIR = join(REPO_ROOT, 'spike', 'open-notebook');
const ENTRY = join(ONB_DIR, 'api', 'main.py');
const PYINST_BUILD = join(REPO_ROOT, '.pyinstaller-build');
const PYINST_DIST = join(REPO_ROOT, '.pyinstaller-dist');
const PYINST_SPEC_NAME = 'open-notebook';
const OUT_DIR = join(REPO_ROOT, 'src-tauri', 'resources', 'services', 'open-notebook');

const args = new Set(process.argv.slice(2));
const DEBUG = args.has('--debug');
const CLEAN = args.has('--clean');
// Build target environment:
//   default (--venv) : provision an ISOLATED .venv-onb from open-notebook's
//                      own pyproject, so the dep set is authoritative + never
//                      drifts and the user's global Python is never touched.
//   --ambient        : build against whatever Python is already on PATH. Fast
//                      for dev, but only correct if that env happens to carry
//                      open-notebook's full (langchain 1.x + surrealdb) tree.
const AMBIENT = args.has('--ambient');
const VENV_DIR = join(REPO_ROOT, '.venv-onb');
const PYINSTALLER_VERSION = '6.20.0';

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts });
}

function ensure(condition, message) {
  if (!condition) {
    console.error(`\nERROR: ${message}\n`);
    process.exit(1);
  }
}

function exists(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function gitOutput(args) {
  try {
    return (
      execSync(`git -C "${ONB_DIR}" ${args}`, {
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Resolve a base Python interpreter on PATH (python, then python3). */
function resolveBasePython() {
  for (const cmd of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore', shell: true });
      return cmd;
    } catch {
      /* try next */
    }
  }
  ensure(false, "Neither 'python' nor 'python3' is on PATH. Install Python 3.11+ and re-run.");
  return 'python'; // unreachable
}

/** Path to the venv's python executable for the current platform. */
function venvPython() {
  return process.platform === 'win32'
    ? join(VENV_DIR, 'Scripts', 'python.exe')
    : join(VENV_DIR, 'bin', 'python');
}

ensure(existsSync(ONB_DIR), `Could not find spike/open-notebook/ at ${ONB_DIR}. Clone it before running this script.`);
ensure(existsSync(ENTRY), `Could not find FastAPI entry at ${ENTRY}.`);

const expectedOnbRef = process.env.ONB_GIT_SHA || process.env.ONB_GIT_REF || '';
if (expectedOnbRef || process.env.CI) {
  const pin = checkOpenNotebookSourcePin({ dir: ONB_DIR, expectedRef: expectedOnbRef });
  ensure(pin.ok, pin.errors.join('; '));
}
const onbSourceHead = gitOutput('rev-parse HEAD');

if (CLEAN) {
  for (const p of [PYINST_BUILD, PYINST_DIST]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  console.log('Cleaned PyInstaller working dirs.');
}

mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Resolve the Python interpreter that will run PyInstaller.
//
// Isolated-venv mode (default) is the reproducible path: it installs
// open-notebook's pyproject (the authoritative dep set) + PyInstaller into a
// dedicated .venv-onb, so the build never depends on — or mutates — the user's
// global site-packages. The global env on a dev box typically carries
// cross-project version pins (e.g. an old `websockets` held back by an
// unrelated editable install) that conflict with open-notebook's needs.
// ---------------------------------------------------------------------------
let pythonCmd;
if (AMBIENT) {
  pythonCmd = resolveBasePython();
  console.log(`\nAmbient build: using ${pythonCmd} on PATH (no isolation).`);
  try {
    execSync(`${pythonCmd} -c "import PyInstaller"`, { stdio: 'ignore', shell: true });
  } catch {
    ensure(false, `PyInstaller not installed for ${pythonCmd}. Run: ${pythonCmd} -m pip install pyinstaller==${PYINSTALLER_VERSION}`);
  }
} else {
  const basePython = resolveBasePython();
  if (!existsSync(venvPython())) {
    console.log(`\nCreating isolated build venv at ${VENV_DIR} …`);
    run(`${basePython} -m venv "${VENV_DIR}"`);
  }
  pythonCmd = `"${venvPython()}"`;
  run(`${pythonCmd} -m pip install --upgrade pip wheel`);
  // Install open-notebook from its own checkout — authoritative dep set, never
  // a hand-maintained drift-prone pin list.
  run(`${pythonCmd} -m pip install "${ONB_DIR}"`);
  run(`${pythonCmd} -m pip install pyinstaller==${PYINSTALLER_VERSION}`);
}

// Build the spec file dynamically — we keep the spec out of the open-notebook
// checkout so we never accidentally commit it to the wrong repo.
//
// Static hidden imports: modules PyInstaller's static analysis reliably misses
// (uvicorn's lazy loop/protocol selection, sqlalchemy dialects).
const HIDDEN_IMPORTS = [
  'uvicorn',
  'uvicorn.logging',
  'uvicorn.loops',
  'uvicorn.loops.auto',
  'uvicorn.protocols',
  'uvicorn.protocols.http.auto',
  'uvicorn.protocols.websockets.auto',
  'uvicorn.lifespan.on',
  'fastapi',
  'pydantic',
  'pydantic_settings',
  'sqlmodel',
  'sqlalchemy',
  'sqlalchemy.dialects.sqlite',
  'aiohttp',
  'httpx',
];

// Packages with heavy DYNAMIC imports (langchain's plugin discovery,
// open-notebook's router/command auto-loading). A static hidden-imports list
// can't keep up with these — `collect_all` pulls every submodule + data file +
// dist metadata, which is what fixes the runtime `ModuleNotFoundError`
// cascade (e.g. `langchain_text_splitters`, imported deep inside
// open_notebook.utils.chunking). Each name is collect_all'd in the spec; a
// package that isn't installed is skipped with a warning rather than failing
// the whole build.
const COLLECT_ALL_PACKAGES = [
  // open-notebook's own namespace packages (routers/commands auto-load)
  'open_notebook',
  'api',
  'commands',
  // open-notebook companion libs that ship data files (YAML configs, prompt
  // templates). content_core.config does pkgutil.get_data('content_core',
  // 'models_config.yaml') at import — collect_all bundles those data files.
  'content_core',
  'esperanto',
  'ai_prompter',
  'surreal_commands',
  // langchain ecosystem — dynamic provider/splitter discovery
  'langchain',
  'langchain_core',
  'langchain_community',
  'langchain_text_splitters',
  'langchain_openai',
  'langchain_ollama',
  'langgraph',
  // SurrealDB Python client — pulls websockets.sync / connection submodules
  // that PyInstaller's static pass misses (the import that crashed the
  // ambient build at open_notebook.database.repository).
  'surrealdb',
  'websockets',
  // numpy ships compiled extensions + .libs that must travel with the binary
  'numpy',
  // tokeniser ships data files (tiktoken .bpe blobs)
  'tiktoken',
  'tiktoken_ext',
  // mypyc-compiled wheels — their hashed top-level __mypyc .pyd/.so extensions
  // live at the site-packages ROOT (outside the package dir), so collect_all
  // alone misses them; the root-glob below catches those, but collecting the
  // packages too pulls their pure-Python halves + metadata.
  'packaging',
  'chardet',
  // open-notebook's podcast path (podcast_creator → moviepy → imageio) is
  // imported eagerly by commands/podcast_commands.py and raises if absent.
  // QuantVault drives audio locally via kokoro-js, but the backend still
  // imports this chain at load, so it must be bundled.
  'podcast_creator',
  'moviepy',
  'imageio',
];

// Packages that do a runtime importlib.metadata.version() lookup on
// themselves at import time — PyInstaller bundles the code but not the
// .dist-info, so the lookup raises PackageNotFoundError unless we copy the
// metadata explicitly. (imageio crashed the bundled boot this way.)
const COPY_METADATA_PACKAGES = [
  'imageio',
  'moviepy',
  'podcast_creator',
  'numpy',
  'tqdm',
  'langchain',
  'langchain_core',
];

const SPEC_PATH = join(REPO_ROOT, `${PYINST_SPEC_NAME}.spec`);

const specContent = `# -*- mode: python ; coding: utf-8 -*-
# Auto-generated by scripts/build-onb-binary.mjs — DO NOT EDIT BY HAND.
import os
from PyInstaller.utils.hooks import collect_all, copy_metadata

block_cipher = None
ONB_DIR = r'${ONB_DIR.replace(/\\/g, '/')}'
ENTRY  = r'${ENTRY.replace(/\\/g, '/')}'

# collect_all() each dynamic-import-heavy package, tolerating absent ones so a
# slimmer install still builds (the package just won't be bundled).
_collect_packages = ${JSON.stringify(COLLECT_ALL_PACKAGES)}
_datas, _binaries, _hidden = [], [], list(${JSON.stringify(HIDDEN_IMPORTS)})
for _pkg in _collect_packages:
    try:
        _d, _b, _h = collect_all(_pkg)
        _datas += _d
        _binaries += _b
        _hidden += _h
    except Exception as _e:  # noqa: BLE001 — best-effort collection
        print(f"[build-onb-binary] skip collect_all({_pkg!r}): {_e}")

# mypyc-compiled wheels (packaging, chardet, …) drop hashed top-level
# extension modules like '3c22db…__mypyc.cp312-win_amd64.pyd' directly into
# site-packages ROOT. They're imported by name at runtime but live outside any
# package dir, so collect_all misses them and the binary dies with
# "No module named '<hash>__mypyc'". Glob them in explicitly, landing each at
# the bundle root ('.') where Python's import machinery expects them.
import glob, sysconfig
for _site in {sysconfig.get_paths().get('purelib'), sysconfig.get_paths().get('platlib')}:
    if not _site:
        continue
    for _ext in ('*__mypyc*.pyd', '*__mypyc*.so'):
        for _so in glob.glob(os.path.join(_site, _ext)):
            _binaries.append((_so, '.'))
            print(f"[build-onb-binary] bundling root mypyc ext: {os.path.basename(_so)}")

# Copy .dist-info metadata for packages that introspect their own version at
# import time (otherwise importlib.metadata raises PackageNotFoundError).
for _meta_pkg in ${JSON.stringify(COPY_METADATA_PACKAGES)}:
    try:
        _datas += copy_metadata(_meta_pkg)
    except Exception as _e:  # noqa: BLE001
        print(f"[build-onb-binary] skip copy_metadata({_meta_pkg!r}): {_e}")

a = Analysis(
    [ENTRY],
    pathex=[ONB_DIR],
    binaries=_binaries,
    datas=_datas,
    hiddenimports=_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='${PYINST_SPEC_NAME}',
    debug=${DEBUG ? 'True' : 'False'},
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
`;

console.log(`\nWriting spec file: ${SPEC_PATH}`);
const { writeFileSync } = await import('node:fs');
writeFileSync(SPEC_PATH, specContent);

// Build.
run(
  `${pythonCmd} -m PyInstaller ${PYINST_SPEC_NAME}.spec --noconfirm ` +
    `--distpath "${PYINST_DIST}" --workpath "${PYINST_BUILD}"` +
    (DEBUG ? ' --log-level DEBUG' : ''),
  { cwd: REPO_ROOT },
);

// Copy result into src-tauri/resources/services/open-notebook/.
const exeName = process.platform === 'win32' ? `${PYINST_SPEC_NAME}.exe` : PYINST_SPEC_NAME;
const built = join(PYINST_DIST, exeName);
ensure(exists(built), `PyInstaller did not produce ${built}.`);

const dest = join(OUT_DIR, exeName);
if (existsSync(dest)) rmSync(dest);
const { copyFileSync, chmodSync } = await import('node:fs');
copyFileSync(built, dest);
if (process.platform !== 'win32') chmodSync(dest, 0o755);
const provenance = await recordSidecarProvenance({
  service: 'open-notebook binary',
  binaryPath: dest,
  source: onbSourceHead ? `spike/open-notebook@${onbSourceHead}` : 'scripts/build-onb-binary.mjs',
  optional: true,
});

console.log(`\n✓ Bundled open-notebook binary -> ${dest.split(sep).slice(-4).join(sep)}`);
console.log(`  Provenance -> ${provenance.sha256.slice(0, 12)}… (${provenance.size} bytes)`);
console.log(`  Tauri release builds will now include it under bundle.resources.`);
