import { useEffect, useRef, useState } from 'react';
import { Mic2, Play, Pause, Square, Download as DownloadIcon, RefreshCw } from 'lucide-react';
import {
  generatePodcastScript,
  synthesizePodcastScript,
  type PodcastScript,
  type PodcastSegment,
} from '../../lib/podcast';

interface PodcastPanelProps {
  level: string;
  topic: string;
  title: string;
  sourceExcerpts?: string[];
  /** Optional caption shown above the buttons (e.g. "Multi-speaker study podcast"). */
  caption?: string;
}

interface DownloadProgress {
  status: string;
  progress?: number;
}

/**
 * The voice model downloads as several ONNX/tokenizer files, and
 * transformers.js fires `progress_callback` per-file — so the raw `progress`
 * resets toward 0 each time a new file starts. To show ONE calm, never-going-
 * backwards percent in the UI, we track the highest percent seen for this
 * download. (A new synth run resets it via `setSynthDownloadPct(0)`.)
 *
 * `status` strings from transformers are lowercase machine tokens
 * ("initiate" | "download" | "progress" | "done"); map them to a friendly
 * label so the panel reads like a download, not a log line.
 */
const DOWNLOAD_STATUS_LABELS: Record<string, string> = {
  initiate: 'Preparing voice model…',
  download: 'Downloading voice model…',
  progress: 'Downloading voice model…',
  done: 'Voice model ready — synthesising…',
  ready: 'Voice model ready — synthesising…',
};

function friendlyDownloadStatus(status: string): string {
  return DOWNLOAD_STATUS_LABELS[status?.toLowerCase?.() ?? ''] ?? status;
}

/**
 * Multi-speaker study podcast component.
 *
 * Flow:
 *   1. User clicks "Generate script" → local LLM produces a Coach/Student
 *      JSON script (cached per topic).
 *   2. User clicks "Synthesize audio" → lazy-loads kokoro-js (~80MB model),
 *      streams audio per line into the segment list.
 *   3. User clicks Play to walk through the segments sequentially.
 *
 * All audio is generated locally.  The model is cached in IndexedDB by
 * transformers.js so the second run is fully offline.
 */
export default function PodcastPanel({
  level,
  topic,
  title,
  sourceExcerpts,
  caption = 'Multi-speaker study podcast',
}: PodcastPanelProps) {
  const [script, setScript] = useState<PodcastScript | null>(null);
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptError, setScriptError] = useState('');

  const [segments, setSegments] = useState<PodcastSegment[]>([]);
  const [synthBusy, setSynthBusy] = useState(false);
  const [synthError, setSynthError] = useState('');
  const [synthProgress, setSynthProgress] = useState<DownloadProgress | null>(null);
  // Highest model-download percent seen this run — monotonic so the bar never
  // jumps backwards as transformers.js switches between per-file downloads.
  const [synthDownloadPct, setSynthDownloadPct] = useState(0);
  const [synthLineIndex, setSynthLineIndex] = useState<number>(-1);

  const [playing, setPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState<number>(-1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  // Clean up object URLs on unmount.
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    };
  }, []);

  async function handleGenerateScript() {
    setScriptBusy(true);
    setScriptError('');
    try {
      const next = await generatePodcastScript({ level, topic, title, sourceExcerpts });
      setScript(next);
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : String(err));
    } finally {
      setScriptBusy(false);
    }
  }

  async function handleRefreshScript() {
    setScriptBusy(true);
    setScriptError('');
    try {
      const next = await generatePodcastScript({
        level,
        topic,
        title,
        sourceExcerpts,
        forceRefresh: true,
      });
      setScript(next);
      // Refreshing the script invalidates any prior synthesised audio.
      setSegments([]);
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : String(err));
    } finally {
      setScriptBusy(false);
    }
  }

  async function handleSynthesize() {
    if (!script) return;
    setSynthBusy(true);
    setSynthError('');
    setSegments([]);
    setSynthProgress({ status: 'Loading voice model…' });
    setSynthDownloadPct(0);
    setSynthLineIndex(-1);
    try {
      const result = await synthesizePodcastScript(script, {
        onProgress: (info) => {
          setSynthProgress(info);
          // Clamp + keep the max so the surfaced percent only ever moves
          // forward across the model's multiple per-file downloads.
          if (typeof info.progress === 'number' && Number.isFinite(info.progress)) {
            const clamped = Math.min(100, Math.max(0, info.progress));
            setSynthDownloadPct((prev) => Math.max(prev, clamped));
          }
        },
        onLine: (segment, index) => {
          setSynthLineIndex(index);
          setSegments((prev) => [...prev, segment]);
        },
      });
      setSegments(result);
      setSynthProgress(null);
    } catch (err) {
      setSynthError(err instanceof Error ? err.message : String(err));
    } finally {
      setSynthBusy(false);
    }
  }

  function handlePlay() {
    if (segments.length === 0) return;
    setPlaying(true);
    playFrom(0);
  }

  function playFrom(index: number) {
    if (index >= segments.length) {
      setPlaying(false);
      setPlayIndex(-1);
      return;
    }
    setPlayIndex(index);
    const segment = segments[index];
    let url = objectUrlsRef.current[index];
    if (!url) {
      url = URL.createObjectURL(segment.audio);
      objectUrlsRef.current[index] = url;
    }
    if (!audioRef.current) return;
    audioRef.current.src = url;
    audioRef.current.onended = () => playFrom(index + 1);
    audioRef.current.play().catch((err) => {
      setSynthError(err instanceof Error ? err.message : String(err));
      setPlaying(false);
    });
  }

  function handlePause() {
    audioRef.current?.pause();
    setPlaying(false);
  }

  function handleStop() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
    setPlayIndex(-1);
  }

  function handleDownloadCombined() {
    // For now we download per-segment WAVs as a zip-less manifest — a future
    // pass can stitch them into one stream via the Web Audio API.
    segments.forEach((segment, index) => {
      const url = URL.createObjectURL(segment.audio);
      const a = document.createElement('a');
      a.href = url;
      a.download = `podcast-${topic}-${String(index + 1).padStart(2, '0')}-${segment.role}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  return (
    <div className="qv-card qv-stack-3">
      <div className="qv-row-between">
        <div className="qv-stack-1">
          <div className="qv-row-2">
            <Mic2 size={18} aria-hidden="true" />
            <h3 className="qv-m-0">{caption}</h3>
          </div>
          <p className="qv-text-secondary qv-m-0 qv-fs-sm">
            Two-person Coach/Student dialog scripted by your local model and voiced offline by kokoro. The voice model (~80MB) downloads once and caches in your browser.
          </p>
        </div>
        <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
          {!script && (
            <button className="btn btn-primary btn-sm" onClick={handleGenerateScript} disabled={scriptBusy}>
              {scriptBusy ? 'Generating…' : 'Generate script'}
            </button>
          )}
          {script && (
            <button className="btn btn-secondary btn-sm" onClick={handleRefreshScript} disabled={scriptBusy}>
              <RefreshCw size={14} aria-hidden="true" /> Refresh script
            </button>
          )}
        </div>
      </div>

      {scriptError && <p className="qv-text-danger qv-m-0 qv-fs-sm">{scriptError}</p>}

      {script && (
        <div className="qv-stack-2">
          <div className="qv-stack-2">
            {script.lines.map((line, i) => (
              <div
                key={i}
                className={`qv-card ${
                  playIndex === i ? 'qv-text-primary' : ''
                }`}
                style={{ borderLeft: `3px solid ${line.role === 'coach' ? 'var(--color-accent)' : 'var(--color-text-secondary)'}` }}
              >
                <div className="qv-row-between qv-mb-2">
                  <strong className="qv-fs-sm qv-mono">{line.role.toUpperCase()}</strong>
                  {synthLineIndex === i && synthBusy && (
                    <span className="qv-text-muted qv-fs-xs">synthesising…</span>
                  )}
                  {segments[i] && (
                    <span className="qv-text-muted qv-fs-xs">
                      {segments[i].durationSeconds.toFixed(1)}s
                    </span>
                  )}
                </div>
                <p className="qv-m-0">{line.text}</p>
              </div>
            ))}
          </div>

          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            {segments.length === 0 && (
              <button className="btn btn-primary btn-sm" onClick={handleSynthesize} disabled={synthBusy}>
                {synthBusy ? 'Synthesising…' : 'Synthesize audio'}
              </button>
            )}
            {segments.length > 0 && !playing && (
              <button className="btn btn-primary btn-sm" onClick={handlePlay}>
                <Play size={14} aria-hidden="true" /> Play
              </button>
            )}
            {playing && (
              <button className="btn btn-secondary btn-sm" onClick={handlePause}>
                <Pause size={14} aria-hidden="true" /> Pause
              </button>
            )}
            {(playing || playIndex >= 0) && (
              <button className="btn btn-secondary btn-sm" onClick={handleStop}>
                <Square size={14} aria-hidden="true" /> Stop
              </button>
            )}
            {segments.length > 0 && !synthBusy && (
              <button className="btn btn-secondary btn-sm" onClick={handleDownloadCombined}>
                <DownloadIcon size={14} aria-hidden="true" /> Download segments
              </button>
            )}
          </div>

          {synthProgress && synthBusy && (
            <div className="qv-stack-1">
              <p className="qv-text-secondary qv-m-0 qv-fs-xs">
                {friendlyDownloadStatus(synthProgress.status)}
                {synthDownloadPct > 0 && ` · ${Math.round(synthDownloadPct)}%`}
              </p>
              {synthDownloadPct > 0 && (
                <div
                  role="progressbar"
                  aria-label="Voice model download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(synthDownloadPct)}
                  style={{
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--border)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(synthDownloadPct)}%`,
                      height: '100%',
                      background: 'var(--color-accent, var(--accent, #60a5fa))',
                      transition: 'width 120ms linear',
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {synthError && <p className="qv-text-danger qv-m-0 qv-fs-sm">{synthError}</p>}
        </div>
      )}

      <audio ref={audioRef} preload="auto" />
    </div>
  );
}
