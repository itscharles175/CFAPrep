import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewItem } from '../learningTypes';

// ---------------------------------------------------------------------------
// surrealdb client mock — mirrors schema.test.ts so importing the driver never
// reaches a live :8000 sidecar. We only capture the record ids that flow
// through upsert/select/delete so the encoding can be asserted end-to-end.
// ---------------------------------------------------------------------------
const surrealState = vi.hoisted(() => {
  return {
    upsertCalls: [] as Array<{ id: string; payload: unknown }>,
    selectCalls: [] as Array<{ target: string }>,
    deleteCalls: [] as Array<{ target: string }>,
    queryCalls: [] as Array<{ sql: string; binds: Record<string, unknown> | undefined }>,
  };
});

vi.mock('surrealdb', () => {
  class StringRecordId {
    rid: string;
    constructor(rid: string) {
      this.rid = rid;
    }
  }
  class Surreal {
    async connect() {}
    async use() {}
    async ping() {}
    async close() {}
    async query(sql: string, binds?: Record<string, unknown>): Promise<unknown> {
      surrealState.queryCalls.push({ sql, binds });
      return [[]];
    }
    async upsert(rid: unknown, payload: unknown): Promise<void> {
      surrealState.upsertCalls.push({
        id: rid instanceof StringRecordId ? rid.rid : String(rid),
        payload,
      });
    }
    async create(): Promise<void> {}
    async select(target?: unknown): Promise<unknown> {
      surrealState.selectCalls.push({
        target: target instanceof StringRecordId ? target.rid : String(target),
      });
      return [];
    }
    async delete(target: unknown): Promise<void> {
      surrealState.deleteCalls.push({
        target: target instanceof StringRecordId ? target.rid : String(target),
      });
    }
  }
  return { Surreal, StringRecordId };
});

function makeReviewItem(id: string): ReviewItem {
  return {
    id,
    domain: 'cfa',
    topic: 'fixed-income',
    learningObjective: 'los-1',
    title: 'Modified duration',
    path: '/cfa/fixed-income/duration',
    intervalDays: 3,
    ease: 2.5,
    fsrsDifficulty: 5.1,
    dueAt: '2026-06-01T00:00:00.000Z',
    lastResultAt: '2026-05-28T00:00:00.000Z',
    attempts: 4,
    correctStreak: 2,
    lastCorrect: true,
    lastConfidence: 'high',
    lastErrorCategory: 'none',
  };
}

// ---------------------------------------------------------------------------
// sanitiseId / decodeId — reversible, injective record-id encoding (DATA-4)
// ---------------------------------------------------------------------------
//
// Adversarial inputs intentionally include the colon-delimited cross-domain
// ids that the previous `_`-replacement scheme collided on, plus spaces,
// punctuation, unicode, and empty/edge cases.
const ADVERSARIAL_IDS = [
  '',
  'a',
  'a:b',
  'a::b',
  'domain:topic:lo',
  'domain::topic::lo',
  'cfa::fixed-income::los-1',
  'cfa:fixed-income:los-1',
  'weird id*x',
  'weird_id_x',
  'has space',
  'has  two  spaces',
  'tab\tnewline\n',
  'slash/back\\slash',
  'percent%literal',
  'at@hash#dollar$',
  'emoji-🚀-rocket',
  'accents-café-naïve',
  'cjk-日本語',
  'mixed::a b/c%d:日',
  '::',
  ':',
  '__',
  '---',
];

describe('sanitiseId (DATA-4 reversible injective encoding)', () => {
  beforeEach(() => {
    surrealState.upsertCalls = [];
    surrealState.selectCalls = [];
    surrealState.deleteCalls = [];
    surrealState.queryCalls = [];
  });

  it('produces only SurrealDB-id-safe characters', async () => {
    const { sanitiseId } = await import('./surrealDriver');
    for (const id of ADVERSARIAL_IDS) {
      expect(sanitiseId(id)).toMatch(/^[A-Za-z0-9_%-]*$/);
    }
  });

  it('leaves the safe charset untouched', async () => {
    const { sanitiseId } = await import('./surrealDriver');
    expect(sanitiseId('a')).toBe('a');
    expect(sanitiseId('weird_id_x')).toBe('weird_id_x');
    expect(sanitiseId('los-1')).toBe('los-1');
    expect(sanitiseId('ABCxyz_-0129')).toBe('ABCxyz_-0129');
  });

  it('is INJECTIVE — distinct inputs never collide', async () => {
    const { sanitiseId } = await import('./surrealDriver');
    const seen = new Map<string, string>();
    for (const id of ADVERSARIAL_IDS) {
      const slug = sanitiseId(id);
      const prior = seen.get(slug);
      expect(prior, `"${id}" and "${prior}" both encode to "${slug}"`).toBeUndefined();
      seen.set(slug, id);
    }
  });

  it('distinguishes the colon-collision case that motivated the fix', async () => {
    const { sanitiseId } = await import('./surrealDriver');
    // Under the old `_`-replacement scheme these all flattened to the same slug.
    expect(sanitiseId('domain::topic::lo')).not.toBe(sanitiseId('domain:topic:lo'));
    expect(sanitiseId('a::b')).not.toBe(sanitiseId('a:b'));
    expect(sanitiseId('::')).not.toBe(sanitiseId(':'));
    expect(sanitiseId('weird id*x')).not.toBe(sanitiseId('weird_id_x'));
  });

  it('is deterministic and stable across calls', async () => {
    const { sanitiseId } = await import('./surrealDriver');
    for (const id of ADVERSARIAL_IDS) {
      expect(sanitiseId(id)).toBe(sanitiseId(id));
    }
    // Spot-check a couple of stable, hand-computed encodings.
    expect(sanitiseId('a:b')).toBe('a%3Ab');
    expect(sanitiseId('a::b')).toBe('a%3A%3Ab');
  });

  it('round-trips every adversarial id through decodeId', async () => {
    const { sanitiseId, decodeId } = await import('./surrealDriver');
    for (const id of ADVERSARIAL_IDS) {
      expect(decodeId(sanitiseId(id))).toBe(id);
    }
  });

  it('drives distinct record ids for colliding host ids end-to-end', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.reviewItems!.put(makeReviewItem('domain::topic::lo'));
    await surrealDriver.reviewItems!.put(makeReviewItem('domain:topic:lo'));

    const ids = surrealState.upsertCalls.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('review_items:domain%3A%3Atopic%3A%3Alo');
    expect(ids).toContain('review_items:domain%3Atopic%3Alo');
  });
});
