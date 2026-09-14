import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { consumeStudyContextHandoff, readStudyContext } from '../../lib/studyContext';
import Sidebar from './Sidebar';

function LocationReadout() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function BackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Back</button>;
}

function renderSidebar(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
      <LocationReadout />
      <BackButton />
      <main id="main" tabIndex={-1} />
    </MemoryRouter>,
  );
}

describe('Sidebar curriculum switching', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

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

  it.each([
    ['/lsat/review', '/review', 'review'],
    ['/lsat/analytics', '/analytics', 'progress'],
  ])('keeps the selected Quant context when LSAT %s hands off to host %s', async (source, destination, workspace) => {
    const user = userEvent.setup();
    renderSidebar(source);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Track' })).toHaveValue('lsat'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'quant');

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(destination));
    expect(screen.getByRole('status')).toHaveTextContent(`Switched to Quant ${workspace}.`);
    expect(consumeStudyContextHandoff()).toMatchObject({ domain: 'quant' });
    expect(readStudyContext()).toMatchObject({ domain: 'quant' });
  });

  it.each([
    ['/quant/risk-management', 'Quant Practice', '/quant/risk-management', 'quant'],
  ])('keeps the context-safe mock action scoped on %s', async (source, label, destination, domain) => {
    const user = userEvent.setup();
    renderSidebar(source);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Track' })).toHaveValue(domain));
    const utilities = document.querySelector('details.sidebar-more summary');
    expect(utilities).toBeTruthy();
    await user.click(utilities as HTMLElement);

    const mockLink = screen.getByRole('link', { name: label });
    expect(mockLink).toHaveAttribute('href', destination);
    await user.click(mockLink);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(destination));
    expect(screen.getByRole('combobox', { name: 'Track' })).toHaveValue(domain);
  });

  it('does not repeat the primary LSAT Practice destination under utilities', async () => {
    const user = userEvent.setup();
    renderSidebar('/lsat/practice');
    await user.click(document.querySelector('details.sidebar-more summary') as HTMLElement);

    expect(screen.getAllByRole('link', { name: 'Practice' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'LSAT Practice' })).not.toBeInTheDocument();
  });

  it('uses the primary Library destination and a single specialized-tools disclosure', async () => {
    const user = userEvent.setup();
    renderSidebar('/lsat/dashboard');

    const libraryLink = screen.getByRole('link', { name: 'Library' });
    expect(libraryLink).toHaveAttribute('href', '/lsat');
    await user.click(libraryLink);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/lsat'));
    expect(screen.getByRole('button', { name: 'Collapse specialized LSAT tools' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('lets Back restore the route domain after switching CFA to LSAT', async () => {
    const user = userEvent.setup();
    renderSidebar('/cfa/level1/fixed-income');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'lsat');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/lsat/dashboard'));
    expect(screen.getByRole('combobox', { name: 'Track' })).toHaveValue('lsat');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/cfa/level1/fixed-income'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Track' })).toHaveValue('cfa'));
    expect(screen.getByRole('link', { name: 'Practice' })).toHaveAttribute('href', '/cfa/level1/mock');
  });

  it('labels the CFA mock action with the active level', async () => {
    const user = userEvent.setup();
    renderSidebar('/cfa/level2/equity');

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Level' })).toHaveValue('level2'));
    await user.click(document.querySelector('details.sidebar-more summary') as HTMLElement);

    const mockLink = screen.getByRole('link', { name: 'CFA Level II Mock Exam' });
    expect(mockLink).toHaveAttribute('href', '/cfa/level2/mock');
  });
});
