import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';

function LocationReadout() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSidebar(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
      <LocationReadout />
      <main id="main" tabIndex={-1} />
    </MemoryRouter>,
  );
}

describe('Sidebar curriculum switching', () => {
  beforeEach(() => localStorage.clear());

  it('moves to the matching LSAT Learn destination and announces the switch', async () => {
    const user = userEvent.setup();
    renderSidebar('/cfa/level1/fixed-income');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'lsat');

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/lsat/dashboard'));
    expect(screen.getByRole('status')).toHaveTextContent('Switched to LSAT learn.');
  });

  it('routes a CFA level selection into that level instead of silently changing only the rail', async () => {
    const user = userEvent.setup();
    renderSidebar('/cfa/level1/fixed-income');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'level2');

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/cfa\/level2\//));
    expect(screen.getByRole('status')).toHaveTextContent('Switched to CFA Level II learn.');
  });
});
