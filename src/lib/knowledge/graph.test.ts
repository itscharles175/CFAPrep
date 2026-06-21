import { describe, expect, it } from 'vitest';

import {
  analyzeKnowledgeGraph,
  buildCurriculumGraph,
  conceptNeighborhood,
  type ConceptEdge,
  type ConceptNode,
  type CurriculumLevelLike,
} from './graph';

const node = (id: string, extra: Partial<ConceptNode> = {}): ConceptNode => ({ id, label: id, ...extra });

describe('CONTENT-1 — analyzeKnowledgeGraph', () => {
  it('topo-orders prerequisites before dependents', () => {
    const a = analyzeKnowledgeGraph({
      nodes: [node('c'), node('a'), node('b')],
      edges: [
        { from: 'a', to: 'b', relation: 'prerequisite' },
        { from: 'b', to: 'c', relation: 'prerequisite' },
      ],
    });
    expect(a.topoOrder.indexOf('a')).toBeLessThan(a.topoOrder.indexOf('b'));
    expect(a.topoOrder.indexOf('b')).toBeLessThan(a.topoOrder.indexOf('c'));
    expect(a.cycles).toHaveLength(0);
  });

  it('is cycle-safe: a back-edge is reported and excluded, ordering still total', () => {
    const a = analyzeKnowledgeGraph({
      nodes: [node('a'), node('b')],
      edges: [
        { from: 'a', to: 'b', relation: 'prerequisite' },
        { from: 'b', to: 'a', relation: 'prerequisite' }, // would form a cycle
      ],
    });
    expect(a.cycles).toHaveLength(1);
    expect(a.topoOrder).toHaveLength(2);
    // a→b kept, so a precedes b.
    expect(a.topoOrder).toEqual(['a', 'b']);
  });

  it('ignores edges referencing unknown nodes', () => {
    const a = analyzeKnowledgeGraph({
      nodes: [node('a')],
      edges: [{ from: 'a', to: 'ghost', relation: 'prerequisite' }],
    });
    expect(a.topoOrder).toEqual(['a']);
    expect(a.forward.get('a')).toEqual([]);
  });

  it('critical path is the longest weighted prerequisite chain', () => {
    // a(1)->b(1)->c(1) is length 3; d(5) alone is heavier per-node but shorter.
    const a = analyzeKnowledgeGraph({
      nodes: [node('a', { weight: 1 }), node('b', { weight: 1 }), node('c', { weight: 1 }), node('d', { weight: 2 })],
      edges: [
        { from: 'a', to: 'b', relation: 'prerequisite' },
        { from: 'b', to: 'c', relation: 'prerequisite' },
      ],
    });
    expect(a.criticalPath.path).toEqual(['a', 'b', 'c']);
    expect(a.criticalPath.weight).toBe(3);
  });

  it('readiness propagates: a weak prerequisite drags the downstream node', () => {
    const a = analyzeKnowledgeGraph({
      nodes: [
        node('root', { mastery: 0.2 }),
        node('leaf', { mastery: 1 }),
      ],
      edges: [{ from: 'root', to: 'leaf', relation: 'prerequisite' }],
    });
    const root = a.readiness.get('root')!;
    const leaf = a.readiness.get('leaf')!;
    // root has no prerequisites → prereqReadiness 1; readiness = min(0.5*0.2+0.5*1, 1)=0.6
    expect(root.prereqReadiness).toBe(1);
    expect(root.readiness).toBeCloseTo(0.6, 5);
    // leaf is gated by root.readiness (0.6) despite its own mastery of 1.
    expect(leaf.prereqReadiness).toBeCloseTo(0.6, 5);
    expect(leaf.readiness).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(leaf.weakestPrerequisite).toBe('root');
  });

  it('treats unobserved mastery as 0 but flags observed=false', () => {
    const a = analyzeKnowledgeGraph({ nodes: [node('x')], edges: [] });
    const r = a.readiness.get('x')!;
    expect(r.observed).toBe(false);
    expect(r.selfMastery).toBe(0);
  });
});

describe('CONTENT-1 — conceptNeighborhood (CONTENT-7 seam)', () => {
  const edges: ConceptEdge[] = [
    { from: 'l1:fi', to: 'l2:fi', relation: 'same-concept' },
    { from: 'l2:fi', to: 'l3:fi', relation: 'same-concept' },
    { from: 'l2:quant', to: 'l2:fi', relation: 'prerequisite' },
  ];
  const analysis = analyzeKnowledgeGraph({
    nodes: [node('l1:fi'), node('l2:fi'), node('l3:fi'), node('l2:quant')],
    edges,
  });

  it('tags prerequisites, dependents, and same-concept siblings of the seed', () => {
    const hood = conceptNeighborhood(analysis, 'l2:fi', 1);
    const byId = new Map(hood.map((h) => [h.id, h]));
    expect(byId.get('l2:fi')?.relation).toBe('self');
    // l1:fi is upstream prerequisite (same-concept edge l1→l2) → reachable via reverse
    expect(byId.has('l1:fi')).toBe(true);
    // l2:quant is a prerequisite of l2:fi
    expect(byId.get('l2:quant')?.relation).toBe('prerequisite');
    // l3:fi is downstream dependent
    expect(byId.get('l3:fi')?.relation).toBe('dependent');
  });

  it('returns [] for an unknown seed', () => {
    expect(conceptNeighborhood(analysis, 'nope', 1)).toEqual([]);
  });
});

describe('CONTENT-1 — buildCurriculumGraph', () => {
  const levels: CurriculumLevelLike[] = [
    { id: 'level1', topics: [{ id: 'fi', label: 'Fixed Income', weight: '10%' }, { id: 'econ', label: 'Economics' }] },
    { id: 'level2', topics: [{ id: 'fi', label: 'Fixed Income', weight: '12%' }] },
    { id: 'level3', topics: [{ id: 'fi', label: 'Fixed Income' }] },
  ];

  it('builds nodes per level:topic and same-concept spiral edges', () => {
    const g = buildCurriculumGraph({ levels });
    expect(g.nodes.map((n) => n.id)).toEqual(['level1:fi', 'level1:econ', 'level2:fi', 'level3:fi']);
    // Spiral edges l1:fi→l2:fi→l3:fi only (econ doesn't recur).
    expect(g.edges).toEqual([
      { from: 'level1:fi', to: 'level2:fi', relation: 'same-concept' },
      { from: 'level2:fi', to: 'level3:fi', relation: 'same-concept' },
    ]);
  });

  it('maps percentage mastery (0..100) onto node mastery (0..1)', () => {
    const g = buildCurriculumGraph({ levels, masteryByTopic: { fi: 80 } });
    const fi = g.nodes.find((n) => n.id === 'level1:fi')!;
    expect(fi.mastery).toBeCloseTo(0.8, 5);
    // weight parsed from "10%"
    expect(fi.weight).toBe(10);
  });

  it('unions valid extra prerequisite edges and drops dangling ones', () => {
    const g = buildCurriculumGraph({
      levels,
      extraEdges: [
        { from: 'level1:econ', to: 'level1:fi', relation: 'prerequisite' },
        { from: 'level1:fi', to: 'ghost', relation: 'prerequisite' },
      ],
    });
    expect(g.edges).toContainEqual({ from: 'level1:econ', to: 'level1:fi', relation: 'prerequisite' });
    expect(g.edges.some((e) => e.to === 'ghost')).toBe(false);
  });

  it('end-to-end: derived graph analyses without cycles', () => {
    const g = buildCurriculumGraph({ levels, masteryByTopic: { fi: 50 } });
    const a = analyzeKnowledgeGraph(g);
    expect(a.cycles).toHaveLength(0);
    expect(a.criticalPath.path[0]).toBe('level1:fi');
  });
});
