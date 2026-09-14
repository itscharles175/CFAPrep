import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/studyDirector', () => ({
  buildStudyPlan: vi.fn().mockResolvedValue({
    generatedAt: '2026-09-14T00:00:00Z',
    headline: 'A focused local plan',
    dueCount: 0,
    weakCount: 0,
    peakReviewDay: null,
    actions: [{
      kind: 'continue',
      title: 'Continue studying',
      path: '/cfa',
      reason: 'Keep building momentum.',
      priority: 30,
      estimatedMinutes: 30,
      objective: 'cfa:today',
    }],
  }),
}));

vi.mock('../lib/storage', () => ({
  getStorage: vi.fn(() => ({
    settings: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockRejectedValue(new Error('Vault unavailable')),
    },
  })),
}));

vi.mock('../hooks/useNextQuestions', () => ({
  useNextQuestions: () => ({ report: null, loading: false, refresh: vi.fn() }),
}));

vi.mock('../domains/cfa/useLevel3Pathway', () => ({
  useLevel3Pathway: () => ['', vi.fn()],
}));

vi.mock('../lib/localLlm', () => ({
  generateQuestionsFromCurriculum: vi.fn(),
  getLlmSettings: vi.fn().mockResolvedValue({ enabled: false }),
  narrateStudyPlan: vi.fn(),
}));

vi.mock('../lib/cfaSourceVault', () => ({
  getCfaSourceReadingForTopic: vi.fn(),
}));

import Today from './Today';
import { StudySessionProvider } from '../components/session';

afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

function renderToday() {
  return render(
    <MemoryRouter>
      <StudySessionProvider storage={window.localStorage}>
        <Today />
      </StudySessionProvider>
    </MemoryRouter>,
  );
}

describe('Today feedback states', () => {
  it('keeps journal text and exposes retry feedback when the local save fails', async () => {
    const user = userEvent.setup();
    renderToday();

    await screen.findByText('Continue studying');
    await user.click(screen.getByText('Session tools'));
    const journal = screen.getByPlaceholderText(/What did I work on/i);
    await user.type(journal, 'The duration intuition clicked.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not save this reflection/i);
    expect(journal).toHaveValue('The duration intuition clicked.');
    expect(journal).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeEnabled();
  });
});
