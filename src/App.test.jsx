import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
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
});
