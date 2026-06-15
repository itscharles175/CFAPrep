import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { saveLlmSettings } from '../../lib/localLlm';
import { markOnboardingComplete, setOnboardingStep } from '../../lib/onboardingProgress';
import {
  Dialog,
  InlineCluster,
  StatusBadge,
  Surface,
} from '../ui/Primitives';

const CORS_NOTE_LM_STUDIO =
  'LM Studio: open Developer / Server panel and enable CORS for "*", then restart the server.';
const CORS_NOTE_OLLAMA =
  'Ollama: start with OLLAMA_ORIGINS=* set. The Tauri desktop shell does not need this.';

interface StepperProps {
  step: number;
}

function Stepper({ step }: StepperProps) {
  return (
    <InlineCluster className="onboarding-stepper">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`onboarding-step-dot${n === step ? ' onboarding-step-dot-active' : ''}`}
          aria-current={n === step ? 'step' : undefined}
        >
          {n}
        </span>
      ))}
      <span className="muted-copy qv-fs-xs">
        {step} / 3
      </span>
    </InlineCluster>
  );
}

interface Step1Props {
  onContinue: () => void;
}

function Step1({ onContinue }: Step1Props) {
  return (
    <div className="onboarding-step">
      <StatusBadge tone="accent">Welcome</StatusBadge>
      <h3 style={{ margin: 'var(--space-2) 0 var(--space-1)' }}>StudyVault is local-first</h3>
      <p className="qv-m-0">
        Everything stays on your machine — no cloud, no account, no tracking. Three quick choices
        and you are set.
      </p>
      <Surface tone="study" density="compact" style={{ marginTop: 'var(--space-4)' }}>
        <ul className="qv-m-0" style={{ paddingLeft: 'var(--space-4)', lineHeight: 1.7 }}>
          <li>Choose a local model server (optional)</li>
          <li>Bring in your source documents (optional)</li>
          <li>Start studying immediately — nothing is required</li>
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

  async function handlePreset(baseUrl: string, model: string) {
    setSaving(true);
    try {
      await saveLlmSettings({ enabled: true, baseUrl, model });
      onPresetChosen();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="onboarding-step">
      <StatusBadge tone="accent">Step 2 — Local model</StatusBadge>
      <h3 style={{ margin: 'var(--space-2) 0 var(--space-1)' }}>Connect a local AI model</h3>
      <p style={{ margin: '0 0 var(--space-4)' }}>
        Pick a preset to enable AI-generated questions and explanations grounded in your source
        documents.
      </p>

      <InlineCluster style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={() =>
            handlePreset('http://localhost:1234/v1', 'gemma-4-e4b-it')
          }
        >
          LM Studio
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            localhost:1234 · gemma-4-e4b-it
          </small>
        </button>
        <button
          className="btn btn-secondary"
          disabled={saving}
          onClick={() =>
            handlePreset('http://localhost:11434/v1', 'llama3.1')
          }
        >
          Ollama
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            localhost:11434 · llama3.1
          </small>
        </button>
      </InlineCluster>

      <Surface tone="study" density="compact" status="warning" className="qv-fs-xs" style={{ marginTop: 'var(--space-4)' }}>
        <strong>CORS note:</strong>
        <br />
        {CORS_NOTE_LM_STUDIO}
        <br />
        {CORS_NOTE_OLLAMA}
      </Surface>

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
      <StatusBadge tone="accent">Step 3 — Ingest sources</StatusBadge>
      <h3 style={{ margin: 'var(--space-2) 0 var(--space-1)' }}>Bring in your curriculum</h3>
      <p style={{ margin: '0 0 var(--space-4)' }}>
        AI features and grounded answers light up once you have source documents in the local vault.
      </p>

      <div className="qv-stack-2">
        <button
          className="btn btn-secondary"
          onClick={() => goToSystem('#vault-folder')}
          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
        >
          <strong>Pick a folder of PDFs</strong>
          <small className="qv-fs-xs" style={{ display: 'block', fontWeight: 400 }}>
            Desktop (Tauri) shell only
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
      onClose={handleClose}
      actions={
        <small className="muted-copy qv-fs-xs">
          Enter to advance · Esc to dismiss
        </small>
      }
    >
      <InlineCluster className="qv-mb-3" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Stepper step={step} />
        <button
          className="btn btn-ghost qv-fs-xs qv-text-muted"
          onClick={handleClose}
          aria-label="Skip onboarding"
        >
          Skip onboarding ✕
        </button>
      </InlineCluster>

      {step === 1 && <Step1 onContinue={() => goToStep(2)} />}
      {step === 2 && (
        <Step2
          onPresetChosen={() => goToStep(3)}
          onSkip={() => goToStep(3)}
        />
      )}
      {step === 3 && <Step3 onDone={handleFinish} />}
    </Dialog>
  );
}
