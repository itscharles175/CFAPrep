import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VaultCenter from './VaultCenter';

const mocks = vi.hoisted(() => ({
  useStudyContext: vi.fn(),
}));

vi.mock('../lib/studyContext', () => ({
  useStudyContext: mocks.useStudyContext,
}));

vi.mock('../lib/learning', () => ({
  deleteNote: vi.fn(),
  getBookmarks: vi.fn().mockResolvedValue([]),
  getNotes: vi.fn().mockResolvedValue([]),
  getResultArtifacts: vi.fn().mockResolvedValue([]),
  saveNote: vi.fn(),
  toggleBookmark: vi.fn(),
}));

vi.mock('../lib/cfaSourceVault', () => ({
  deleteAllCfaSourceVault: vi.fn(),
  deleteCfaSourceDocument: vi.fn(),
  getCfaSourceCoverageMap: vi.fn().mockResolvedValue({ documentCount: 1, chunkCount: 4, levelCounts: { level1: 1, level2: 0, level3: 0 } }),
  getCfaSourceDocuments: vi.fn().mockResolvedValue([{ id: 'cfa-source', title: 'Ethics', level: 'level1', publisher: 'CFA Institute', sourceKind: 'official-curriculum', chunkCount: 4, canonical: true }]),
  getCfaSourceMapStatus: vi.fn().mockResolvedValue({ linkCount: 2 }),
  importCfaSourceBundle: vi.fn(),
  searchCfaSourceVault: vi.fn().mockResolvedValue([]),
}));

vi.mock('../components/SourceContext', () => ({
  SourceLinkManager: () => <button type="button">Rebuild CFA source map</button>,
  SourceMapStatus: () => <span>2 source links</span>,
}));

function renderVault() {
  return render(
    <MemoryRouter>
      <VaultCenter />
    </MemoryRouter>,
  );
}

describe('VaultCenter source scope', () => {
  beforeEach(() => {
    mocks.useStudyContext.mockReset();
  });

  it('hides CFA-only source operations while LSAT is the active study context', async () => {
    mocks.useStudyContext.mockReturnValue([{ domain: 'lsat', cfaLevel: 'level1', goal: 'balanced' }]);
    renderVault();

    expect(await screen.findByText('Source Scope & Provenance')).toBeInTheDocument();
    expect(screen.getByText('Active study context: LSAT')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open LSAT workspace' })).toHaveAttribute('href', '/lsat');
    expect(screen.queryByText('Import CFA source bundle')).not.toBeInTheDocument();
    expect(screen.queryByText('Rebuild CFA source map')).not.toBeInTheDocument();
  });

  it('shows CFA source operations with source-domain and provenance badges in CFA context', async () => {
    mocks.useStudyContext.mockReturnValue([{ domain: 'cfa', cfaLevel: 'level1', goal: 'balanced' }]);
    renderVault();

    expect(await screen.findByText('Import CFA source bundle')).toBeInTheDocument();
    expect(screen.getByLabelText('Search private CFA curriculum sources')).toBeInTheDocument();
    expect(screen.getByText('Official curriculum')).toBeInTheDocument();
    expect(screen.getAllByText('CFA').length).toBeGreaterThan(0);
  });
});
