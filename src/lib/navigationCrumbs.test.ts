import { describe, expect, it } from 'vitest';
import { crumbsForPath, labelForPath } from './navigationCrumbs';

describe('crumbsForPath — host plane', () => {
  it('returns a single (label-only) crumb at the host root', () => {
    expect(crumbsForPath('/')).toEqual([{ label: 'Today', to: undefined }]);
  });

  it('uses the manifest breadcrumbs for a static host route, last crumb un-linked', () => {
    const crumbs = crumbsForPath('/analytics');
    expect(crumbs[0]).toEqual({ label: 'Today', to: '/' });
    expect(crumbs[crumbs.length - 1].to).toBeUndefined();
    expect(crumbs[crumbs.length - 1].label).toBe('Analytics');
  });

  it('matches a DYNAMIC host route (/cfa/:level/:topic) via matchPath', () => {
    const crumbs = crumbsForPath('/cfa/level1/fixed-income');
    const labels = crumbs.map((c) => c.label);
    // Today > CFA > CFA Module
    expect(labels[0]).toBe('Today');
    expect(labels).toContain('CFA');
    expect(labels[labels.length - 1]).toBe('CFA Module');
  });

  it('degrades gracefully for an unknown host route', () => {
    const crumbs = crumbsForPath('/not-in-manifest');
    expect(crumbs[0]).toEqual({ label: 'Today', to: '/' });
    expect(crumbs[crumbs.length - 1].to).toBeUndefined();
  });
});

describe('crumbsForPath — LSAT plane', () => {
  it('returns a single (label-only) crumb at the LSAT root (/lsat)', () => {
    expect(crumbsForPath('/lsat')).toEqual([{ label: 'LSAT Lab' }]);
  });

  it('builds a LSAT Lab > <page> trail with the /lsat prefix on links', () => {
    const crumbs = crumbsForPath('/lsat/srs');
    expect(crumbs[0]).toEqual({ label: 'LSAT Lab', to: '/lsat' });
    expect(crumbs[crumbs.length - 1]).toEqual({ label: 'SRS' });
  });

  it('nests a deep LSAT screen under its PARENT (Session history under Review)', () => {
    const crumbs = crumbsForPath('/lsat/review/history');
    const labels = crumbs.map((c) => c.label);
    expect(labels).toEqual(['LSAT Lab', 'Review', 'Session history']);
    // Parent link carries the /lsat prefix.
    expect(crumbs[1].to).toBe('/lsat/review');
  });

  it('resolves dynamic LSAT labels (/analytics/type/:type)', () => {
    const crumbs = crumbsForPath('/lsat/analytics/type/strengthen');
    const labels = crumbs.map((c) => c.label);
    expect(labels).toEqual(['LSAT Lab', 'Analytics', 'Type analytics']);
  });
});

describe('labelForPath', () => {
  it('returns the final crumb label for any plane', () => {
    expect(labelForPath('/analytics')).toBe('Analytics');
    expect(labelForPath('/lsat/srs')).toBe('SRS');
    expect(labelForPath('/lsat')).toBe('LSAT Lab');
  });
});
