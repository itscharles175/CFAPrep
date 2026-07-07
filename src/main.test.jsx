import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(),
  bootstrapLsatSidecarAuthToken: vi.fn(),
  applyTheme: vi.fn(),
  getStoredTheme: vi.fn(() => 'dark'),
  migrateLegacyLsatTheme: vi.fn(),
  bootstrapReadingPrefs: vi.fn(),
  bootstrapReadingTheme: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  default: {
    createRoot: mocks.createRoot,
  },
}));

vi.mock('./lib/lsatSidecarClient', () => ({
  bootstrapLsatSidecarAuthToken: mocks.bootstrapLsatSidecarAuthToken,
}));

vi.mock('./lib/theme', () => ({
  applyTheme: mocks.applyTheme,
  getStoredTheme: mocks.getStoredTheme,
  migrateLegacyLsatTheme: mocks.migrateLegacyLsatTheme,
}));

vi.mock('./lib/reading/useReadingPrefs', () => ({
  bootstrapReadingPrefs: mocks.bootstrapReadingPrefs,
}));

vi.mock('./lib/reading/readingTheme', () => ({
  bootstrapReadingTheme: mocks.bootstrapReadingTheme,
}));

vi.mock('./components/ErrorBoundary', () => ({
  default: ({ children }) => children,
}));

vi.mock('./components/UnifiedRoot.tsx', () => ({
  default: () => null,
}));

describe('main boot sequence', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    mocks.render.mockClear();
    mocks.createRoot.mockReset();
    mocks.createRoot.mockReturnValue({ render: mocks.render });
    mocks.bootstrapLsatSidecarAuthToken.mockReset();
    mocks.applyTheme.mockClear();
    mocks.getStoredTheme.mockClear();
    mocks.migrateLegacyLsatTheme.mockClear();
    mocks.bootstrapReadingPrefs.mockClear();
    mocks.bootstrapReadingTheme.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the boot fallback until LSAT sidecar auth bootstrap settles', async () => {
    let resolveBootstrap;
    const bootstrapPromise = new Promise((resolve) => {
      resolveBootstrap = resolve;
    });
    mocks.bootstrapLsatSidecarAuthToken.mockReturnValueOnce(bootstrapPromise);

    await import('./main.jsx');

    expect(mocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapLsatSidecarAuthToken).toHaveBeenCalledTimes(1);

    resolveBootstrap({ ok: true, skipped: false, tokenInjected: true });
    await bootstrapPromise;
    await Promise.resolve();

    expect(mocks.render).toHaveBeenCalledTimes(2);
  });
});
