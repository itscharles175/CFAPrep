import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCfaSourceDocuments: vi.fn(),
  getCfaSourceChunks: vi.fn(),
  getOpenNotebookSettings: vi.fn(),
  listSources: vi.fn(),
  getNotes: vi.fn(),
  getNote: vi.fn(),
  saveNote: vi.fn(),
  getLlmSettings: vi.fn(),
  localGroundedAnswer: vi.fn(),
  chatWithSource: vi.fn(),
}));

vi.mock('../lib/cfaSourceVault', () => ({
  getCfaSourceDocuments: mocks.getCfaSourceDocuments,
  getCfaSourceChunks: mocks.getCfaSourceChunks,
}));
vi.mock('../lib/learning', () => ({ getNotes: mocks.getNotes, getNote: mocks.getNote, saveNote: mocks.saveNote }));
vi.mock('../lib/localLlm', () => ({ getLlmSettings: mocks.getLlmSettings }));
vi.mock('../lib/localRag', () => ({ localGroundedAnswer: mocks.localGroundedAnswer }));
vi.mock('../lib/openNotebook', () => ({
  getOpenNotebookSettings: mocks.getOpenNotebookSettings,
  listSources: mocks.listSources,
  chatWithSource: mocks.chatWithSource,
}));

import TutorWorkspace from './TutorWorkspace';

const document = {
  id: 'source:fixed-income',
  title: 'Fixed Income Curriculum',
  level: 'level1',
  publisher: 'CFA Institute',
  sourceKind: 'official-curriculum',
  format: 'pdf',
  sha256: 'hash',
  sizeBytes: 100,
  canonical: true,
  coverageTags: ['fixed-income'],
  topicIds: ['fixed-income'],
  chunkCount: 1,
  importedAt: '2026-09-13T00:00:00.000Z',
  privateUseOnly: true,
} as const;

function renderWorkspace() {
  return render(<MemoryRouter><TutorWorkspace /></MemoryRouter>);
}

describe('TutorWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCfaSourceDocuments.mockResolvedValue([document]);
    mocks.getCfaSourceChunks.mockResolvedValue([{ id: 'chunk:1', documentId: document.id, chunkIndex: 0, locator: 'Reading 4.2', text: 'Duration estimates price sensitivity.', normalizedText: 'duration estimates price sensitivity', topicIds: ['fixed-income'], sourceHash: 'hash', importedAt: document.importedAt }]);
    mocks.getOpenNotebookSettings.mockResolvedValue({ enabled: false, baseUrl: 'http://localhost:5055' });
    mocks.listSources.mockResolvedValue([]);
    mocks.getNotes.mockResolvedValue([]);
    mocks.getNote.mockResolvedValue(undefined);
    mocks.saveNote.mockResolvedValue(undefined);
    mocks.getLlmSettings.mockResolvedValue({ enabled: true });
    mocks.localGroundedAnswer.mockResolvedValue({
      answer: 'Duration measures price sensitivity [1].',
      citations: [{ number: 1, locator: 'Reading 4.2', documentId: document.id, snippet: 'Duration estimates price sensitivity.', score: 1 }],
      retrieved: 1,
      used: 1,
      grounded: true,
    });
  });

  it('shows source provenance, coverage, reader text, and writing tools', async () => {
    renderWorkspace();
    expect((await screen.findAllByText('Fixed Income Curriculum')).length).toBeGreaterThan(0);
    expect(screen.getByText('built-in')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(await screen.findByText('Duration estimates price sensitivity.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Annotations' })).toBeInTheDocument();
  });

  it('asks through the existing local RAG client, opens evidence, and saves the response', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findAllByText('Fixed Income Curriculum');
    await user.type(screen.getByLabelText('Ask from this source'), 'What does duration measure?');
    await user.click(screen.getByRole('button', { name: 'Ask tutor' }));

    expect(await screen.findByText(/Duration measures price sensitivity/)).toBeInTheDocument();
    expect(mocks.localGroundedAnswer).toHaveBeenCalledWith(expect.objectContaining({ domain: 'cfa', level: 'level1', topic: 'fixed-income' }));
    await user.click(screen.getByRole('button', { name: /Open citation 1/i }));
    expect(screen.getByRole('complementary', { name: 'Citation 1' })).toHaveTextContent('Reading 4.2');

    await user.click(screen.getByRole('button', { name: 'Save response' }));
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledWith(expect.objectContaining({ type: 'general', moduleId: expect.stringMatching(/^tutor-response:/) })));
    expect(await screen.findByText('Saved to Library')).toBeInTheDocument();
  });

  it('blocks tutoring when a source has no searchable coverage', async () => {
    mocks.getCfaSourceDocuments.mockResolvedValue([{ ...document, chunkCount: 0, needsOcr: true }]);
    mocks.getCfaSourceChunks.mockResolvedValue([]);
    renderWorkspace();
    expect(await screen.findByText('Coverage is missing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask tutor' })).toBeDisabled();
  });

  it('uses a focused mobile pane switcher and returns to reading after source selection', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findAllByText('Fixed Income Curriculum');

    const sourcesTab = screen.getByRole('tab', { name: 'Sources' });
    const readTab = screen.getByRole('tab', { name: 'Read' });
    expect(readTab).toHaveAttribute('aria-selected', 'true');

    await user.click(sourcesTab);
    expect(sourcesTab).toHaveAttribute('aria-selected', 'true');
    const sourceRow = screen.getAllByRole('button', { name: /Fixed Income Curriculum/i })
      .find((button) => button.hasAttribute('aria-pressed'));
    expect(sourceRow).toBeDefined();
    await user.click(sourceRow!);
    expect(readTab).toHaveAttribute('aria-selected', 'true');
  });
});
