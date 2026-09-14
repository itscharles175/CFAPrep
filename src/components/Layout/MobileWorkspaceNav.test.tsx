import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileWorkspaceNav from './MobileWorkspaceNav';

afterEach(() => {
  window.localStorage.clear();
});

describe('MobileWorkspaceNav', () => {
  it('keeps the shared workspace map available on ordinary LSAT routes', () => {
    window.localStorage.setItem('studyvault:study-context:v1', JSON.stringify({ domain: 'lsat', cfaLevel: 'level1', goal: 'balanced' }));
    render(<MemoryRouter initialEntries={['/lsat/review']}><MobileWorkspaceNav /></MemoryRouter>);

    expect(screen.getByRole('navigation', { name: 'Study workspaces' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/lsat/review');
  });

  it('keeps LSAT timed assessment routes free of global workspace controls', () => {
    render(<MemoryRouter initialEntries={['/lsat/exam/preptest-1']}><MobileWorkspaceNav /></MemoryRouter>);

    expect(screen.queryByRole('navigation', { name: 'Study workspaces' })).not.toBeInTheDocument();
  });

  it('keeps LSAT More destinations inside the LSAT surface', () => {
    window.localStorage.setItem('studyvault:study-context:v1', JSON.stringify({ domain: 'lsat', cfaLevel: 'level1', goal: 'balanced' }));
    render(<MemoryRouter initialEntries={['/lsat/dashboard']}><MobileWorkspaceNav /></MemoryRouter>);

    fireEvent.click(screen.getByLabelText('More workspaces and utilities'));

    expect(screen.getByRole('link', { name: 'Progress' })).toHaveAttribute('href', '/lsat/analytics');
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/lsat');
    expect(screen.getByRole('link', { name: 'Tutor' })).toHaveAttribute('href', '/lsat/tutor');
    expect(screen.getByRole('link', { name: 'RC Lab' })).toHaveAttribute('href', '/lsat/rc-lab');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/lsat/settings');
    expect(screen.queryByRole('link', { name: 'Vault' })).not.toBeInTheDocument();
  });
});
