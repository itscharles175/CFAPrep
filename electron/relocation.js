import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizePathKey } from './path-policy.js';

// DATA-7 — app-data relocation guard (supervisor side), ported from the Tauri
// build's `src-tauri/src/relocation.rs`. A packaged Tauri install let the backend
// resolve its own store at `<os-app-data>/LSATLab/lsatlab.db`
// (`app/config._default_data_dir`); the Electron shell instead pins
// `LSATLAB_DATA_DIR` at `<userData>/lsat-backend`. Without this guard the move
// orphans every existing user's question bank.
//
// CONSERVATIVE BY DESIGN: detect and re-point only. Nothing here copies, moves,
// or clobbers a store — when a legacy bank is found and the new location is still
// empty, the sidecar is pointed at the legacy dir and reads it in place.
export const LEGACY_APP_DATA_LEAF = 'LSATLab';
export const LSAT_DATA_LEAF = 'lsat-backend';
export const LSAT_DB_FILENAME = 'lsatlab.db';

function homeDirectory(platform, env) {
  const value = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function osAppDataBase(platform, env) {
  const home = homeDirectory(platform, env);
  if (platform === 'win32') {
    if (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) return env.APPDATA;
    return home ? path.join(home, 'AppData', 'Roaming') : null;
  }
  if (platform === 'darwin') {
    return home ? path.join(home, 'Library', 'Application Support') : null;
  }
  if (typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.length > 0) return env.XDG_DATA_HOME;
  return home ? path.join(home, '.local', 'share') : null;
}

export function legacyLsatDataDir({ platform = process.platform, env = process.env } = {}) {
  const base = osAppDataBase(platform, env);
  return base ? path.join(base, LEGACY_APP_DATA_LEAF) : null;
}

export function lsatStorePath(dataDir) {
  return path.join(dataDir, LSAT_DB_FILENAME);
}

// A 0-byte stub counts as ABSENT so a real legacy bank can still be adopted, and
// so a freshly created empty file never masks one.
export function isNonEmptyLsatStore(dataDir, statFile = statSync) {
  try {
    const info = statFile(lsatStorePath(dataDir));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function resolveLsatDataDir({
  userDataPath,
  platform = process.platform,
  env = process.env,
  statFile = statSync,
  logger = null,
}) {
  const currentDir = path.join(userDataPath, LSAT_DATA_LEAF);
  const legacyDir = legacyLsatDataDir({ platform, env });
  const samePath =
    legacyDir !== null && normalizePathKey(legacyDir, platform) === normalizePathKey(currentDir, platform);
  const relocated =
    legacyDir !== null &&
    !samePath &&
    isNonEmptyLsatStore(legacyDir, statFile) &&
    !isNonEmptyLsatStore(currentDir, statFile);
  const decision = { dataDir: relocated ? legacyDir : currentDir, currentDir, legacyDir, relocated, samePath };
  logger?.info('lsat_data_dir_resolved', decision);
  return decision;
}
