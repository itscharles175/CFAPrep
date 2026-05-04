import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

function candidateUrls(specifier, parentURL) {
  const parentPath = parentURL?.startsWith('file:') ? path.dirname(fileURLToPath(parentURL)) : process.cwd();
  const basePath = specifier.startsWith('/') ? specifier : path.resolve(parentPath, specifier);
  return [
    ...EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...EXTENSIONS.map((extension) => path.join(basePath, `index${extension}`)),
  ].map((candidate) => pathToFileURL(candidate).href);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!isRelativeSpecifier(specifier)) throw error;
    const match = candidateUrls(specifier, context.parentURL).find((candidate) => existsSync(fileURLToPath(candidate)));
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
