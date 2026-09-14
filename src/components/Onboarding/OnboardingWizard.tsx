import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { checkLlmConnection, saveLlmSettings } from '../../lib/localLlm';
import { markOnboardingComplete, setOnboardingStep } from '../../lib/onboardingProgress';
import { setUnifiedOnboardingDismissed } from '../../lib/unifiedResume';
import { Dialog, InlineCluster, Surface } from '../ui/Primitives';

const CORS_NOTE_LM_STUDIO =
  'LM Studio: open Developer / Server panel and enable CORS for "*", then restart the server.';
const CORS_NOTE_OLLAMA = 'Ollama: include the StudyVault origin in OLLAMA_ORIGINS.';

interface StepperProps {
  step: number;
}

function Stepper({ step }: StepperProps) {
  return (
    <div className="onboarding-progress">
      <span className="onboarding-progress-label">Step {step} of 3</span>
      <progress value={step} max={3} aria-label={`Onboarding step ${step} of 3`} />
    </div>
  );
}

interface Step1Props {
  onContinue: () => void;
}

function Step1({ onContinue }: Step1Props) {
  return (
    <div className="onboarding-step">
      <h2 id="onboarding-step-title">StudyVault is local-first</h2>
      <p className="qv-m-0">
        Your study data stays on this Mac; these optional choices take less than a minute.
      </p>
      <Surface tone="study" density="compact" className="onboarding-summary">
        <ul className="qv-m-0">
          <li>Connect a local model</li>
          <li>Add source documents</li>
          <li>Or skip setup and start studying</li>
        </ul>
      </Surface>
      <InlineCluster align="end" style={{ marginTop: 'var(--space-5)' }}>
        <button className="btn btn-primary" onClick={onContinue}>
          Continue
        </button>
      </InlineCluster>
    </div>
  );
}

interface Step2Props {
  onPresetChosen: () => void;
  onSkip: () => void;
}

function Step2({ onPresetChosen, onSkip }: Step2Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handlePreset(baseUrl: string) {
    setSaving(true);
    setError('');
    try {
      const connection = await checkLlmConnection({ baseUrl }, { retries: 0 });
      if (!connection.ok) {
        setError(`${connection.error} ${connection.recovery}`);
        return;
      }
      if (!connection.recommendedModel) {
        setError('The server is connected, but no loaded chat model was found. Load one and try again.');
        return;
      }
      await saveLlmSettings({ enabled: true, baseUrl, model: connection.recommendedModel });
      onPresetChosen();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="onboarding-step">
      <h2 id="onboarding-step-title">Connect a local model</h2>
      <p className="qv-m-0">
        Choose the server already running on this Mac; StudyVault will discover its loaded chat model.
      </p>

      <InlineCluster style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={() => handlePreset('http://localhost:1234/v1')}
        >
          LM Studio
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            localhost:1234 · discover loaded model
          </small>
        </button>
        <button
          className="btn btn-secondary"
          disabled={saving}
          onClick={() => handlePreset('http://localhost:11434/v1')}
        >
          Ollama
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            localhost:11434 · discover loaded model
          </small>
        </button>
      </InlineCluster>

      {error && (
        <p className="qv-text-danger qv-fs-xs qv-mt-3" role="alert">
          {error}
        </p>
      )}

      <details className="onboarding-help">
        <summary>Connection help</summary>
        <p>{CORS_NOTE_LM_STUDIO}</p>
        <p>{CORS_NOTE_OLLAMA}</p>
      </details>

      <InlineCluster align="end" style={{ marginTop: 'var(--space-5)' }}>
        <button className="btn btn-ghost qv-text-muted" onClick={onSkip}>
          Skip for now
        </button>
      </InlineCluster>
    </div>
  );
}

interface Step3Props {
  onDone: () => void;
}

function Step3({ onDone }: Step3Props) {
  const navigate = useNavigate();

  function goToSystem(fragment: string) {
    navigate(`/system${fragment}`);
    onDone();
  }

  return (
    <div className="onboarding-step">
      <h2 id="onboarding-step-title">Bring in your curriculum</h2>
      <p className="qv-m-0">
        Add source material now for cited tutoring and grounded practice, or do it later from Library.
      </p>

      <div className="qv-stack-2">
        <button
          className="btn btn-secondary"
          onClick={() => goToSystem('#vault-folder')}
          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
        >
          <strong>Pick a folder of PDFs</strong>
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            Desktop Electron app only
          </small>
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => goToSystem('#vault-paste')}
          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
        >
          <strong>Paste text</strong>
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            Copy and paste raw curriculum text
          </small>
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => goToSystem('#vault-import')}
          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
        >
          <strong>Import .qvsource bundle</strong>
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            Import a pre-built source bundle file
          </small>
        </button>
      </div>

      <InlineCluster align="end" style={{ marginTop: 'var(--space-5)' }}>
        <button className="btn btn-ghost qv-text-muted" onClick={onDone}>
          Skip — explore first
        </button>
        <button className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </InlineCluster>
    </div>
  );
}

export interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
}

export function OnboardingWizard({ open, onClose }: OnboardingWizardProps) {
  const [step, setStep] = useState(1);

  if (!open) return null;

  // UB7: advance + persist the furthest step reached so a returning user gets a
  // "resume where you left off" nudge on Today. setOnboardingStep is monotonic,
  // so re-opening at step 1 never rewinds a previously-recorded high-water mark.
  function goToStep(next: number) {
    setOnboardingStep(next);
    setStep(next);
  }

  function handleClose() {
    // UX-3: dismissing the host wizard (skip or close) settles onboarding for the
    // whole shell, so the LSAT "First Light" wizard never re-appears on a later
    // hop into /lsat. The cross-domain flag is the single source both wizards
    // consult; setting it here is the host → LSAT half of the two-way sync.
    setUnifiedOnboardingDismissed();
    setStep(1);
    onClose();
  }

  // UB7: closing from the final step means the user walked the whole flow —
  // record completion so Today shows the quiet "you're ready" state instead of a
  // resume nudge. (Bailing earlier just leaves the partial high-water mark.)
  function handleFinish() {
    markOnboardingComplete();
    handleClose();
  }

  return (
    <Dialog
      title={null}
      labelledBy="onboarding-step-title"
      onClose={handleClose}
      className="onboarding-dialog"
    >
      <InlineCluster className="onboarding-topline" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Stepper step={step} />
        <button className="btn btn-ghost qv-fs-xs qv-text-muted" onClick={handleClose} aria-label="Skip onboarding">
          Skip onboarding
        </button>
      </InlineCluster>

      {step === 1 && <Step1 onContinue={() => goToStep(2)} />}
      {step === 2 && <Step2 onPresetChosen={() => goToStep(3)} onSkip={() => goToStep(3)} />}
      {step === 3 && <Step3 onDone={handleFinish} />}
    </Dialog>
  );
}
