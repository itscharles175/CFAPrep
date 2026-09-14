import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, useTheme } from './theme-provider';

function ThemeProbe() {
  const { resolved } = useTheme();
  return <output>{resolved}</output>;
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('light', 'dark');
  vi.restoreAllMocks();
});

describe('LSAT ThemeProvider', () => {
  it('reads a system theme without overwriting the host-owned HTML palette state', async () => {
    window.localStorage.setItem('qv-theme', 'system');
    const matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('matchMedia', matchMedia);

    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('light'));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });
});
