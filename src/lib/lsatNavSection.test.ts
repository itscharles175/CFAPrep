import { describe, expect, it } from 'vitest';
import { buildLsatNavGroups } from './lsatNavSection';

function rowsFor(mode: 'study' | 'test') {
  return buildLsatNavGroups(mode).flatMap((group) => group.items);
}

describe('buildLsatNavGroups', () => {
  it('keeps common workspace routes out of the LSAT track rail', () => {
    const rows = rowsFor('study');
    const paths = rows.map((row) => row.path);

    expect(paths).not.toEqual(expect.arrayContaining([
      '/lsat',
      '/lsat/dashboard',
      '/lsat/practice',
      '/lsat/review',
      '/lsat/analytics',
    ]));
    expect(paths).toEqual(expect.arrayContaining([
      '/lsat/preptests',
      '/lsat/drills',
      '/lsat/playlists',
      '/lsat/tutor',
      '/lsat/rc-lab',
      '/lsat/review/history',
      '/lsat/srs',
      '/lsat/settings',
    ]));
  });

  it('retains the manifest Test Mode filter after shared-route deduplication', () => {
    const paths = rowsFor('test').map((row) => row.path);

    expect(paths).toEqual(expect.arrayContaining([
      '/lsat/preptests',
      '/lsat/drills',
      '/lsat/playlists',
      '/lsat/settings',
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      '/lsat/tutor',
      '/lsat/rc-lab',
      '/lsat/review/history',
      '/lsat/srs',
    ]));
  });
});
