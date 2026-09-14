import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Import from './Import';
import type { ImportParseResult, ParsedPrepTest } from '@lsat/lib/types';

const mocks = vi.hoisted(() => ({
  importParse: vi.fn(),
  listImportJobs: vi.fn(),
  getImportJob: vi.fn(),
  importReconcile: vi.fn(),
  pickPdfFile: vi.fn(),
  readFileFromPath: vi.fn(),
  importCommitMutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@lsat/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    detail?: unknown;
    constructor(message: string, status: number, detail?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.detail = detail;
    }
  },
  api: {
    importParse: mocks.importParse,
    listImportJobs: mocks.listImportJobs,
    getImportJob: mocks.getImportJob,
    importReconcile: mocks.importReconcile,
  },
}));

vi.mock('@lsat/lib/mutations', () => ({
  useImportCommit: () => ({
    mutate: mocks.importCommitMutate,
    isPending: false,
  }),
}));

vi.mock('@lsat/lib/electron', () => ({
  pickPdfFile: mocks.pickPdfFile,
  readFileFromPath: mocks.readFileFromPath,
}));

vi.mock('@lsat/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

const parsedPrepTest: ParsedPrepTest = {
  name: 'PT 99',
  sections: [
    {
      type: 'LR',
      passages: [],
      questions: [
        {
          prompt: 'Which one of the following most weakens the argument?',
          stem: 'A real parsed stimulus.',
          q_type: 'Weaken',
          difficulty: 3,
          correct_answer: 'A',
          choices: [
            { label: 'A', text: 'choice A', is_correct: true },
            { label: 'B', text: 'choice B' },
            { label: 'C', text: 'choice C' },
            { label: 'D', text: 'choice D' },
            { label: 'E', text: 'choice E' },
          ],
        },
      ],
    },
  ],
};

function renderImport() {
  return render(
    <MemoryRouter>
      <Import />
    </MemoryRouter>,
  );
}

describe('Import page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listImportJobs.mockResolvedValue([]);
    mocks.pickPdfFile.mockResolvedValue(
      new File(['raw official pdf bytes'], 'PT99.pdf', {
        type: 'application/pdf',
      }),
    );
  });

  it('does not fabricate a demo PrepTest when parser backend is unavailable', async () => {
    mocks.importParse.mockRejectedValue(new TypeError('offline'));

    renderImport();
    await userEvent.click(screen.getByRole('button', { name: /click to choose a pdf/i }));

    expect(await screen.findByText(/Parser unavailable.*no demo parse was generated/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Verify parsed structure/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/city council claims the new tax/i)).not.toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/no demo parse was generated/i));
  });

  it('keeps verification open when commit fails instead of showing completion', async () => {
    mocks.importParse.mockResolvedValue({
      job_id: 42,
      warnings: [],
      parsed: parsedPrepTest,
    });
    mocks.importCommitMutate.mockImplementation((_vars: unknown, options: { onError: (err: unknown) => void }) => {
      options.onError(new Error('database locked'));
    });

    renderImport();
    await userEvent.click(screen.getByRole('button', { name: /click to choose a pdf/i }));
    expect(await screen.findByRole('heading', { name: /Verify parsed structure/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Commit import/i }));

    expect(await screen.findByText(/Commit failed before the import could be persisted/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Import complete/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Verify parsed structure/i })).toBeInTheDocument());
  });

  it('accepts a dropped PDF and ignores a duplicate drop while parsing', async () => {
    let resolveParse!: (value: ImportParseResult) => void;
    mocks.importParse.mockReturnValue(
      new Promise((resolve) => {
        resolveParse = resolve;
      }),
    );
    renderImport();
    const dropTarget = screen.getByRole('button', { name: /click to choose a pdf/i });
    const file = new File(['official PDF bytes'], 'PT100.pdf', { type: 'application/pdf' });

    const dataTransfer = { files: { 0: file, length: 1, item: () => file } };
    fireEvent.drop(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => expect(mocks.importParse).toHaveBeenCalledTimes(1));
    resolveParse({ job_id: 100, warnings: [], parsed: parsedPrepTest });
    expect(await screen.findByRole('heading', { name: /Verify parsed structure/i })).toBeInTheDocument();
  });

  it('keeps the failed file available for an explicit retry', async () => {
    mocks.importParse.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({
      job_id: 101,
      warnings: [],
      parsed: parsedPrepTest,
    });

    renderImport();
    await userEvent.click(screen.getByRole('button', { name: /click to choose a pdf/i }));
    expect(await screen.findByRole('button', { name: /retry parse/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry parse/i }));
    expect(await screen.findByRole('heading', { name: /Verify parsed structure/i })).toBeInTheDocument();
    expect(mocks.importParse).toHaveBeenCalledTimes(2);
  });
});
