import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SourceRail } from './SourceContext';
import { buildCfaSourceBundle, buildCfaSourceTarget, importCfaSourceBundle, rebuildCfaSourceLinksForTarget } from '../lib/cfaSourceVault';
import { resetVaultData } from '../lib/progressStore';

const importedAt = '2026-05-06T12:00:00.000Z';

function documentRow() {
  return {
    id: 'source:official',
    title: 'Official Fixed Income Reading',
    level: 'level1',
    year: 2026,
    publisher: 'CFA Institute',
    sourceKind: 'official-curriculum',
    format: 'epub',
    sha256: 'hash-official',
    sizeBytes: 1000,
    canonical: true,
    coverageTags: ['level1', 'fixed-income'],
    topicIds: ['fixed-income'],
    chunkCount: 1,
    importedAt,
    privateUseOnly: true,
  };
}

function chunkRow() {
  return {
    id: 'source:official:chunk:0001',
    documentId: 'source:official',
    chunkIndex: 0,
    locator: 'reading 1',
    text: 'Duration convexity yield curve fixed income official source context for private snippets.'.repeat(8),
    normalizedText: 'duration convexity yield curve fixed income official source context for private snippets '.repeat(8),
    topicIds: ['fixed-income'],
    sourceHash: 'hash-official',
    importedAt,
  };
}

describe('SourceRail', () => {
  beforeEach(async () => {
    await resetVaultData('full');
  });

  it('renders private snippets and supports dismiss actions', async () => {
    const user = userEvent.setup();
    await importCfaSourceBundle(buildCfaSourceBundle({ documents: [documentRow()], chunks: [chunkRow()] }));
    await rebuildCfaSourceLinksForTarget(
      buildCfaSourceTarget({
        kind: 'module',
        domain: 'cfa',
        level: 'level1',
        topicId: 'fixed-income',
        title: 'Fixed income duration convexity',
      }),
    );

    render(
      <MemoryRouter>
        <SourceRail
          target={{
            kind: 'module',
            domain: 'cfa',
            level: 'level1',
            topicId: 'fixed-income',
            title: 'Fixed income duration convexity',
          }}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Official Fixed Income Reading')).toBeInTheDocument();
    expect(screen.getAllByText(/private snippets/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /dismiss source citation/i }));

    await waitFor(() => {
      expect(screen.queryByText('Official Fixed Income Reading')).not.toBeInTheDocument();
    });
  });
});
