import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('app shell', () => {
  it('renders the dashboard through the router', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    // `hidden: true` — on first run the OnboardingWizard modal is open and
    // aria-hides the main content, so the PageHeader <h1> isn't in the
    // accessible tree (the 'Knowledge Domains' getByText below also matches
    // hidden content). We're asserting the dashboard rendered, not focus order.
    // `timeout: 8000` — Dashboard is a lazy()/Suspense route, so allow generous
    // time for the chunk to resolve on slow/loaded CI.
    expect(
      await screen.findByRole('heading', { name: 'StudyVault', hidden: true }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Knowledge Domains')).toBeInTheDocument();
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
