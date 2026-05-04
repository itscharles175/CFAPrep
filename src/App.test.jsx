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

    expect(await screen.findByRole('heading', { name: 'QuantVault' })).toBeInTheDocument();
    expect(screen.getByText('Knowledge Domains')).toBeInTheDocument();
  });

  it('renders a controlled 404 state', async () => {
    render(
      <MemoryRouter initialEntries={['/missing-route']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
