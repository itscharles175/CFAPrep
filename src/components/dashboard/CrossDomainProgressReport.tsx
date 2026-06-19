import { Download, FileText, Printer } from 'lucide-react';
import { Panel, StatusBadge } from '../ui/Primitives';
import {
  useWeaknessIndex,
  type UseWeaknessIndexOptions,
  type WeaknessIndexItem,
  type WeaknessIndexMeta,
} from '../../hooks/useWeaknessIndex';
import {
  exportReportCsv,
  exportReportPrint,
  reportSummary,
} from '../../lib/crossDomainReportExport';

/**
 * ANL-7 — exportable cross-domain progress report card.
 *
 * Surfaces a one-line summary of the merged cross-domain weakness index (LSAT +
 * host, the same `useWeaknessIndex` source as ANL-2) and offers two exports:
 *   - CSV (one ranked area per row) via the shared `exportUtils`.
 *   - PDF via the browser print dialog (zero dependency, fully local).
 * All the artifact-building logic lives in `crossDomainReportExport.ts`; this is
 * just the Dashboard affordance.
 *
 * Two exports, mirroring the ANL-2 WeaknessIndexCard split:
 *   - {@link CrossDomainProgressReportView} is PRESENTATIONAL (data + handlers
 *     via props) so it renders deterministically in tests with no network.
 *   - the default {@link CrossDomainProgressReport} self-wires
 *     {@link useWeaknessIndex} so the Dashboard mounts it with zero plumbing.
 *
 * Fully degrading: an offline sidecar resolves to `reachable: false` and the
 * card shows an offline hint with the exports disabled (nothing to export).
 */

export interface CrossDomainProgressReportViewProps {
  items: WeaknessIndexItem[];
  meta: WeaknessIndexMeta | null;
  loading: boolean;
  reachable: boolean;
  onExportCsv: () => void;
  onExportPdf: () => void;
}

/** Presentational report card — no data fetching, no clock. */
export function CrossDomainProgressReportView({
  items,
  meta,
  loading,
  reachable,
  onExportCsv,
  onExportPdf,
}: CrossDomainProgressReportViewProps) {
  const hasData = items.length > 0;
  return (
    <Panel
      title="Cross-domain progress report"
      icon={<FileText size={18} />}
      actions={
        reachable && hasData ? (
          <StatusBadge tone="positive">{meta?.total ?? items.length} areas</StatusBadge>
        ) : null
      }
    >
      {loading ? (
        <p className="muted-copy">Gathering cross-domain progress…</p>
      ) : !reachable ? (
        <p className="muted-copy">
          The LSAT sidecar is offline — start it to build a cross-domain report.
        </p>
      ) : !hasData ? (
        <p className="muted-copy">
          No cross-domain progress signal yet. Complete a few questions across LSAT or your
          host domains, then export a report.
        </p>
      ) : (
        <>
          <p className="muted-copy" style={{ marginBottom: 'var(--space-3)' }}>
            {reportSummary(items, meta)} Export a portable snapshot for your records or to share
            with a coach.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={onExportCsv}>
              <Download size={16} /> Export CSV
            </button>
            <button type="button" className="btn btn-secondary" onClick={onExportPdf}>
              <Printer size={16} /> Export PDF
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Self-contained Dashboard card — wires {@link useWeaknessIndex} internally. */
export function CrossDomainProgressReport({
  options,
}: {
  options?: UseWeaknessIndexOptions;
}) {
  // Pull a generous slice (the report wants the full ranked list, not just the
  // dashboard top-few). 'all' spans LSAT + every host plane.
  const { items, meta, loading, reachable } = useWeaknessIndex(
    options ?? { domain: 'all', days: 30, limit: 100 },
  );
  return (
    <CrossDomainProgressReportView
      items={items}
      meta={meta}
      loading={loading}
      reachable={reachable}
      onExportCsv={() => exportReportCsv(items, new Date())}
      onExportPdf={() => exportReportPrint(items, meta, new Date())}
    />
  );
}

export default CrossDomainProgressReport;
