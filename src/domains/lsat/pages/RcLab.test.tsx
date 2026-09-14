import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RcLab from './RcLab';

const mocks = vi.hoisted(() => ({
  createPassageJob: vi.fn(),
  passageJobProgress: vi.fn(),
  cancelPassageJob: vi.fn(),
  retryPassageJob: vi.fn(),
  rcPassageMap: vi.fn(),
  dashboardRefetch: vi.fn(),
  mapsRefetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@lsat/lib/api', () => ({
  api: {
    createPassageJob: mocks.createPassageJob,
    passageJobProgress: mocks.passageJobProgress,
    cancelPassageJob: mocks.cancelPassageJob,
    retryPassageJob: mocks.retryPassageJob,
    rcPassageMap: mocks.rcPassageMap,
  },
}));

vi.mock('@lsat/lib/hooks', () => ({
  useRCDashboard: () => ({
    data: {
      usingSample: false,
      data: {
        passages: 1,
        questions: 4,
        mapped_passages: 1,
        coverage: 0.5,
        tag_coverage: { coverage: 0.5, tagged_questions: 2, total_questions: 4, low_confidence: 0, by_scope: {} },
        timing: { attempts: 0, avg_time_ms: null, accuracy: null },
        next_actions: [],
      },
    },
    isError: false,
    refetch: mocks.dashboardRefetch,
  }),
  useRCPassageMaps: () => ({ data: { usingSample: false, data: [] }, isError: false, refetch: mocks.mapsRefetch }),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

function renderRcLab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RcLab />
    </QueryClientProvider>,
  );
}

describe('RC passage-first generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rcPassageMap.mockResolvedValue({});
  });

  it('cancels an active generation job and keeps it retryable', async () => {
    let resolveProgress!: (value: { status: string; progress_pct: number }) => void;
    mocks.createPassageJob.mockResolvedValue({ job_id: 17, status: 'queued' });
    mocks.passageJobProgress.mockReturnValue(
      new Promise((resolve) => {
        resolveProgress = resolve;
      }),
    );
    mocks.cancelPassageJob.mockResolvedValue({ ok: true, status: 'cancelled' });

    renderRcLab();
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    expect(await screen.findByText(/Job #17/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /cancel generation/i }));
    expect(await screen.findByRole('button', { name: /retry generation/i })).toBeInTheDocument();
    expect(mocks.cancelPassageJob).toHaveBeenCalledWith(17);
    resolveProgress({ status: 'cancelled', progress_pct: 0 });
  });

  it('retries a failed generation job and resumes polling', async () => {
    mocks.createPassageJob.mockResolvedValue({ job_id: 18, status: 'queued' });
    mocks.passageJobProgress
      .mockResolvedValueOnce({ status: 'failed', progress_pct: 25 })
      .mockResolvedValueOnce({ status: 'done', progress_pct: 100, accepted: 4 });
    mocks.retryPassageJob.mockResolvedValue({ ok: true, status: 'queued' });

    renderRcLab();
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    expect(await screen.findByRole('button', { name: /retry generation/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /retry generation/i }));
    await waitFor(() => expect(mocks.retryPassageJob).toHaveBeenCalledWith(18));
    await waitFor(() => expect(mocks.passageJobProgress).toHaveBeenCalledTimes(2));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Retrying passage job #18');
  });
});
