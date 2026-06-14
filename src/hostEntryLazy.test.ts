import { describe, expect, it, vi } from 'vitest';

// Bootstraps run in a useEffect (not at import), but stub the service-worker
// registration defensively so importing the module graph is side-effect-free.
// Top-level so the hoist order is explicit.
vi.mock('./registerServiceWorker', () => ({ registerServiceWorker: () => {} }));

// S6: main.jsx mounts the host via `lazy(() => import('./host-entry.jsx'))`.
// React.lazy requires the imported module to expose a *function* `default`
// export. The earlier `.then(m => ({ default: m.HostApp }))` wrapper form left
// the Suspense boundary stuck; this asserts the canonical default-export
// contract holds so the host actually mounts under the unified root.
describe('host-entry lazy contract (S6)', () => {
  it('exposes HostApp as a function default export', async () => {
    const mod = await import('./host-entry.jsx');
    expect(typeof mod.default).toBe('function');
  });
});
