/**
 * ANL-7 — exportable cross-domain progress report (CSV + print-to-PDF).
 *
 * Turns the merged cross-domain weakness index (LSAT per-type mastery + host
 * per-topic accuracy, ranked by the ~95% credible lower bound — see
 * `useWeaknessIndex`) into a portable artifact the user can keep or share:
 *
 *   - CSV via the shared `exportUtils` (`downloadCsv`), one row per ranked area.
 *   - PDF via the browser's print dialog (zero dependency, fully local): a
 *     styled standalone HTML document is opened in a new window and `print()`d,
 *     so the user can "Save as PDF". No bundled PDF lib, nothing leaves the box.
 *
 * The builders (`buildReportRows`, `buildReportHtml`, `reportFilename`) are PURE
 * and DOM-free so they unit-test without a browser; the two `export*` wrappers
 * are the thin DOM/`window` side-effecting shells. Everything degrades quietly:
 * an empty item list still produces a valid (header-only / "no data") artifact,
 * and a blocked popup is a no-op rather than a throw.
 */
import type { WeaknessIndexItem, WeaknessIndexMeta } from '../hooks/useWeaknessIndex';
import { type CsvRow, downloadCsv, downloadTextFile } from './exportUtils';

/** A 0..1 fraction as a whole-percent string, or "" when absent (CSV-friendly). */
function pctCell(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  return `${Math.round(value * 100)}%`;
}

/** Short, stable domain label for a report row. */
export function domainLabel(domain: string): string {
  switch (domain) {
    case 'lsat':
      return 'LSAT';
    case 'cfa':
      return 'CFA';
    case 'quant':
      return 'Quant';
    case 'excel':
      return 'Excel';
    default:
      return domain ? domain.toUpperCase() : '—';
  }
}

/** The report's column headers, in order. Shared by the CSV + the print table. */
export const REPORT_COLUMNS = [
  'Domain',
  'Area',
  'Section',
  'Accuracy',
  'Mastery',
  'Confidence floor',
  'Attempts',
  'Trend',
  'Recent misses',
] as const;

/** One ranked area as an ordered cell list, matching {@link REPORT_COLUMNS}. */
export function itemToRow(item: WeaknessIndexItem): CsvRow {
  return [
    domainLabel(item.domain),
    item.label,
    item.sectionType ?? '',
    pctCell(item.accuracy),
    pctCell(item.mastery),
    pctCell(item.lowerBound),
    item.attempts,
    item.trend ?? '',
    item.recentMissIds.length,
  ];
}

/** Header + one row per ranked area — the full CSV grid (pure). */
export function buildReportRows(items: WeaknessIndexItem[]): CsvRow[] {
  return [[...REPORT_COLUMNS], ...items.map(itemToRow)];
}

/** A dated, slugged filename for the report artifact. `now` is injected so the
 *  builder stays pure/testable (no implicit clock). */
export function reportFilename(now: Date, ext: 'csv' | 'html'): string {
  const day = now.toISOString().slice(0, 10);
  return `studyvault-cross-domain-report-${day}.${ext}`;
}

/** A one-line provenance summary ("12 areas across LSAT + 3 host planes"). */
export function reportSummary(items: WeaknessIndexItem[], meta: WeaknessIndexMeta | null): string {
  const total = meta?.total ?? items.length;
  const planes = new Set(items.map((i) => i.domain));
  const lsat = meta?.lsatCount ?? (planes.has('lsat') ? 1 : 0);
  const host = meta?.hostCount ?? [...planes].filter((p) => p !== 'lsat').length;
  const areaWord = total === 1 ? 'area' : 'areas';
  return `${total} ${areaWord} ranked across ${lsat} LSAT + ${host} host signal${host === 1 ? '' : 's'}.`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A standalone, self-styled HTML document for the print-to-PDF path (pure).
 * Inlines its own CSS (the print window has none of the app's styles) and is
 * deliberately monochrome/print-friendly. `generatedLabel` is passed in so the
 * builder takes no implicit clock.
 */
export function buildReportHtml(
  items: WeaknessIndexItem[],
  meta: WeaknessIndexMeta | null,
  generatedLabel: string,
): string {
  const rows = items
    .map(
      (item) => `<tr>
      <td>${escapeHtml(domainLabel(item.domain))}</td>
      <td>${escapeHtml(item.label)}</td>
      <td>${escapeHtml(item.sectionType ?? '')}</td>
      <td class="num">${escapeHtml(pctCell(item.accuracy))}</td>
      <td class="num">${escapeHtml(pctCell(item.mastery))}</td>
      <td class="num">${escapeHtml(pctCell(item.lowerBound))}</td>
      <td class="num">${escapeHtml(item.attempts)}</td>
      <td>${escapeHtml(item.trend ?? '')}</td>
      <td class="num">${escapeHtml(item.recentMissIds.length)}</td>
    </tr>`,
    )
    .join('\n');
  const body = items.length
    ? `<table>
      <thead><tr>${REPORT_COLUMNS.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    : `<p class="empty">No cross-domain progress signal yet — complete a few questions across LSAT or your host domains and re-export.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>StudyVault — Cross-Domain Progress Report</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #555; margin: 0 0 20px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
  th { border-bottom: 2px solid #999; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #555; }
  @media print { body { margin: 0; } @page { margin: 16mm; } }
</style></head>
<body>
  <h1>Cross-Domain Progress Report</h1>
  <p class="meta">${escapeHtml(reportSummary(items, meta))} &middot; Generated ${escapeHtml(generatedLabel)}</p>
  ${body}
</body></html>`;
}

/** Download the report as CSV. Thin DOM wrapper over the pure row builder. */
export function exportReportCsv(items: WeaknessIndexItem[], now: Date): void {
  downloadCsv(reportFilename(now, 'csv'), buildReportRows(items));
}

/**
 * Open the report in a new window and trigger the print dialog (Save as PDF).
 * Falls back to downloading the standalone HTML when the popup is blocked, so
 * the export never silently fails. Returns true when the print window opened.
 */
export function exportReportPrint(
  items: WeaknessIndexItem[],
  meta: WeaknessIndexMeta | null,
  now: Date,
): boolean {
  const html = buildReportHtml(items, meta, now.toLocaleString());
  const win = typeof window !== 'undefined' ? window.open('', '_blank', 'noopener,noreferrer') : null;
  if (!win) {
    // Popup blocked — hand the user the same document as a file they can print.
    downloadTextFile(reportFilename(now, 'html'), html, 'text/html');
    return false;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Let the new document lay out before invoking print (some engines no-op a
  // synchronous print on a just-written document).
  win.setTimeout(() => win.print(), 250);
  return true;
}
