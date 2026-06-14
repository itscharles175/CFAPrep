/*
 * Domain chunk prefetch (Plan UC3).
 *
 * StudyVault lazy-splits its two sub-apps at the React root (src/main.jsx):
 * the CFA/Quant/Excel `host` entry and the vendored `lsat` entry each resolve
 * via a separate `import()` only when their domain is first mounted. That keeps
 * the initial download lean, but it also means the first cross-domain hop pays
 * the full chunk-download cost inline (a brief DomainFallback blank).
 *
 * `prefetchDomainChunk` lets the UI WARM the inactive domain's chunk ahead of
 * that hop — e.g. on hover/focus of a cross-domain link, or idle after first
 * paint — so the eventual `import()` in main.jsx resolves from the module cache
 * instantly. It maps each domain to the SAME module specifier main.jsx lazy()s,
 * so the bundler dedupes them into one chunk (no duplicate fetch).
 *
 * Contract: pure side-effect (a warm fetch), returns nothing, and NEVER throws
 * or rejects — a failed prefetch is a non-event (the real `import()` at mount
 * time will surface any genuine load error through the normal Suspense path).
 * Safe to call repeatedly and from any environment (no-ops without a DOM/bundler
 * dynamic-import; the browser/bundler dedupes repeat calls to an in-flight or
 * resolved module).
 */

import type { Domain } from './domainNav';

/**
 * Warm the code-split chunk for a domain so the next mount of that domain is
 * instant. Side-effect only; swallows all errors. Returns a promise that always
 * resolves (callers may ignore it).
 */
export function prefetchDomainChunk(domain: Domain): Promise<void> {
  // Each branch uses a STATIC module specifier identical to the matching
  // lazy() in src/main.jsx, so the bundler resolves both to one shared chunk.
  // A dynamic specifier would defeat the bundler's chunk analysis, so keep the
  // explicit switch rather than templating the path.
  let load: Promise<unknown>;
  switch (domain) {
    case 'lsat':
      // Extensionless: strict tsc forbids a .tsx specifier (TS5097); the bundler
      // still resolves this to the same LsatRoot module/chunk as main.jsx.
      load = import('../domains/lsat/LsatRoot');
      break;
    case 'host':
      load = import('../host-entry.jsx');
      break;
    default:
      // Unknown domain: nothing to warm. Resolve quietly.
      return Promise.resolve();
  }
  // Swallow any rejection — a failed warm is a no-op, and the real import() at
  // mount time owns genuine error surfacing.
  return load.then(
    () => undefined,
    () => undefined,
  );
}
