import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ExternalLink, Pin, Search, ShieldCheck, X } from 'lucide-react';
import {
  buildCfaSourceTarget,
  clearCfaSourceLinkOverride,
  getCfaSourceMapStatus,
  getCfaSourceSnippetsForTarget,
  rebuildCfaSourceLinksForTargets,
  setCfaSourceLinkOverride,
} from '../lib/cfaSourceVault';
import type {
  CfaSourceLevel,
  CfaSourceMapStatus,
  CfaSourcePriority,
  CfaSourceSnippet,
  CfaSourceTarget,
} from '../lib/cfaSourceTypes';
import { InlineCluster, ProgressRail, StatusBadge, Surface } from './ui/Primitives';

type SourceTargetInput = Omit<CfaSourceTarget, 'id'> & { id?: string };
type SourceTone = 'success' | 'exam' | 'warning' | 'vault';

function levelLabel(level: CfaSourceLevel | string | null | undefined): string {
  if (!level) return 'source';
  return level.replace('level', 'Level ');
}

function sourceTone(priority: CfaSourcePriority | string | null | undefined): SourceTone {
  if (priority?.startsWith('official')) return 'success';
  if (priority === 'prep-provider') return 'exam';
  if (priority === 'reference') return 'warning';
  return 'vault';
}

export function SourceCitationChip({ snippet }: { snippet: CfaSourceSnippet }) {
  return (
    <span className="source-citation-chip">
      <ShieldCheck size={12} aria-hidden="true" />
      {levelLabel(snippet.document.level)} · {snippet.document.publisher} · {snippet.chunk.locator}
    </span>
  );
}

export interface SourceSnippetProps {
  snippet: CfaSourceSnippet;
  onPin?: (snippet: CfaSourceSnippet) => void;
  onDismiss?: (snippet: CfaSourceSnippet) => void;
  compact?: boolean;
}

export function SourceSnippet({ snippet, onPin, onDismiss, compact = false }: SourceSnippetProps) {
  return (
    <div className={`source-snippet ${compact ? 'source-snippet-compact' : ''}`}>
      <div className="source-snippet-head">
        <InlineCluster>
          <StatusBadge tone={sourceTone(snippet.link.sourcePriority)}>{snippet.link.sourcePriority.replace('-', ' ')}</StatusBadge>
          {snippet.pinned && <StatusBadge tone="warning">pinned</StatusBadge>}
        </InlineCluster>
        <InlineCluster align="end">
          <button
            className="btn-icon btn-ghost"
            title={snippet.pinned ? 'Unpin source' : 'Pin source'}
            aria-label={snippet.pinned ? 'Unpin source citation' : 'Pin source citation'}
            aria-pressed={snippet.pinned}
            onClick={() => onPin?.(snippet)}
          >
            <Pin size={14} />
          </button>
          <button className="btn-icon btn-ghost" title="Dismiss source" aria-label="Dismiss source citation" onClick={() => onDismiss?.(snippet)}>
            <X size={14} />
          </button>
        </InlineCluster>
      </div>
      <h4>{snippet.document.title}</h4>
      <p>{snippet.preview}</p>
      <div className="source-snippet-foot">
        <SourceCitationChip snippet={snippet} />
        <span>{snippet.link.rankReason}</span>
        <Link to={`/vault?sourceQuery=${encodeURIComponent(snippet.document.title)}&chunk=${encodeURIComponent(snippet.chunk.id)}`}>
          Open in Vault <ExternalLink size={12} />
        </Link>
      </div>
    </div>
  );
}

export interface SourceRailProps {
  target?: SourceTargetInput | null;
  title?: string;
  subtitle?: string;
  limit?: number;
  compact?: boolean;
  className?: string;
}

export function SourceRail({ target, title = 'Source Context', subtitle, limit = 4, compact = false, className }: SourceRailProps) {
  const stableTarget = useMemo(() => (target ? buildCfaSourceTarget(target) : null), [target]);
  const [snippets, setSnippets] = useState<CfaSourceSnippet[]>([]);
  const [loading, setLoading] = useState(Boolean(stableTarget));

  async function refresh() {
    if (!stableTarget) return;
    setLoading(true);
    const next = await getCfaSourceSnippetsForTarget(stableTarget, limit);
    setSnippets(next);
    setLoading(false);
  }

  useEffect(() => {
    let active = true;
    if (!stableTarget) {
      Promise.resolve().then(() => {
        if (!active) return;
        setSnippets([]);
        setLoading(false);
      });
      return () => {
        active = false;
      };
    }
    Promise.resolve().then(() => {
      if (active) setLoading(true);
      return getCfaSourceSnippetsForTarget(stableTarget, limit);
    }).then((next) => {
      if (!active) return;
      setSnippets(next);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [limit, stableTarget]);

  async function handlePin(snippet: CfaSourceSnippet) {
    if (!stableTarget) return;
    if (snippet.pinned) await clearCfaSourceLinkOverride(stableTarget.id, snippet.chunk.id);
    else await setCfaSourceLinkOverride(stableTarget.id, snippet.chunk.id, 'pin');
    refresh();
  }

  async function handleDismiss(snippet: CfaSourceSnippet) {
    if (!stableTarget) return;
    await setCfaSourceLinkOverride(stableTarget.id, snippet.chunk.id, 'dismiss');
    refresh();
  }

  return (
    <Surface tone="vault" density={compact ? 'compact' : 'default'} className={`source-rail ${compact ? 'source-rail-compact' : ''} ${className || ''}`} aria-busy={loading}>
      <div className="source-rail-head">
        <div>
          <StatusBadge tone="vault"><ShieldCheck size={14} /> private snippets</StatusBadge>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <BookOpen size={20} aria-hidden="true" />
      </div>
      {loading ? (
        <p className="muted-copy">Mapping private source context...</p>
      ) : snippets.length ? (
        <div className="source-snippet-list">
          {snippets.map((snippet) => (
            <SourceSnippet key={snippet.chunk.id} snippet={snippet} compact={compact} onPin={handlePin} onDismiss={handleDismiss} />
          ))}
        </div>
      ) : (
        <p className="muted-copy">Import a `.qvsource` bundle or rebuild the source map to show local CFA references here.</p>
      )}
    </Surface>
  );
}

export interface SourceCoverageMeterProps {
  coverage?: Partial<CfaSourceMapStatus> | null;
  status?: Partial<CfaSourceMapStatus> | null;
  title?: string;
}

export function SourceCoverageMeter({ coverage, status, title = 'Source Coverage' }: SourceCoverageMeterProps) {
  const officialPct = status?.documentCount ? Math.round(((status.officialDocumentCount ?? 0) / status.documentCount) * 100) : 0;
  return (
    <Surface tone="vault" density="compact" className="source-coverage-meter">
      <div className="source-rail-head">
        <div>
          <StatusBadge tone="success">private local only</StatusBadge>
          <h3>{title}</h3>
          <p>{coverage?.documentCount || 0} documents · {coverage?.chunkCount || 0} searchable chunks · {status?.linkCount || 0} mapped links</p>
        </div>
      </div>
      <ProgressRail value={officialPct} max={100} label="Official-source share" detail={`${officialPct}% official`} tone="vault" />
    </Surface>
  );
}

export function SourceMapStatus({ title = 'Source Map Status' }: { title?: string }) {
  const [status, setStatus] = useState<CfaSourceMapStatus | null>(null);
  useEffect(() => {
    let active = true;
    getCfaSourceMapStatus().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Surface tone="vault" density="compact" className="source-map-status">
      <StatusBadge tone="vault"><Search size={14} /> deterministic map</StatusBadge>
      <h3>{title}</h3>
      <p className="muted-copy">
        {status?.targetCount || 0} target(s) · {status?.linkCount || 0} link(s) · {status?.overrideCount || 0} override(s)
      </p>
    </Surface>
  );
}

export interface SourceLinkRebuildResult {
  targets: number;
  links: number;
}

export interface SourceLinkManagerProps {
  targets?: CfaSourceTarget[];
  onRebuilt?: (result: SourceLinkRebuildResult) => void;
}

export function SourceLinkManager({ targets = [], onRebuilt }: SourceLinkManagerProps) {
  const [busy, setBusy] = useState(false);
  async function rebuild() {
    setBusy(true);
    const result = await rebuildCfaSourceLinksForTargets(targets);
    setBusy(false);
    onRebuilt?.(result);
  }

  return (
    <InlineCluster>
      <button className="btn btn-primary" onClick={rebuild} disabled={busy || targets.length === 0}>
        <Search size={16} /> {busy ? 'Rebuilding...' : 'Rebuild Source Map'}
      </button>
      <StatusBadge tone="vault">{targets.length} local target(s)</StatusBadge>
    </InlineCluster>
  );
}
