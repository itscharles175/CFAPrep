/*
 * Domain chunk prefetch (Plan UC3).
 *
 * StudyVault lazy-splits its two planes under the unified root (<UnifiedRoot>):
 * the CFA/Quant/Excel host shell (`../App`) and the vendored LSAT plane
 * (`<LsatUnifiedMount>`) each resolve via a separate `import()` only when their
 * route is first mounted. That keeps the initial download lean, but it also means
 * the first cross-domain hop pays the full chunk-download cost inline.
 *
 * `prefetchDomainChunk` lets the UI WARM the inactive plane's chunk ahead of that
 * hop — e.g. on hover/focus of a cross-domain link, or idle after first paint —
 * so the eventual `import()` resolves from the module cache instantly. It maps
 * each domain to the SAME module the unified root lazy()s, so the bundler dedupes
 * them into one chunk (no duplicate fetch).
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
      // K4-13: the unified shell mounts the LSAT plane via <LsatUnifiedMount>
      // (the legacy LsatRoot was removed). Warm that chunk. Extensionless: strict
      // tsc forbids a .tsx specifier (TS5097); the bundler still resolves this to
      // the same module/chunk <UnifiedRoot> lazy()s.
      load = import('../components/LsatUnifiedMount');
      break;
    case 'host':
      // K4-13: <UnifiedRoot> lazy-loads the host shell as `../App`. Warming that
      // module (host-entry.jsx imports the same App, so it shares the chunk) keeps
      // a cross-domain hop into the host instant.
      load = import('../App');
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
