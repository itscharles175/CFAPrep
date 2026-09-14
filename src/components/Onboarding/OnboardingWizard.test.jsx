import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingWizard } from './OnboardingWizard';

vi.mock('../../lib/localLlm', () => ({
  checkLlmConnection: vi.fn().mockResolvedValue({
    ok: true,
    recommendedModel: 'discovered-chat-model',
  }),
  saveLlmSettings: vi.fn().mockResolvedValue({}),
}));

// Import the mock AFTER vi.mock so we get the mocked version
import { checkLlmConnection, saveLlmSettings } from '../../lib/localLlm';

function renderWizard(props = {}) {
  const onClose = props.onClose ?? vi.fn();
  const open = props.open ?? true;
  render(
    <MemoryRouter>
      <OnboardingWizard open={open} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onClose };
}

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders step 1 with Welcome copy when open=true', () => {
    renderWizard({ open: true });
    expect(screen.getByText(/local-first/i)).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Onboarding step 1 of 3' })).toHaveValue(1);
  });

  it('does not render anything when open=false', () => {
    renderWizard({ open: false });
    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
  });

  it('clicking Continue advances from step 1 to step 2', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText(/local model/i)).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });

  it('clicking LM Studio discovers a loaded model, saves it, and advances to step 3', async () => {
    const user = userEvent.setup();
    renderWizard();

    // Advance to step 2
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Click LM Studio
    await user.click(screen.getByRole('button', { name: /lm studio/i }));

    await waitFor(() => {
      expect(saveLlmSettings).toHaveBeenCalledOnce();
      expect(saveLlmSettings).toHaveBeenCalledWith({
        enabled: true,
        baseUrl: 'http://localhost:1234/v1',
        model: 'discovered-chat-model',
      });
    });
    expect(checkLlmConnection).toHaveBeenCalledWith(
      { baseUrl: 'http://localhost:1234/v1' },
      { retries: 0 },
    );

    // Should now be on step 3
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /bring in your curriculum/i })).toBeInTheDocument();
  });

  it('keeps onboarding on the provider step when no chat model is loaded', async () => {
    checkLlmConnection.mockResolvedValueOnce({ ok: true, recommendedModel: null });
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /lm studio/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no loaded chat model/i);
    expect(saveLlmSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });

  it('step 3 shows three ingest paths and a Done button', async () => {
    const user = userEvent.setup();
    renderWizard();

    // Navigate to step 3 via Skip for now on step 2
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /skip for now/i }));

    expect(screen.getByRole('button', { name: /pick a folder of pdfs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /paste text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import \.qvsource bundle/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
  });

  it('clicking Skip onboarding calls onClose without advancing', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();

    await user.click(screen.getByRole('button', { name: /skip onboarding/i }));

    expect(onClose).toHaveBeenCalledOnce();
    // Step should still be 1 (wizard closed — rendered nothing new)
  });
});
