import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import EditModelRoutingModal from './EditModelRoutingModal';
import type { LsatBackendHealth } from '../../lib/lsatBackend';

const HEALTH: LsatBackendHealth = {
  ok: true,
  reachable: true,
  detail: 'Sidecar healthy.',
  ai: { provider: 'ollama', ready: true, models: { explain: 'gemma3:4b' } },
};

function makeDeps() {
  return {
    pushRouting: vi.fn().mockResolvedValue({ ok: true, detail: 'LSAT model routing updated.', applied: {} }),
    syncProvider: vi.fn().mockResolvedValue({ ok: true, detail: 'synced', applied: { local_provider: 'ollama' } }),
    reprobeLsat: vi.fn().mockResolvedValue(HEALTH),
    reprobeHostLlm: vi.fn().mockResolvedValue({ ok: true, models: ['gemma3:4b'] }),
  };
}

describe('EditModelRoutingModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<EditModelRoutingModal open={false} onClose={() => {}} {...makeDeps()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('seeds the editable fields from the LSAT routing + host props and shows read-only metadata', () => {
    render(
      <EditModelRoutingModal
        open
        onClose={() => {}}
        host={{ baseUrl: 'http://localhost:1234/v1', model: 'gemma3:4b' }}
        lsat={{ provider: 'ollama', models: { explain: 'explain-m', gen: 'gen-m', diagnose: 'diag-m' } }}
        schemaVersion={1}
        promptVersion="2024-07"
        {...makeDeps()}
      />,
    );

    expect((screen.getByLabelText('Explain model') as HTMLInputElement).value).toBe('explain-m');
    expect((screen.getByLabelText('Generation model') as HTMLInputElement).value).toBe('gen-m');
    expect((screen.getByLabelText('Diagnose model') as HTMLInputElement).value).toBe('diag-m');
    // host baseUrl :1234 → LM Studio provider, URL field surfaced + seeded.
    expect((screen.getByLabelText('Local provider') as HTMLSelectElement).value).toBe('lmstudio');
    expect((screen.getByLabelText('LM Studio URL') as HTMLInputElement).value).toBe('http://localhost:1234/v1');
    // Read-only metadata stamps render (NOT as inputs).
    expect(screen.getByText(/schema v1/)).toBeInTheDocument();
    expect(screen.getByText(/prompt 2024-07/)).toBeInTheDocument();
  });

  it('warns when the backend reports missing models', () => {
    render(
      <EditModelRoutingModal
        open
        onClose={() => {}}
        lsat={{ provider: 'ollama', missingModels: ['phantom:7b', 'ghost:3b'] }}
        {...makeDeps()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('not loaded in the active provider');
    expect(alert).toHaveTextContent('phantom:7b, ghost:3b');
  });

  it('pushes the edited routing on save and re-probes BOTH planes', async () => {
    const user = userEvent.setup();
    const deps = makeDeps();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <EditModelRoutingModal
        open
        onClose={onClose}
        onSaved={onSaved}
        host={{ baseUrl: 'http://localhost:11434/v1' }}
        lsat={{ provider: 'ollama', models: { explain: 'old' } }}
        {...deps}
      />,
    );

    const explain = screen.getByLabelText('Explain model');
    await user.clear(explain);
    await user.type(explain, 'gemma3:12b');
    await user.click(screen.getByRole('button', { name: 'Save routing' }));

    await waitFor(() => expect(deps.pushRouting).toHaveBeenCalledTimes(1));
    // The edited explain model + the Ollama provider made it into the patch.
    expect(deps.pushRouting).toHaveBeenCalledWith(
      expect.objectContaining({ explain_model: 'gemma3:12b', local_provider: 'ollama' }),
    );
    // Re-probe of BOTH the LSAT sidecar and the host LLM connection.
    await waitFor(() => expect(deps.reprobeLsat).toHaveBeenCalledTimes(1));
    expect(deps.reprobeHostLlm).toHaveBeenCalledTimes(1);
    // Refreshed health is handed back and the modal closes.
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(HEALTH));
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a backend error and keeps the modal open when the save fails', async () => {
    const user = userEvent.setup();
    const deps = makeDeps();
    deps.pushRouting.mockResolvedValueOnce({ ok: false, detail: 'Could not update LSAT model routing — responded 500.' });
    const onClose = vi.fn();
    render(<EditModelRoutingModal open onClose={onClose} lsat={{ models: { gen: 'g' } }} {...deps} />);

    await user.click(screen.getByRole('button', { name: 'Save routing' }));

    await waitFor(() =>
      expect(screen.getByText(/Could not update LSAT model routing — responded 500\./)).toBeInTheDocument(),
    );
    // No re-probe on a failed save; modal stays open.
    expect(deps.reprobeLsat).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('matches the host provider and re-probes via the injected sync fn', async () => {
    const user = userEvent.setup();
    const deps = makeDeps();
    render(
      <EditModelRoutingModal
        open
        onClose={() => {}}
        host={{ baseUrl: 'http://localhost:11434/v1' }}
        {...deps}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Match host provider' }));

    await waitFor(() => expect(deps.syncProvider).toHaveBeenCalledWith({ baseUrl: 'http://localhost:11434/v1' }));
    await waitFor(() => expect(deps.reprobeLsat).toHaveBeenCalled());
  });
});
