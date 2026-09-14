import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
