import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';

describe('app shell', () => {
  it('renders Today as the canonical root experience', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    // `hidden: true` — on first run the OnboardingWizard modal may be open and
    // aria-hide the main content. We're asserting Today rendered, not focus order.
    // `timeout: 8000` — Today is a lazy()/Suspense route, so allow generous
    // time for the chunk to resolve on slow/loaded CI.
    expect(
      await screen.findByRole('heading', { name: 'Today', hidden: true }, { timeout: 8000 }),
    ).toBeInTheDocument();
  }, 15000); // overall test budget > the lazy-chunk wait, for full-suite concurrency

  it('renders a controlled 404 state', async () => {
    render(
      <MemoryRouter initialEntries={['/missing-route']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('applies the native View menu sidebar command', async () => {
    let toggleSidebar;
    window.studyvault = {
      events: {
        onSidebarToggle(handler) {
          toggleSidebar = handler;
          return () => { toggleSidebar = undefined; };
        },
      },
    };
    const { unmount } = render(
      <MemoryRouter initialEntries={['/missing-route']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();

    // Main's visibility hint may be stale after restored renderer state. Each
    // menu command must invert the actual renderer state.
    act(() => toggleSidebar?.({ visible: true }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    act(() => toggleSidebar?.({ visible: false }));
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();

    unmount();
    delete window.studyvault;
  });

  it('contains keyboard focus and the accessibility tree while the mobile drawer is open', async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query) => ({
        matches: query === '(max-width: 900px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    });

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={['/missing-route']}>
          <App />
        </MemoryRouter>,
      );
      const menu = await screen.findByRole('button', { name: 'Open navigation' });
      await user.click(menu);
      await waitFor(() => expect(document.querySelector('#main-sidebar')).not.toHaveAttribute('hidden'));
      expect(document.querySelector('.topbar')).toHaveAttribute('inert');
      expect(document.querySelector('#main')).toHaveAttribute('inert');
      await user.tab();
      expect(document.querySelector('#main-sidebar')).toContainElement(document.activeElement);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(menu).toHaveFocus());
      expect(document.querySelector('#main')).not.toHaveAttribute('inert');
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: previousMatchMedia });
    }
  });
});
