import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TrustReleasePanel, type TrustReleasePanelProps } from './TrustReleasePanel';
import type { HostCheck, TrustManifest } from '../../hooks/useTrustManifest';

const HOST_CHECKS: HostCheck[] = [
  { key: 'offline_readiness', label: 'Offline readiness', status: 'ok', detail: '8/8 critical routes cached' },
  { key: 'dexie_quota', label: 'Local storage quota', status: 'ok', detail: '12% of quota used' },
  { key: 'lsat_backend', label: 'LSAT backend (SurrealDB sidecar)', status: 'ok', detail: 'Reachable.' },
];

function makeManifest(overrides: Partial<TrustManifest> = {}): TrustManifest {
  return {
    schema: 'lsatlab.release_trust.v1',
    tier: 'release',
    status: 'ok',
    score: 100,
    generated_at: '2026-06-15T00:00:00Z',
    checks: {
      backend_readiness: {
        status: 'ok',
        summary: 'database, schema, migrations, indexes, and pragmas are ready',
        detail: { report_status: 'ready', pragma_user_version: 7 },
        action: null,
      },
      content_health: {
        status: 'warn',
        summary: 'some content needs review',
        detail: { flagged: 3 },
        action: 'Open Content Ops and resolve flagged items.',
      },
    },
    blockers: [],
    warnings: [{ check: 'content_health', summary: 'some content needs review', action: 'Open Content Ops and resolve flagged items.' }],
    next_actions: ['Open Content Ops and resolve flagged items.'],
    ...overrides,
  };
}

function renderPanel(props: Partial<TrustReleasePanelProps> = {}) {
  const merged: TrustReleasePanelProps = {
    manifest: makeManifest(),
    loading: false,
    refreshing: false,
    reachable: true,
    hostChecks: HOST_CHECKS,
    fetchedAt: '2026-06-15T00:00:00Z',
    onRefresh: () => {},
    ...props,
  };
  return render(<TrustReleasePanel {...merged} />);
}

describe('TrustReleasePanel', () => {
  it('renders an ok rollup', () => {
    renderPanel({ manifest: makeManifest({ status: 'ok', warnings: [], next_actions: [] }) });
    expect(screen.getByText('Trust & Release')).toBeInTheDocument();
    // 'Ready' also renders on each ok host-check badge, so scope the rollup
    // assertion to the release-readiness heading (the rollup badge lives there).
    expect(within(screen.getByRole('heading', { level: 3 })).getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('score 100/100')).toBeInTheDocument();
  });

  it('renders a warning rollup', () => {
    renderPanel({ manifest: makeManifest({ status: 'warning', score: 93 }) });
    expect(screen.getByText('Warnings')).toBeInTheDocument();
    expect(screen.getByText('score 93/100')).toBeInTheDocument();
  });

  it('renders a blocked rollup', () => {
    renderPanel({
      manifest: makeManifest({
        status: 'blocked',
        score: 64,
        blockers: [{ check: 'backend_readiness', summary: 'backend not ready', action: 'Repair the local DB.' }],
        next_actions: ['Repair the local DB.'],
      }),
    });
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('score 64/100')).toBeInTheDocument();
  });

  it('lists next_actions as a bulleted list', () => {
    renderPanel();
    const list = screen.getByLabelText('Next actions');
    expect(list.tagName).toBe('UL');
    expect(screen.getByText('Open Content Ops and resolve flagged items.')).toBeInTheDocument();
  });

  it('expands the backend check tree on demand', async () => {
    const user = userEvent.setup();
    renderPanel();
    // Collapsed: the per-check summaries are not yet in the DOM.
    expect(screen.queryByText('Backend readiness')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Show 2 backend checks/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Backend readiness')).toBeInTheDocument();
    expect(screen.getByText('Content health')).toBeInTheDocument();
    // A check `action` is surfaced inside the expanded tree.
    expect(screen.getAllByText(/Action:/).length).toBeGreaterThan(0);
  });

  it('folds in host checks even when present alongside the manifest', () => {
    renderPanel();
    expect(screen.getByText('Host checks')).toBeInTheDocument();
    expect(screen.getByText('Offline readiness')).toBeInTheDocument();
    expect(screen.getByText('Local storage quota')).toBeInTheDocument();
    expect(screen.getByText('LSAT backend (SurrealDB sidecar)')).toBeInTheDocument();
  });

  it('degrades gracefully when the backend is unreachable', () => {
    renderPanel({
      manifest: null,
      reachable: false,
      hostChecks: [
        { key: 'lsat_backend', label: 'LSAT backend (SurrealDB sidecar)', status: 'blocked', detail: 'Sidecar offline.' },
      ],
    });
    expect(screen.getByText(/LSAT backend is offline/)).toBeInTheDocument();
    // Rollup falls back to the worst host-check status (blocked here). The host
    // check also renders a 'Blocked' badge, so scope to the rollup heading.
    expect(within(screen.getByRole('heading', { level: 3 })).getByText('Blocked')).toBeInTheDocument();
    // No backend check tree / next actions when the manifest is absent.
    expect(screen.queryByLabelText('Next actions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /backend checks/ })).not.toBeInTheDocument();
  });

  it('shows a loading state without a rollup badge', () => {
    renderPanel({ manifest: null, loading: true, hostChecks: [] });
    expect(screen.getByText('Loading trust manifest…')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.queryByText('Warnings')).not.toBeInTheDocument();
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('handles an empty manifest with no checks or actions', () => {
    renderPanel({
      manifest: makeManifest({ checks: {}, warnings: [], blockers: [], next_actions: [] }),
      hostChecks: [],
    });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByLabelText('Next actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Host checks')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /backend checks/ })).not.toBeInTheDocument();
  });

  it('disables the re-check button while refreshing', () => {
    renderPanel({ refreshing: true });
    const btn = screen.getByRole('button', { name: /Checking/ });
    expect(btn).toBeDisabled();
  });
});
