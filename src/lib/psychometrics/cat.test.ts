import { describe, it, expect } from 'vitest';
import {
  probCorrect,
  fisherInformation,
  estimateAbilityEAP,
  selectNextItem,
  itemToCatParams,
  runCatSession,
  type CatItemParams,
} from './cat';

/** A spread item bank with a range of difficulties + discriminations. */
function makeBank(): CatItemParams[] {
  const bank: CatItemParams[] = [];
  let i = 0;
  for (const b of [-2, -1, 0, 1, 2]) {
    for (const a of [0.6, 1.2, 1.8]) {
      bank.push({ id: `q${i++}`, a, b });
    }
  }
  return bank;
}

describe('probCorrect (2PL/3PL)', () => {
  it('is 0.5 at theta = b for pure 2PL', () => {
    expect(probCorrect({ id: 'x', a: 1, b: 0 }, 0)).toBeCloseTo(0.5, 6);
    expect(probCorrect({ id: 'x', a: 1.7, b: 1 }, 1)).toBeCloseTo(0.5, 6);
  });

  it('is monotonic increasing in theta', () => {
    const item = { id: 'x', a: 1.2, b: 0.3 };
    const lo = probCorrect(item, -2);
    const mid = probCorrect(item, 0);
    const hi = probCorrect(item, 2);
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
  });

  it('respects the guessing lower asymptote (3PL c)', () => {
    const p = probCorrect({ id: 'x', a: 1, b: 0, c: 0.25 }, -10);
    expect(p).toBeGreaterThanOrEqual(0.25);
    expect(p).toBeLessThan(0.26);
  });

  it('is numerically stable for extreme theta', () => {
    expect(probCorrect({ id: 'x', a: 2, b: 0 }, 50)).toBeCloseTo(1, 6);
    expect(probCorrect({ id: 'x', a: 2, b: 0 }, -50)).toBeCloseTo(0, 6);
  });
});

describe('fisherInformation', () => {
  it('is maximal at theta = b for 2PL', () => {
    const item = { id: 'x', a: 1.5, b: 0.5 };
    const atB = fisherInformation(item, 0.5);
    expect(atB).toBeGreaterThan(fisherInformation(item, -1));
    expect(atB).toBeGreaterThan(fisherInformation(item, 2));
    // 2PL info at b = a^2 * 0.25
    expect(atB).toBeCloseTo(item.a * item.a * 0.25, 5);
  });

  it('grows with discrimination a', () => {
    const lowA = fisherInformation({ id: 'x', a: 0.5, b: 0 }, 0);
    const highA = fisherInformation({ id: 'x', a: 2.0, b: 0 }, 0);
    expect(highA).toBeGreaterThan(lowA);
  });

  it('is zero at saturated probabilities', () => {
    expect(fisherInformation({ id: 'x', a: 2, b: 0 }, 100)).toBe(0);
  });
});

describe('estimateAbilityEAP', () => {
  it('returns the prior with no responses', () => {
    const est = estimateAbilityEAP(makeBank(), []);
    expect(est.theta).toBeCloseTo(0, 6);
    expect(est.se).toBeCloseTo(1, 1); // prior SD = 1
    expect(est.responses).toBe(0);
  });

  it('moves theta up after a hard correct, down after an easy miss', () => {
    const bank = makeBank();
    const hardItem = bank.find((it) => it.b === 2)!;
    const easyItem = bank.find((it) => it.b === -2)!;

    const up = estimateAbilityEAP(bank, [{ id: hardItem.id, correct: true }]);
    expect(up.theta).toBeGreaterThan(0);

    const down = estimateAbilityEAP(bank, [{ id: easyItem.id, correct: false }]);
    expect(down.theta).toBeLessThan(0);
  });

  it('shrinks SE as evidence accumulates', () => {
    const bank = makeBank();
    const one = estimateAbilityEAP(bank, [{ id: 'q6', correct: true }]); // b=0 item
    const many = estimateAbilityEAP(
      bank,
      bank.map((it) => ({ id: it.id, correct: it.b <= 0 })),
    );
    expect(many.se).toBeLessThan(one.se);
  });

  it('does not diverge on an all-correct run (bounded EAP)', () => {
    const bank = makeBank();
    const est = estimateAbilityEAP(
      bank,
      bank.map((it) => ({ id: it.id, correct: true })),
    );
    expect(Number.isFinite(est.theta)).toBe(true);
    expect(est.theta).toBeLessThanOrEqual(4); // grid bound
    expect(est.theta).toBeGreaterThan(1); // strongly positive but finite
  });
});

describe('selectNextItem (max Fisher information)', () => {
  it('picks the most informative item at the current theta', () => {
    const bank = makeBank();
    // At theta=0 with no responses, the b=0 high-a item is most informative.
    const sel = selectNextItem(bank, []);
    expect(sel.done).toBe(false);
    expect(sel.item).not.toBeNull();
    expect(sel.item!.b).toBe(0);
    expect(sel.item!.a).toBe(1.8);
  });

  it('never re-administers an item', () => {
    const bank = makeBank();
    const responses = [{ id: 'q8', correct: true }]; // q8 = b0,a1.8
    const sel = selectNextItem(bank, responses);
    expect(sel.item!.id).not.toBe('q8');
  });

  it('is deterministic for the same pool + history', () => {
    const bank = makeBank();
    const a = selectNextItem(bank, [{ id: 'q0', correct: false }]);
    const b = selectNextItem(bank, [{ id: 'q0', correct: false }]);
    expect(a.item!.id).toBe(b.item!.id);
  });

  it('signals done when the SE target is met', () => {
    const bank = makeBank();
    // Loose SE target so it stops almost immediately, but respect minItems.
    const responses = bank.slice(0, 8).map((it) => ({ id: it.id, correct: it.b < 0.5 }));
    const sel = selectNextItem(bank, responses, { seTarget: 2, minItems: 1 });
    expect(sel.done).toBe(true);
    expect(sel.item).toBeNull();
  });

  it('signals done when the pool is exhausted', () => {
    const bank = makeBank().slice(0, 2);
    const responses = bank.map((it) => ({ id: it.id, correct: true }));
    const sel = selectNextItem(bank, responses, { seTarget: 0.001, maxItems: 100 });
    expect(sel.done).toBe(true);
  });

  it('signals done at the max-items budget', () => {
    const bank = makeBank();
    const responses = bank.slice(0, 3).map((it) => ({ id: it.id, correct: true }));
    const sel = selectNextItem(bank, responses, { maxItems: 3, seTarget: 0.001 });
    expect(sel.done).toBe(true);
  });
});

describe('runCatSession (offline 2PL simulator)', () => {
  it('recovers a known true ability within tolerance', () => {
    // Large, well-spread bank so the adaptive loop has informative items at theta.
    const bank: CatItemParams[] = [];
    let i = 0;
    for (let b = -3; b <= 3; b += 0.25) {
      bank.push({ id: `q${i++}`, a: 1.4, b: Math.round(b * 100) / 100 });
    }
    const trueTheta = 1.0;
    // Deterministic responder: correct iff the model's P(correct) ≥ 0.5 at the
    // true theta (a clean, noise-free oracle so recovery is deterministic).
    const respond = (item: CatItemParams) => probCorrect(item, trueTheta) >= 0.5;

    const { estimate, administered } = runCatSession(bank, respond, {
      seTarget: 0.3,
      maxItems: 25,
      minItems: 5,
    });
    expect(estimate.theta).toBeGreaterThan(0.5);
    expect(estimate.theta).toBeLessThan(1.6);
    expect(administered.length).toBeGreaterThanOrEqual(5);
    // No item administered twice.
    expect(new Set(administered.map((a) => a.id)).size).toBe(administered.length);
  });

  it('stops once the SE target is reached', () => {
    const bank: CatItemParams[] = [];
    let i = 0;
    for (let b = -3; b <= 3; b += 0.2) bank.push({ id: `q${i++}`, a: 1.6, b });
    const respond = (item: CatItemParams) => probCorrect(item, 0) >= 0.5;
    const { responses, estimate } = runCatSession(bank, respond, { seTarget: 0.35, maxItems: 50, minItems: 3 });
    expect(estimate.se).toBeLessThanOrEqual(0.4);
    expect(responses.length).toBeLessThan(50);
  });
});

describe('itemToCatParams (empirical bank → 2PL)', () => {
  it('maps a 50/50 item to b ≈ 0', () => {
    const params = itemToCatParams({ questionId: 'q', empiricalDifficulty: 0.5, discrimination: 0.3 });
    expect(params.b).toBeCloseTo(0, 6);
  });

  it('maps a hard item (high empirical difficulty) to positive b', () => {
    const params = itemToCatParams({ questionId: 'q', empiricalDifficulty: 0.9, discrimination: 0.3 });
    expect(params.b).toBeGreaterThan(1);
  });

  it('maps an easy item to negative b', () => {
    const params = itemToCatParams({ questionId: 'q', empiricalDifficulty: 0.1, discrimination: 0.3 });
    expect(params.b).toBeLessThan(-1);
  });

  it('floors discrimination so an undiscriminating item still has slope', () => {
    const params = itemToCatParams({ questionId: 'q', empiricalDifficulty: 0.5, discrimination: 0 });
    expect(params.a).toBeGreaterThanOrEqual(0.3);
  });

  it('clamps difficulty onto the theta grid bounds', () => {
    const params = itemToCatParams({ questionId: 'q', empiricalDifficulty: 1, discrimination: 0.3 });
    expect(params.b).toBeLessThanOrEqual(4);
    expect(params.b).toBeGreaterThanOrEqual(-4);
  });
});
