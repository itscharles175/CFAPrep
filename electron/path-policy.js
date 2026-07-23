import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const FILE_ENTRY_CAP = 100_000;
export const FILE_READ_CAP_BYTES = 50 * 1024 * 1024;
export const ALLOWED_FILE_EXTENSIONS = Object.freeze(new Set(['.pdf', '.txt']));
export const DEEP_LINK_PROTOCOL = 'studyvault:';

// A single letter before the colon is a Windows drive (`C:\study\a.pdf`), not a
// URL scheme, so this requires at least two scheme characters. Widening it to
// `*` would make every Windows launch path look like a URL.
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+:/i;
// Deep links address in-app routes only: no drive letters, no separators inside
// a segment, and no `.`/`..` (the leading class excludes both).
const DEEP_LINK_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const DEEP_LINK_ACTIONS = Object.freeze(new Set(['open', 'route']));

export function normalizePathKey(input, platform = process.platform) {
  const normalized = path.normalize(path.resolve(input));
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function isPathWithin(root, candidate, platform = process.platform) {
  const rootKey = normalizePathKey(root, platform);
  const candidateKey = normalizePathKey(candidate, platform);
  const relative = path.relative(rootKey, candidateKey);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function extensionFor(input) {
  return path.extname(input).toLocaleLowerCase('en-US');
}

function hasParentSegment(argument) {
  return argument.split(/[\\/]/).includes('..');
}

/**
 * Launch arguments only ever name files the OS already resolved for us, so this
 * accepts absolute paths and nothing else. Resolving relative arguments against
 * the cwd, or letting a URL through, would let a crafted argv entry or a
 * `studyvault://` deep link authorize a read outside every picked folder.
 */
export function extractLaunchFilePaths(argv) {
  const seen = new Set();
  const paths = [];
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length === 0 || argument.startsWith('-')) continue;
    if (URL_SCHEME_PATTERN.test(argument) || !path.isAbsolute(argument)) continue;
    // Checked before normalization: normalize() collapses `..` inside an absolute
    // path, so a post-normalize check would silently accept `<root>\..\..\secret.pdf`.
    if (hasParentSegment(argument)) continue;
    const candidate = path.normalize(argument);
    if (!ALLOWED_FILE_EXTENSIONS.has(extensionFor(candidate))) continue;
    const key = normalizePathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(candidate);
  }
  return paths;
}

/**
 * Parse a `studyvault://` deep link into an in-app route. Deep links are routed
 * by action (hostname) and route (pathname) and are never treated as filesystem
 * paths, so they can never reach the launch-file authorizer.
 */
export function parseDeepLink(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== DEEP_LINK_PROTOCOL) return null;
  // Non-special schemes keep the authority's case, so normalize before matching.
  const action = url.hostname.toLocaleLowerCase('en-US');
  if (!DEEP_LINK_ACTIONS.has(action)) return null;
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (!segments.every((segment) => DEEP_LINK_SEGMENT_PATTERN.test(segment))) return null;
  return { action, route: `/${segments.join('/')}`, href: url.href };
}

export function extractDeepLinks(argv) {
  const links = [];
  for (const argument of argv) {
    const link = parseDeepLink(argument);
    if (link) links.push(link);
  }
  return links;
}

async function canonicalNonSymlink(input, expectedType) {
  const absolute = path.resolve(input);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not authorized: ${absolute}`);
  if (expectedType === 'file' && !info.isFile()) throw new Error(`Not a regular file: ${absolute}`);
  if (expectedType === 'directory' && !info.isDirectory()) throw new Error(`Not a directory: ${absolute}`);
  const canonical = await realpath(absolute);
  const canonicalInfo = await lstat(canonical);
  if (canonicalInfo.isSymbolicLink()) throw new Error(`Symbolic links are not authorized: ${absolute}`);
  return { canonical, info: canonicalInfo };
}

function fileDescriptor(canonical, info) {
  return {
    path: canonical,
    name: path.basename(canonical),
    extension: extensionFor(canonical),
    size: info.size,
  };
}

export class PathAuthorization {
  #roots = new Map();
  #files = new Map();

  // `statEntry`/`readDirectory` are seams for the recursive scan only — the
  // authorization boundary itself always uses the real lstat/realpath.
  constructor({ entryCap = FILE_ENTRY_CAP, statEntry = lstat, readDirectory = readdir } = {}) {
    if (!Number.isSafeInteger(entryCap) || entryCap < 1 || entryCap > FILE_ENTRY_CAP) {
      throw new Error(`Entry cap must be between 1 and ${FILE_ENTRY_CAP}`);
    }
    this.entryCap = entryCap;
    this.statEntry = statEntry;
    this.readDirectory = readDirectory;
  }

  get authorizedRootCount() {
    return this.#roots.size;
  }

  get authorizedFileCount() {
    return this.#files.size;
  }

  async authorizePickedRoot(input) {
    const { canonical } = await canonicalNonSymlink(input, 'directory');
    this.#roots.set(normalizePathKey(canonical), canonical);
    return canonical;
  }

  async authorizePickedFiles(inputs) {
    return this.#authorizeFiles(inputs, ALLOWED_FILE_EXTENSIONS, 'picked');
  }

  async authorizeLaunchFiles(inputs) {
    return this.#authorizeFiles(inputs, ALLOWED_FILE_EXTENSIONS, 'launch');
  }

  async authorizeDroppedPdfs(inputs) {
    return this.#authorizeFiles(inputs, new Set(['.pdf']), 'drop');
  }

  async #authorizeFiles(inputs, allowedExtensions, source) {
    const descriptors = [];
    for (const input of inputs) {
      const { canonical, info } = await canonicalNonSymlink(input, 'file');
      const extension = extensionFor(canonical);
      if (!allowedExtensions.has(extension)) {
        throw new Error(`${source} file type is not allowed: ${extension || '<none>'}`);
      }
      this.#files.set(normalizePathKey(canonical), { path: canonical, source });
      descriptors.push(fileDescriptor(canonical, info));
    }
    return descriptors;
  }

  async listPdfs(inputRoot) {
    const { canonical: root } = await canonicalNonSymlink(inputRoot, 'directory');
    if (!this.#roots.has(normalizePathKey(root))) {
      throw new Error('Folder has not been authorized by the native folder picker');
    }

    const entries = [];
    const stack = [root];
    let visited = 0;
    let skippedLinks = 0;
    let skippedOversize = 0;
    let skippedErrors = 0;

    while (stack.length > 0) {
      const directory = stack.pop();
      let children;
      try {
        children = await this.readDirectory(directory, { withFileTypes: true });
      } catch (error) {
        // An unreadable picked root is a real failure the user must see; deeper
        // directories are skipped so one bad subtree cannot abort a whole import.
        if (directory === root) throw error;
        skippedErrors += 1;
        continue;
      }
      for (const child of children) {
        visited += 1;
        if (visited > this.entryCap) {
          throw new Error(`Folder scan exceeded the ${this.entryCap} entry cap`);
        }

        const candidate = path.join(directory, child.name);
        if (child.isSymbolicLink()) {
          skippedLinks += 1;
          continue;
        }
        let info;
        try {
          info = await this.statEntry(candidate);
        } catch {
          skippedErrors += 1;
          continue;
        }
        if (info.isSymbolicLink()) {
          skippedLinks += 1;
          continue;
        }
        if (info.isDirectory()) {
          let canonicalDirectory;
          try {
            canonicalDirectory = await realpath(candidate);
          } catch {
            skippedErrors += 1;
            continue;
          }
          // A canonical path outside the root means a reparse point lstat did not
          // flag; skipping that subtree refuses it without failing the whole scan.
          if (!isPathWithin(root, canonicalDirectory)) {
            skippedLinks += 1;
            continue;
          }
          stack.push(canonicalDirectory);
          continue;
        }
        if (!info.isFile() || extensionFor(candidate) !== '.pdf') continue;
        if (info.size > FILE_READ_CAP_BYTES) {
          skippedOversize += 1;
          continue;
        }

        let canonicalFile;
        try {
          canonicalFile = await realpath(candidate);
        } catch {
          skippedErrors += 1;
          continue;
        }
        if (!isPathWithin(root, canonicalFile)) {
          skippedLinks += 1;
          continue;
        }
        entries.push({
          ...fileDescriptor(canonicalFile, info),
          relative_path: path.relative(root, canonicalFile),
        });
      }
    }

    entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
    for (const entry of entries) {
      this.#files.set(normalizePathKey(entry.path), { path: entry.path, source: 'listed' });
    }
    // The skip counters ride on the rows array rather than a wrapper object so the
    // listing keeps its array shape end to end; structured clone copies own
    // properties of an array, so they survive the IPC hop to the renderer.
    return Object.assign(entries, {
      skipped_links: skippedLinks,
      skipped_oversize: skippedOversize,
      skipped_errors: skippedErrors,
    });
  }

  async resolveAuthorizedFile(input) {
    const { canonical, info } = await canonicalNonSymlink(input, 'file');
    if (!ALLOWED_FILE_EXTENSIONS.has(extensionFor(canonical))) {
      throw new Error('Only PDF and TXT files can be read');
    }
    if (!this.#files.has(normalizePathKey(canonical))) {
      throw new Error('File has not been authorized by a native user action');
    }
    return { canonical, info };
  }

  async resolveAuthorizedOpenPath(input) {
    const absolute = path.resolve(input);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be opened');
    const canonical = await realpath(absolute);
    const key = normalizePathKey(canonical);
    if (info.isDirectory() && this.#roots.has(key)) return canonical;
    if (info.isFile() && this.#files.has(key)) return canonical;
    throw new Error('Path has not been authorized by a native user action');
  }

  async readAuthorizedFile(input) {
    const { canonical, info } = await this.resolveAuthorizedFile(input);
    if (info.size > FILE_READ_CAP_BYTES) {
      throw new Error(`File exceeds the ${FILE_READ_CAP_BYTES} byte read cap`);
    }

    const handle = await open(canonical, 'r');
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size !== info.size || openedInfo.size > FILE_READ_CAP_BYTES) {
        throw new Error('File changed while it was being authorized');
      }
      const data = await handle.readFile();
      if (data.byteLength !== openedInfo.size) throw new Error('File changed while it was being read');
      return { ...fileDescriptor(canonical, openedInfo), data: new Uint8Array(data) };
    } finally {
      await handle.close();
    }
  }
}

export class NativeFileAccess {
  constructor({ dialog, authorization = new PathAuthorization() }) {
    this.dialog = dialog;
    this.authorization = authorization;
  }

  async pickFolder(owner) {
    const result = await this.dialog.showOpenDialog(owner, {
      title: 'Choose Study Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.authorization.authorizePickedRoot(result.filePaths[0]);
  }

  async pickFiles(owner) {
    const result = await this.dialog.showOpenDialog(owner, {
      title: 'Choose Study Files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Study Files', extensions: ['pdf', 'txt'] }],
    });
    if (result.canceled) return [];
    return this.authorization.authorizePickedFiles(result.filePaths);
  }
}
