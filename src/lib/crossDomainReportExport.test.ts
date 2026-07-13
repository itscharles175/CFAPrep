import { describe, expect, it } from 'vitest';
import type { WeaknessIndexItem, WeaknessIndexMeta } from '../hooks/useWeaknessIndex';
import {
  REPORT_COLUMNS,
  buildReportHtml,
  buildReportRows,
  domainLabel,
  itemToRow,
  reportFilename,
  reportSummary,
} from './crossDomainReportExport';

function item(overrides: Partial<WeaknessIndexItem> = {}): WeaknessIndexItem {
  return {
    domain: 'lsat',
    key: 'Weaken',
    label: 'Weaken',
    sectionType: 'LR',
    accuracy: 0.42,
    mastery: 0.4,
    lowerBound: 0.31,
    attempts: 18,
    trend: 'down',
    recentMissIds: ['101', '102', '103'],
    drillPath: '/lsat/drill/weaken',
    ...overrides,
  };
}

const meta: WeaknessIndexMeta = {
  model: 'test',
  domain: 'all',
  windowDays: 30,
  total: 2,
  lsatCount: 1,
  hostCount: 1,
  generatedAt: '2026-06-19T00:00:00Z',
};

describe('crossDomainReportExport', () => {
  it('domainLabel maps known planes and upper-cases the rest', () => {
    expect(domainLabel('lsat')).toBe('LSAT');
    expect(domainLabel('cfa')).toBe('CFA');
    expect(domainLabel('mystery')).toBe('MYSTERY');
    expect(domainLabel('')).toBe('—');
  });

  it('itemToRow emits cells in REPORT_COLUMNS order with percent formatting', () => {
    const row = itemToRow(item());
    expect(row).toHaveLength(REPORT_COLUMNS.length);
    expect(row).toEqual(['LSAT', 'Weaken', 'LR', '42%', '40%', '31%', 18, 'down', 3]);
  });

  it('itemToRow leaves absent numerics blank rather than NaN%', () => {
    const row = itemToRow(item({ accuracy: null, mastery: null, lowerBound: null, sectionType: null, trend: null }));
    expect(row).toEqual(['LSAT', 'Weaken', '', '', '', '', 18, '', 3]);
  });

  it('buildReportRows prepends the header row', () => {
    const rows = buildReportRows([item(), item({ domain: 'cfa', label: 'Ethics' })]);
    expect(rows[0]).toEqual([...REPORT_COLUMNS]);
    expect(rows).toHaveLength(3);
    expect(rows[2][0]).toBe('CFA');
  });

  it('reportFilename is dated and slugged per extension', () => {
    const now = new Date('2026-06-19T12:34:56Z');
    expect(reportFilename(now, 'csv')).toBe('studyvault-cross-domain-report-2026-06-19.csv');
    expect(reportFilename(now, 'html')).toBe('studyvault-cross-domain-report-2026-06-19.html');
  });

  it('reportSummary counts areas and planes from meta', () => {
    expect(reportSummary([item(), item({ domain: 'cfa' })], meta)).toBe(
      '2 areas ranked across 1 LSAT + 1 host signal.',
    );
  });

  it('reportSummary falls back to item-derived counts without meta', () => {
    const summary = reportSummary([item(), item({ domain: 'cfa' }), item({ domain: 'quant' })], null);
    expect(summary).toBe('3 areas ranked across 1 LSAT + 2 host signals.');
  });

  it('buildReportHtml renders a table with the rows and escapes HTML', () => {
    const html = buildReportHtml([item({ label: 'A & B <x>' })], meta, 'Jun 19, 2026');
    expect(html).toContain('<table>');
    expect(html).toContain('A &amp; B &lt;x&gt;');
    expect(html).toContain('Generated Jun 19, 2026');
    expect(html).not.toContain('<x>');
  });

  it('buildReportHtml shows an empty state with no items', () => {
    const html = buildReportHtml([], null, 'Jun 19, 2026');
    expect(html).not.toContain('<table>');
    expect(html).toContain('No cross-domain progress signal yet');
  });
});
