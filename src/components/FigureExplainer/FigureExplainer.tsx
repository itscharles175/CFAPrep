import { useState } from 'react';
import {
  explainCurriculumFigure,
  type FigureExplanation,
} from '../../lib/figureUnderstanding';

interface FigureExplainerProps {
  topicTitle: string;
  /** Optional small text excerpt that sits near the figure in the curriculum. */
  contextHint?: string;
}

/**
 * Pure, self-contained UI for asking the local multimodal model to describe a
 * curriculum figure. No router/storage coupling — host pages decide where to
 * mount it. On file pick we read the file as base64, call the figure helper,
 * and render the structured response.
 */
export default function FigureExplainer({ topicTitle, contextHint }: FigureExplainerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [explanation, setExplanation] = useState<FigureExplanation | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    setError('');
    setBusy(true);
    setExplanation(null);
    try {
      const base64 = await readFileAsBase64(file);
      const mime = pickMime(file.type);
      const next = await explainCurriculumFigure({
        imageBase64: base64,
        mime,
        topicTitle,
        contextHint,
      });
      setExplanation(next);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qv-stack-3">
      <label
        className="btn btn-secondary btn-sm"
        style={{ cursor: busy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center' }}
        aria-disabled={busy}
      >
        {busy ? 'Asking model…' : 'Pick a figure (PNG/JPEG/WebP)'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0] || null;
            handleFile(file);
            event.target.value = '';
          }}
        />
      </label>
      {previewUrl && (
        <img
          src={previewUrl}
          alt="Selected figure preview"
          style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 8, border: '1px solid var(--border)' }}
        />
      )}
      {error && (
        <p className="qv-text-danger qv-m-0 qv-fs-sm">{error}</p>
      )}
      {explanation && (
        <div className="qv-stack-2">
          <p className="qv-m-0">{explanation.summary}</p>
          {explanation.axes && (
            <span className="qv-chip qv-text-secondary" title="Axes detected in the figure">
              Axes: {explanation.axes}
            </span>
          )}
          {explanation.bullets.length > 0 && (
            <ul className="qv-m-0" style={{ paddingLeft: '1.25rem' }}>
              {explanation.bullets.map((bullet, index) => (
                <li key={index} className="qv-fs-sm">{bullet}</li>
              ))}
            </ul>
          )}
          <small className="qv-text-muted">
            Generated {new Date(explanation.generatedAt).toLocaleString()}
          </small>
        </div>
      )}
    </div>
  );
}

function pickMime(type: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (type === 'image/jpeg' || type === 'image/jpg') return 'image/jpeg';
  if (type === 'image/webp') return 'image/webp';
  return 'image/png';
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected non-string FileReader result.'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}
