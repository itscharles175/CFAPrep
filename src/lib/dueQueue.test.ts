import { describe, it, expect } from 'vitest';
import {
  rankDueQueue,
  buildUnifiedDueQueue,
  hostRowToRankable,
  canonicalToRankable,
  type RankableCard,
  type AbilityByPlane,
  type HostReviewQueueRow,
} from './dueQueue';
import { makeCrossDomainId, type CrossDomainReviewCard } from './dataDictionary';

const NOW = new Date('2026-06-19T12:00:00.000Z');

/** ISO timestamp `days` before NOW (negative ⇒ in the future). */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function card(partial: Partial<RankableCard> & Pick<RankableCard, 'id' | 'plane'>): RankableCard {
  return {
    title: partial.id,
    difficulty: 'intermediate',
    ...partial,
  };
}

describe('rankDueQueue — overdue ordering', () => {
  it('ranks the more-overdue card higher (overdue is the dominant term)', () => {
    const cards = [
      card({ id: 'cfa:review:fresh', plane: 'cfa', dueAt: daysAgo(0) }),
      card({ id: 'lsat:review:old', plane: 'lsat', dueAt: daysAgo(20) }),
      card({ id: 'cfa:review:mid', plane: 'cfa', dueAt: daysAgo(5) }),
    ];
    const ranked = rankDueQueue(cards, { now: NOW });
    expect(ranked.map((c) => c.id)).toEqual([
      'lsat:review:old',
      'cfa:review:mid',
      'cfa:review:fresh',
    ]);
  });

  it('interleaves planes by overdue — NOT host-first concatenation (the PSY-13 fix)', () => {
    // A badly-overdue LSAT card must outrank a freshly-due host card.
    const ranked = rankDueQueue(
      [
        card({ id: 'cfa:review:a', plane: 'cfa', dueAt: daysAgo(0) }),
        card({ id: 'lsat:review:b', plane: 'lsat', dueAt: daysAgo(30) }),
      ],
      { now: NOW },
    );
    expect(ranked[0].id).toBe('lsat:review:b');
    expect(ranked[0].plane).toBe('lsat');
  });

  it('treats a missing dueAt as due-now (overdue 0), ranking below overdue cards', () => {
    const ranked = rankDueQueue(
      [
        card({ id: 'a', plane: 'cfa' }), // no dueAt
        card({ id: 'b', plane: 'cfa', dueAt: daysAgo(3) }),
      ],
      { now: NOW },
    );
    expect(ranked.map((c) => c.id)).toEqual(['b', 'a']);
    const a = ranked.find((c) => c.id === 'a')!;
    expect(a.overdueDays).toBe(0);
    expect(a.components.overdue).toBe(0);
  });

  it('clamps a not-yet-due card to overdue 0 (no negative urgency)', () => {
    const ranked = rankDueQueue([card({ id: 'future', plane: 'cfa', dueAt: daysAgo(-5) })], {
      now: NOW,
    });
    expect(ranked[0].overdueDays).toBe(0);
  });
});

describe('rankDueQueue — ability-weighted utility', () => {
  const ability: AbilityByPlane = {
    // Frontier at theta=0 (intermediate); high uncertainty ⇒ strong weight.
    cfa: { theta: 0, uncertainty: 1.0 },
  };

  it('adds a positive ability term only for planes WITH a snapshot', () => {
    const ranked = rankDueQueue(
      [
        card({ id: 'cfa:x', plane: 'cfa', dueAt: daysAgo(2) }),
        card({ id: 'lsat:y', plane: 'lsat', dueAt: daysAgo(2) }),
      ],
      { now: NOW, ability },
    );
    const cfa = ranked.find((c) => c.id === 'cfa:x')!;
    const lsat = ranked.find((c) => c.id === 'lsat:y')!;
    expect(cfa.components.abilityUtility).toBeGreaterThan(0);
    expect(lsat.components.abilityUtility).toBe(0); // no lsat snapshot ⇒ degrades
  });

  it('weights a frontier-difficulty card above a far-easier one (same overdue)', () => {
    // empiricalDifficulty 0.5 ⇒ b≈0 (at frontier); 0.95 ⇒ b≪0 (far easier, mastered).
    const ranked = rankDueQueue(
      [
        card({ id: 'cfa:frontier', plane: 'cfa', dueAt: daysAgo(2), empiricalDifficulty: 0.5 }),
        card({ id: 'cfa:easy', plane: 'cfa', dueAt: daysAgo(2), empiricalDifficulty: 0.97 }),
      ],
      { now: NOW, ability },
    );
    expect(ranked[0].id).toBe('cfa:frontier');
    const frontier = ranked.find((c) => c.id === 'cfa:frontier')!;
    const easy = ranked.find((c) => c.id === 'cfa:easy')!;
    expect(frontier.components.abilityUtility).toBeGreaterThan(easy.components.abilityUtility);
  });

  it('DEGRADES TO OVERDUE-ONLY when no ability is supplied at all', () => {
    const cards = [
      card({ id: 'a', plane: 'cfa', dueAt: daysAgo(2), empiricalDifficulty: 0.5 }),
      card({ id: 'b', plane: 'cfa', dueAt: daysAgo(2), empiricalDifficulty: 0.97 }),
    ];
    const ranked = rankDueQueue(cards, { now: NOW }); // no ability
    ranked.forEach((c) => expect(c.components.abilityUtility).toBe(0));
    // With equal overdue + no ability term + no leech, order falls to the stable
    // id tie-break.
    expect(ranked.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('zero-uncertainty ability contributes nothing (already certain ⇒ no gain)', () => {
    const ranked = rankDueQueue([card({ id: 'cfa:x', plane: 'cfa', dueAt: daysAgo(1) })], {
      now: NOW,
      ability: { cfa: { theta: 0, uncertainty: 0 } },
    });
    expect(ranked[0].components.abilityUtility).toBe(0);
  });
});

describe('rankDueQueue — leech boost + stable ties', () => {
  it('boosts a leech above a non-leech with the same overdue', () => {
    const ranked = rankDueQueue(
      [
        card({ id: 'plain', plane: 'cfa', dueAt: daysAgo(3) }),
        card({ id: 'leech', plane: 'cfa', dueAt: daysAgo(3), leech: true }),
      ],
      { now: NOW },
    );
    expect(ranked[0].id).toBe('leech');
    expect(ranked[0].components.leech).toBeGreaterThan(0);
  });

  it('is deterministic — identical inputs yield identical order', () => {
    const cards = [
      card({ id: 'z', plane: 'lsat', dueAt: daysAgo(1) }),
      card({ id: 'a', plane: 'cfa', dueAt: daysAgo(1) }),
      card({ id: 'm', plane: 'quant', dueAt: daysAgo(1) }),
    ];
    const r1 = rankDueQueue(cards, { now: NOW }).map((c) => c.id);
    const r2 = rankDueQueue([...cards].reverse(), { now: NOW }).map((c) => c.id);
    expect(r1).toEqual(r2);
    // Equal score ⇒ plane order tie-break (cfa < quant < lsat).
    expect(r1).toEqual(['a', 'm', 'z']);
  });

  it('honours the limit option', () => {
    const cards = Array.from({ length: 10 }, (_, i) =>
      card({ id: `c${i}`, plane: 'cfa', dueAt: daysAgo(i) }),
    );
    expect(rankDueQueue(cards, { now: NOW, limit: 3 })).toHaveLength(3);
    expect(rankDueQueue(cards, { now: NOW, limit: 0 })).toHaveLength(0);
  });
});

describe('adapters', () => {
  it('hostRowToRankable namespaces the id and defaults to the cfa plane + intermediate', () => {
    const row: HostReviewQueueRow = {
      id: 'item-1',
      title: 'Ethics review',
      path: '/review?item=item-1',
      dueAt: daysAgo(1),
      topic: 'ethics',
      type: 'due-review',
    };
    const r = hostRowToRankable(row);
    expect(r.id).toBe('cfa:host:item-1');
    expect(r.plane).toBe('cfa');
    expect(r.difficulty).toBe('intermediate');
    expect(r.itemType).toBe('ethics');
    expect(r.source).toBe(row);
  });

  it('canonicalToRankable carries empiricalDifficulty + leech + path through', () => {
    const canonical: CrossDomainReviewCard = {
      crossId: makeCrossDomainId('lsat', 'review', 4821),
      domain: 'lsat',
      questionCrossId: makeCrossDomainId('lsat', 'question', 4821),
      title: 'Weaken — stimulus',
      difficulty: 'advanced',
      empiricalDifficulty: 0.31,
      dueAt: daysAgo(4),
      itemType: 'Weaken',
      leech: true,
    };
    const r = canonicalToRankable(canonical, { path: '/lsat/srs' });
    expect(r.id).toBe('lsat:review:4821');
    expect(r.plane).toBe('lsat');
    expect(r.empiricalDifficulty).toBe(0.31);
    expect(r.leech).toBe(true);
    expect(r.path).toBe('/lsat/srs');
  });
});

describe('buildUnifiedDueQueue — one ranked queue from both sources', () => {
  it('merges host rows + LSAT canonical cards into one interleaved ranking', () => {
    const hostRows: HostReviewQueueRow[] = [
      { id: 'h1', title: 'Fresh host card', path: '/review?item=h1', dueAt: daysAgo(0) },
    ];
    const lsatCards = [
      {
        canonical: {
          crossId: makeCrossDomainId('lsat', 'review', 1),
          domain: 'lsat',
          questionCrossId: makeCrossDomainId('lsat', 'question', 1),
          title: 'Very overdue LSAT card',
          difficulty: 'intermediate',
          dueAt: daysAgo(25),
        } as CrossDomainReviewCard,
        deepLinkPath: '/lsat/srs',
      },
    ];
    const ranked = buildUnifiedDueQueue({ hostRows, lsatCards }, { now: NOW });
    expect(ranked).toHaveLength(2);
    // The overdue LSAT card wins — host-first concatenation is gone.
    expect(ranked[0].id).toBe('lsat:review:1');
    expect(ranked[1].id).toBe('cfa:host:h1');
  });

  it('handles empty / missing sources without throwing', () => {
    expect(buildUnifiedDueQueue({}, { now: NOW })).toEqual([]);
    expect(buildUnifiedDueQueue({ hostRows: [] }, { now: NOW })).toEqual([]);
  });
});
