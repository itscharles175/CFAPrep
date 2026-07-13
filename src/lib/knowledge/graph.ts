/**
 * CONTENT-1 — prerequisite-aware knowledge graph with mastery propagation.
 *
 * A PURE, deterministic, fully-offline library (no IndexedDB, no LLM, no
 * network) that models the curriculum as a directed graph of CONCEPT NODES
 * (a CFA topic, or a finer-grained learning outcome / LOS) joined by typed
 * edges:
 *
 *   - `prerequisite`      A → B means "A must be understood before B" (B
 *                         depends on A). This is the spine the topo-order and
 *                         critical path run over.
 *   - `same-concept`      A ↔ B means "the same concept recurring across
 *                         levels" (e.g. fixed-income L1 → L2 → L3). Modelled as
 *                         a directed lower-level → higher-level edge, which is
 *                         ALSO a prerequisite for ordering/readiness purposes
 *                         (you learn the L1 treatment before the L2 one) but is
 *                         tagged distinctly so the UI + CONTENT-7 retrieval can
 *                         tell a true cross-topic dependency from the curriculum
 *                         spiral.
 *
 * What it computes:
 *   1. `topoOrder`        a stable topological order over the prerequisite DAG.
 *                         CYCLE-SAFE: any back-edges that would form a cycle are
 *                         reported in `cycles` and excluded from the ordering so
 *                         a bad authored edge can never hang the UI.
 *   2. `criticalPath`     the longest prerequisite chain (by summed node weight)
 *                         — the sequence of concepts that gates the most
 *                         downstream material, i.e. where a stuck learner blocks
 *                         the most future progress.
 *   3. `readiness`        a per-node readiness overlay in [0,1]. A node's
 *                         readiness blends its OWN mastery with the (propagated)
 *                         mastery of its prerequisites: you are not "ready" for B
 *                         until its prerequisites are solid, even if B itself has
 *                         never been studied. Propagation is multiplicative along
 *                         the DAG so a weak deep prerequisite drags the whole
 *                         downstream chain, matching how prereq gaps actually
 *                         compound.
 *
 * The derivation of the DEFAULT edge set from the host's existing level
 * summaries lives in {@link buildCurriculumGraph}; the analysis functions are
 * edge-source-agnostic so authored/mined prerequisite edges can be fed in later
 * without changing the math.
 */

export type ConceptEdgeRelation = 'prerequisite' | 'same-concept';

/** A concept node — a topic or a learning outcome. */
export interface ConceptNode {
  /** Stable unique id (e.g. `level1:fixed-income` or an LOS id). */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** Optional grouping: the bare topic id this node belongs to. */
  topicId?: string;
  /** Optional level tag (`level1` | `level2` | `level3` | …). */
  level?: string;
  /**
   * Relative importance / size weight (>= 0). Drives critical-path length and
   * is the propagation weight. Defaults to 1 when omitted.
   */
  weight?: number;
  /**
   * Observed mastery in [0,1] for this node, when known. `undefined` means
   * "never studied" and is treated as 0 for readiness while still being
   * distinguishable in the overlay (see {@link NodeReadiness.observed}).
   */
  mastery?: number;
}

/** A directed prerequisite/same-concept edge: `from` is required before `to`. */
export interface ConceptEdge {
  from: string;
  to: string;
  relation: ConceptEdgeRelation;
}

export interface KnowledgeGraphInput {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}

/** Per-node readiness overlay row. */
export interface NodeReadiness {
  id: string;
  /** The node's own mastery (0 when unobserved). */
  selfMastery: number;
  /** Whether mastery was actually observed (vs defaulted to 0). */
  observed: boolean;
  /**
   * Aggregate prerequisite readiness in [0,1]: the min-propagated readiness of
   * this node's prerequisites (1 when it has none — a root is always "unblocked").
   */
  prereqReadiness: number;
  /**
   * Final readiness in [0,1]: blends own mastery with prerequisite readiness.
   * A node can't exceed its prerequisites' readiness (you're gated by your
   * weakest upstream link), so this is `min(selfBlend, prereqReadiness)`.
   */
  readiness: number;
  /** The id of the weakest prerequisite dragging this node down, if any. */
  weakestPrerequisite?: string;
}

export interface CriticalPathResult {
  /** Ordered node ids forming the longest weighted prerequisite chain. */
  path: string[];
  /** Summed node weight along the path. */
  weight: number;
}

export interface KnowledgeGraphAnalysis {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  /** Map of node id → node, for callers. */
  nodesById: Map<string, ConceptNode>;
  /** Adjacency: prerequisite-of (from → [to, …]). Cycle edges removed. */
  forward: Map<string, string[]>;
  /** Reverse adjacency: depends-on (to → [from, …]). Cycle edges removed. */
  reverse: Map<string, string[]>;
  /** Stable topological order of node ids over the acyclic prerequisite DAG. */
  topoOrder: string[];
  /** Edges that were dropped because they would have formed a cycle. */
  cycles: ConceptEdge[];
  /** Longest weighted prerequisite chain. */
  criticalPath: CriticalPathResult;
  /** Per-node readiness overlay, keyed by node id. */
  readiness: Map<string, NodeReadiness>;
}

const DEFAULT_NODE_WEIGHT = 1;

function nodeWeight(node: ConceptNode | undefined): number {
  if (!node || typeof node.weight !== 'number' || !Number.isFinite(node.weight)) return DEFAULT_NODE_WEIGHT;
  return Math.max(0, node.weight);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Both relations act as prerequisites for ordering + readiness; `same-concept`
 * is just tagged distinctly so the UI/retrieval can distinguish the curriculum
 * spiral from cross-topic dependencies.
 */
function isPrerequisiteEdge(_edge: ConceptEdge): boolean {
  return true;
}

/**
 * Build cycle-safe forward/reverse adjacency from the edge list, dropping any
 * edge that would close a cycle (recorded in `cycles`). Edges referencing
 * unknown node ids are ignored so a partial/authored edge set can't crash.
 *
 * Determinism: nodes are processed in input order; for a given pair of nodes
 * the FIRST edge seen wins, and a later edge that would form a cycle with the
 * already-accepted edges is the one dropped. This keeps the DAG stable run to
 * run for the same input.
 */
function buildAcyclicAdjacency(
  nodeIds: Set<string>,
  edges: ConceptEdge[],
): {
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
  cycles: ConceptEdge[];
} {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const id of nodeIds) {
    forward.set(id, []);
    reverse.set(id, []);
  }
  const cycles: ConceptEdge[] = [];
  const seenPairs = new Set<string>();

  // Reachability check: does `to` already reach `from` (so adding from→to closes
  // a cycle)? BFS over current forward edges.
  const reaches = (start: string, target: string): boolean => {
    if (start === target) return true;
    const stack = [start];
    const visited = new Set<string>([start]);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of forward.get(cur) || []) {
        if (next === target) return true;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };

  for (const edge of edges) {
    if (!isPrerequisiteEdge(edge)) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (edge.from === edge.to) {
      cycles.push(edge);
      continue;
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenPairs.has(key)) continue;
    // Would from→to create a cycle? It does iff `to` can already reach `from`.
    if (reaches(edge.to, edge.from)) {
      cycles.push(edge);
      continue;
    }
    seenPairs.add(key);
    forward.get(edge.from)!.push(edge.to);
    reverse.get(edge.to)!.push(edge.from);
  }
  return { forward, reverse, cycles };
}

/**
 * Kahn topological sort over the acyclic prerequisite DAG. Stable: ties are
 * broken by the input node order (captured in `order`), so the same input
 * always yields the same sequence.
 */
function topologicalOrder(
  nodeIds: string[],
  forward: Map<string, string[]>,
  reverse: Map<string, string[]>,
): string[] {
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, (reverse.get(id) || []).length);
  const rank = new Map<string, number>();
  nodeIds.forEach((id, i) => rank.set(id, i));

  // Frontier kept sorted by input rank for stability.
  const frontier = nodeIds.filter((id) => (indegree.get(id) || 0) === 0);
  frontier.sort((a, b) => (rank.get(a)! - rank.get(b)!));
  const result: string[] = [];
  const remaining = new Map(indegree);

  while (frontier.length) {
    const id = frontier.shift()!;
    result.push(id);
    for (const next of forward.get(id) || []) {
      const deg = (remaining.get(next) || 0) - 1;
      remaining.set(next, deg);
      if (deg === 0) {
        // Insert keeping rank order.
        const r = rank.get(next)!;
        let lo = 0;
        let hi = frontier.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (rank.get(frontier[mid])! < r) lo = mid + 1;
          else hi = mid;
        }
        frontier.splice(lo, 0, next);
      }
    }
  }
  // Any nodes not emitted were part of a residual cycle the adjacency builder
  // couldn't strip (shouldn't happen given the acyclic build, but be safe):
  // append them in input order so callers always get a total order.
  if (result.length < nodeIds.length) {
    const emitted = new Set(result);
    for (const id of nodeIds) if (!emitted.has(id)) result.push(id);
  }
  return result;
}

/**
 * Longest weighted path over the prerequisite DAG. Processes nodes in topo
 * order so each node's best incoming chain is final before it's extended.
 * Ties break deterministically toward the lexicographically-smaller predecessor
 * so the path is reproducible.
 */
function longestWeightedPath(
  topoOrder: string[],
  reverse: Map<string, string[]>,
  nodesById: Map<string, ConceptNode>,
): CriticalPathResult {
  const best = new Map<string, { weight: number; prev?: string }>();
  let endId: string | undefined;
  let endWeight = -1;

  for (const id of topoOrder) {
    const w = nodeWeight(nodesById.get(id));
    let bestPrev: string | undefined;
    let bestPrevWeight = 0;
    for (const prereq of reverse.get(id) || []) {
      const prev = best.get(prereq);
      if (!prev) continue;
      if (
        prev.weight > bestPrevWeight ||
        (prev.weight === bestPrevWeight && (bestPrev === undefined || prereq < bestPrev))
      ) {
        bestPrevWeight = prev.weight;
        bestPrev = prereq;
      }
    }
    const total = bestPrevWeight + w;
    best.set(id, { weight: total, prev: bestPrev });
    if (total > endWeight || (total === endWeight && (endId === undefined || id < endId))) {
      endWeight = total;
      endId = id;
    }
  }

  const path: string[] = [];
  let cursor = endId;
  while (cursor !== undefined) {
    path.unshift(cursor);
    cursor = best.get(cursor)?.prev;
  }
  return { path, weight: Math.max(0, endWeight) };
}

/**
 * Compute the readiness overlay. Walks nodes in topo order so every
 * prerequisite's readiness is final before a downstream node consumes it.
 *
 * For a node N:
 *   selfMastery   = observed mastery (0 if unobserved)
 *   prereqReadiness = min over prerequisites of their propagated readiness
 *                     (1 when N has no prerequisites)
 *   selfBlend     = 0.5*selfMastery + 0.5*prereqReadiness   (own progress lifts
 *                   readiness, but can't fully compensate for weak upstream)
 *   readiness     = min(selfBlend, prereqReadiness)         (gated by the
 *                   weakest upstream link — you can't be more ready than your
 *                   foundations allow)
 */
function computeReadiness(
  topoOrder: string[],
  reverse: Map<string, string[]>,
  nodesById: Map<string, ConceptNode>,
): Map<string, NodeReadiness> {
  const readiness = new Map<string, NodeReadiness>();
  for (const id of topoOrder) {
    const node = nodesById.get(id);
    const observed = typeof node?.mastery === 'number' && Number.isFinite(node.mastery);
    const selfMastery = observed ? clamp01(node!.mastery as number) : 0;
    const prereqs = reverse.get(id) || [];
    let prereqReadiness = 1;
    let weakestPrerequisite: string | undefined;
    for (const prereq of prereqs) {
      const pr = readiness.get(prereq)?.readiness ?? 0;
      if (pr < prereqReadiness) {
        prereqReadiness = pr;
        weakestPrerequisite = prereq;
      }
    }
    const selfBlend = 0.5 * selfMastery + 0.5 * prereqReadiness;
    const finalReadiness = clamp01(Math.min(selfBlend, prereqReadiness));
    readiness.set(id, {
      id,
      selfMastery,
      observed,
      prereqReadiness: clamp01(prereqReadiness),
      readiness: finalReadiness,
      ...(weakestPrerequisite ? { weakestPrerequisite } : {}),
    });
  }
  return readiness;
}

/**
 * Analyse a prerequisite graph: topo-order, critical path, readiness overlay.
 * Pure + deterministic. Tolerates dangling edges + cycles (the latter reported,
 * not thrown).
 */
export function analyzeKnowledgeGraph(input: KnowledgeGraphInput): KnowledgeGraphAnalysis {
  const nodes = input.nodes || [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const { forward, reverse, cycles } = buildAcyclicAdjacency(nodeIdSet, input.edges || []);
  const topoOrder = topologicalOrder(nodeIds, forward, reverse);
  const criticalPath = longestWeightedPath(topoOrder, reverse, nodesById);
  const readiness = computeReadiness(topoOrder, reverse, nodesById);
  return {
    nodes,
    edges: input.edges || [],
    nodesById,
    forward,
    reverse,
    topoOrder,
    cycles,
    criticalPath,
    readiness,
  };
}

// --------------------------------------------------------------------------
// Neighborhood queries (used by CONTENT-7 concept-grounded RAG)
// --------------------------------------------------------------------------

export interface NeighborhoodEntry {
  id: string;
  relation: 'self' | 'prerequisite' | 'dependent' | 'same-concept';
  /** Hops from the seed (0 = the seed itself). */
  distance: number;
}

/**
 * Return the prerequisite + same-concept NEIGHBORHOOD of a seed node: the seed,
 * its prerequisites (upstream, the foundations it builds on), its dependents
 * (downstream, what builds on it), and same-concept siblings across levels.
 * Used by CONTENT-7 to widen retrieval to conceptually-adjacent material.
 *
 * `relation` reflects HOW each neighbor relates to the seed via the FIRST hop:
 * an upstream node is a `prerequisite`, a downstream node a `dependent`, and a
 * node reached by a same-concept edge is `same-concept`. BFS, so `distance` is
 * the shortest hop count; the seed is `{ relation: 'self', distance: 0 }`.
 */
export function conceptNeighborhood(
  analysis: Pick<KnowledgeGraphAnalysis, 'forward' | 'reverse' | 'edges' | 'nodesById'>,
  seedId: string,
  maxHops = 1,
): NeighborhoodEntry[] {
  if (!analysis.nodesById.has(seedId)) return [];
  // Same-concept edges as a separate undirected adjacency so siblings across
  // levels are reachable in either direction.
  const sameConcept = new Map<string, Set<string>>();
  for (const edge of analysis.edges) {
    if (edge.relation !== 'same-concept') continue;
    if (!sameConcept.has(edge.from)) sameConcept.set(edge.from, new Set());
    if (!sameConcept.has(edge.to)) sameConcept.set(edge.to, new Set());
    sameConcept.get(edge.from)!.add(edge.to);
    sameConcept.get(edge.to)!.add(edge.from);
  }

  const result = new Map<string, NeighborhoodEntry>();
  result.set(seedId, { id: seedId, relation: 'self', distance: 0 });
  let frontier: Array<{ id: string; relation: NeighborhoodEntry['relation'] }> = [
    { id: seedId, relation: 'self' },
  ];
  for (let hop = 1; hop <= Math.max(1, maxHops); hop += 1) {
    const next: Array<{ id: string; relation: NeighborhoodEntry['relation'] }> = [];
    for (const cur of frontier) {
      // Upstream prerequisites.
      for (const up of analysis.reverse.get(cur.id) || []) {
        const relation = cur.relation === 'self' ? 'prerequisite' : cur.relation;
        if (!result.has(up)) {
          result.set(up, { id: up, relation, distance: hop });
          next.push({ id: up, relation });
        }
      }
      // Downstream dependents.
      for (const down of analysis.forward.get(cur.id) || []) {
        const relation = cur.relation === 'self' ? 'dependent' : cur.relation;
        if (!result.has(down)) {
          result.set(down, { id: down, relation, distance: hop });
          next.push({ id: down, relation });
        }
      }
      // Same-concept siblings.
      for (const sib of sameConcept.get(cur.id) || []) {
        const relation: NeighborhoodEntry['relation'] = 'same-concept';
        if (!result.has(sib)) {
          result.set(sib, { id: sib, relation, distance: hop });
          next.push({ id: sib, relation });
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...result.values()].sort(
    (a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// --------------------------------------------------------------------------
// Default curriculum-graph derivation (host level summaries → graph)
// --------------------------------------------------------------------------

/** The minimal shape this builder reads from a host level summary. */
export interface CurriculumLevelLike {
  id: string;
  topics: Array<{
    id: string;
    label?: string;
    title?: string;
    weight?: string | number;
  }>;
}

/** Per-topic mastery lookup (0..100 percentages, as the host stores them). */
export type MasteryByTopic = Record<string, number | null | undefined>;

export interface BuildCurriculumGraphOptions {
  /** Ordered level summaries (L1, L2, L3). */
  levels: CurriculumLevelLike[];
  /**
   * Per-topic mastery as PERCENTAGES (0..100), keyed by bare topic id — exactly
   * the shape `KnowledgeGraph.jsx` already computes from masterySnapshots.
   * Converted to 0..1 on the node.
   */
  masteryByTopic?: MasteryByTopic;
  /**
   * Additional authored / mined prerequisite edges to union in (CONTENT-2 can
   * feed coverage-derived edges here later). Node ids must match `${levelId}:${topicId}`.
   */
  extraEdges?: ConceptEdge[];
}

function topicLabel(topic: CurriculumLevelLike['topics'][number]): string {
  return topic.label || topic.title || topic.id;
}

function topicWeight(topic: CurriculumLevelLike['topics'][number]): number {
  if (typeof topic.weight === 'number') return Math.max(0, topic.weight);
  if (typeof topic.weight === 'string') {
    // Weights are stored like "10%" or "8–12%"; take the first number.
    const m = topic.weight.match(/(\d+(?:\.\d+)?)/);
    if (m) return Math.max(0, parseFloat(m[1]));
  }
  return DEFAULT_NODE_WEIGHT;
}

/**
 * Derive the DEFAULT curriculum knowledge graph from the host's level
 * summaries. Each `${levelId}:${topicId}` is a node; the curriculum spiral
 * (same topic id recurring in the next level) becomes a directed lower→higher
 * `same-concept` edge — which doubles as a prerequisite for ordering/readiness.
 *
 * This is the zero-config edge set the page surfaces today; authored/mined
 * `prerequisite` edges can be layered on via {@link BuildCurriculumGraphOptions.extraEdges}.
 */
export function buildCurriculumGraph(options: BuildCurriculumGraphOptions): KnowledgeGraphInput {
  const { levels, masteryByTopic, extraEdges } = options;
  const nodes: ConceptNode[] = [];
  for (const level of levels) {
    for (const topic of level.topics) {
      const pct = masteryByTopic?.[topic.id];
      const mastery =
        typeof pct === 'number' && Number.isFinite(pct) ? clamp01(pct / 100) : undefined;
      nodes.push({
        id: `${level.id}:${topic.id}`,
        label: topicLabel(topic),
        topicId: topic.id,
        level: level.id,
        weight: topicWeight(topic),
        ...(mastery !== undefined ? { mastery } : {}),
      });
    }
  }

  const edges: ConceptEdge[] = [];
  for (let i = 0; i < levels.length - 1; i += 1) {
    const lower = levels[i];
    const upper = levels[i + 1];
    const upperTopics = new Set(upper.topics.map((t) => t.id));
    for (const topic of lower.topics) {
      if (upperTopics.has(topic.id)) {
        edges.push({
          from: `${lower.id}:${topic.id}`,
          to: `${upper.id}:${topic.id}`,
          relation: 'same-concept',
        });
      }
    }
  }
  if (extraEdges?.length) {
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const edge of extraEdges) {
      if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) edges.push(edge);
    }
  }

  return { nodes, edges };
}
