import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const SOURCE_EXTENSION_SPECIFIERS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

function candidateUrls(specifier, parentURL) {
  const parentPath = parentURL?.startsWith('file:') ? path.dirname(fileURLToPath(parentURL)) : process.cwd();
  const basePath = specifier.startsWith('/') ? specifier : path.resolve(parentPath, specifier);
  const explicitExtension = path.extname(basePath);
  const basePaths = SOURCE_EXTENSION_SPECIFIERS.has(explicitExtension)
    ? [basePath, basePath.slice(0, -explicitExtension.length)]
    : [basePath];
  const candidates = basePaths.flatMap((candidateBase) => [
    candidateBase,
    ...EXTENSIONS.map((extension) => `${candidateBase}${extension}`),
    ...EXTENSIONS.map((extension) => path.join(candidateBase, `index${extension}`)),
  ]);
  return [...new Set(candidates)].map((candidate) => pathToFileURL(candidate).href);
}

function isFileUrl(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!isRelativeSpecifier(specifier)) throw error;
    const match = candidateUrls(specifier, context.parentURL).find((candidate) => isFileUrl(candidate));
    if (!match) throw error;
    return { url: match, shortCircuit: true };
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts') && !url.endsWith('.tsx')) {
    return nextLoad(url, context);
  }

  const source = await readFile(fileURLToPath(url), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      isolatedModules: true,
    },
    fileName: fileURLToPath(url),
  });

  return {
    format: 'module',
    source: transpiled.outputText,
    shortCircuit: true,
  };
}
