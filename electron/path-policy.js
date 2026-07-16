import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const FILE_ENTRY_CAP = 100_000;
export const FILE_READ_CAP_BYTES = 50 * 1024 * 1024;
export const ALLOWED_FILE_EXTENSIONS = Object.freeze(new Set(['.pdf', '.txt']));

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

export function extractLaunchFilePaths(argv, cwd) {
  const seen = new Set();
  const paths = [];
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length === 0 || argument.startsWith('-')) continue;
    const candidate = path.isAbsolute(argument) ? path.normalize(argument) : path.resolve(cwd, argument);
    if (!ALLOWED_FILE_EXTENSIONS.has(extensionFor(candidate))) continue;
    const key = normalizePathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(candidate);
  }
  return paths;
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

  constructor({ entryCap = FILE_ENTRY_CAP } = {}) {
    if (!Number.isSafeInteger(entryCap) || entryCap < 1 || entryCap > FILE_ENTRY_CAP) {
      throw new Error(`Entry cap must be between 1 and ${FILE_ENTRY_CAP}`);
    }
    this.entryCap = entryCap;
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

    while (stack.length > 0) {
      const directory = stack.pop();
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        visited += 1;
        if (visited > this.entryCap) {
          throw new Error(`Folder scan exceeded the ${this.entryCap} entry cap`);
        }

        const candidate = path.join(directory, child.name);
        if (child.isSymbolicLink()) {
          throw new Error(`Folder scan rejected a symbolic link: ${candidate}`);
        }
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) {
          throw new Error(`Folder scan rejected a symbolic link: ${candidate}`);
        }
        if (info.isDirectory()) {
          const canonicalDirectory = await realpath(candidate);
          if (!isPathWithin(root, canonicalDirectory)) {
            throw new Error(`Folder scan escaped its authorized root: ${candidate}`);
          }
          stack.push(canonicalDirectory);
          continue;
        }
        if (!info.isFile() || extensionFor(candidate) !== '.pdf') continue;

        const canonicalFile = await realpath(candidate);
        if (!isPathWithin(root, canonicalFile)) {
          throw new Error(`Folder scan escaped its authorized root: ${candidate}`);
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
    return entries;
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
