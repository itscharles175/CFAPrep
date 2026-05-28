import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Network } from 'lucide-react';
import { PageHeader, SegmentedControl, StatusBadge, Surface } from '../components/ui/Primitives';
import { getCfaLevelSummaries } from '../domains/cfa/cfaSummary';
import { getCfaSourceCoverageMap } from '../lib/cfaSourceVault';
import { db } from '../lib/progressStore';

// Interactive curriculum knowledge-graph canvas.
//
// Lays out every CFA topic across the three levels as nodes in three vertical
// columns (L1 / L2 / L3). Cross-level edges connect topics that share an id
// across consecutive levels (e.g., fixed-income L1 → fixed-income L2 →
// fixed-income L3), so the user can see how the curriculum spirals through
// each subject as they advance. Node size scales with question count; node
// color reflects whether the user has ingested curriculum for that topic.
// Click a node to navigate; hover (or focus) to see its details inline.
//
// Pillar 9. SVG-based, no external graph deps; works fully offline.

const LEVEL_COLUMNS = ['level1', 'level2', 'level3'];
const LEVEL_LABELS = { level1: 'Level I', level2: 'Level II', level3: 'Level III' };
const COLUMN_X = { level1: 220, level2: 580, level3: 940 };
const COLUMN_HEADER_Y = 56;
const ROW_HEIGHT = 80;
const FIRST_ROW_Y = 130;
const NODE_RADIUS_BASE = 16;
const NODE_RADIUS_MAX = 36;

function radiusFor(questionCount, maxCount) {
  if (!questionCount || !maxCount) return NODE_RADIUS_BASE;
  const t = Math.min(1, questionCount / maxCount);
  return NODE_RADIUS_BASE + (NODE_RADIUS_MAX - NODE_RADIUS_BASE) * t;
}

function nodeColor(hasCurriculum) {
  return hasCurriculum ? 'var(--accent, #60a5fa)' : 'var(--text-muted, #94a3b8)';
}

// Interpolate red→yellow→green for a mastery score 0..100.
function masteryColor(score) {
  if (score == null) return 'var(--text-muted, #94a3b8)';
  const clamped = Math.max(0, Math.min(100, score));
  // 0 = #ef4444 (danger), 50 = #f59e0b (warning), 100 = #34d399 (success)
  if (clamped < 50) {
    const t = clamped / 50;
    return blendHex('#ef4444', '#f59e0b', t);
  }
  const t = (clamped - 50) / 50;
  return blendHex('#f59e0b', '#34d399', t);
}

function blendHex(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex) {
  const m = hex.replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

export default function KnowledgeGraph() {
  const levels = useMemo(() => getCfaLevelSummaries(), []);
  const [coverageMap, setCoverageMap] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const [colorMode, setColorMode] = useState('coverage'); // 'coverage' | 'mastery'
  const [masteryByTopic, setMasteryByTopic] = useState(null);

  useEffect(() => {
    let active = true;
    getCfaSourceCoverageMap()
      .then((map) => {
        if (active) setCoverageMap(map);
      })
      .catch(() => undefined);

    // Per-topic mastery: aggregate masterySnapshots by `topic` (which is
    // either bare 'fixed-income' for level1 or 'level2:fixed-income' for
    // level2+; we key by the bare id at the end).
    db.masterySnapshots
      .toArray()
      .then((snaps) => {
        if (!active) return;
        const bucket = new Map();
        for (const snap of snaps) {
          if (!snap?.topic) continue;
          const bare = snap.topic.includes(':') ? snap.topic.split(':').at(-1) : snap.topic;
          const row = bucket.get(bare) || { sum: 0, count: 0 };
          row.sum += snap.score;
          row.count += 1;
          bucket.set(bare, row);
        }
        const result = {};
        for (const [topicId, { sum, count }] of bucket) result[topicId] = Math.round(sum / count);
        setMasteryByTopic(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Build per-level positioned nodes.
  const nodesByLevel = useMemo(() => {
    const out = {};
    for (const level of levels) {
      const topics = level.topics;
      const maxQs = Math.max(1, ...topics.map((t) => t.questions));
      const x = COLUMN_X[level.id] ?? 0;
      out[level.id] = topics.map((topic, index) => ({
        id: `${level.id}:${topic.id}`,
        topicId: topic.id,
        levelId: level.id,
        title: topic.label,
        questions: topic.questions,
        vignettes: topic.vignettes,
        weight: topic.weight,
        flashcards: topic.flashcards,
        hasCurriculum: Boolean(coverageMap?.topicCounts?.[topic.id]),
        mastery: masteryByTopic?.[topic.id] ?? null,
        x,
        y: FIRST_ROW_Y + index * ROW_HEIGHT,
        radius: radiusFor(topic.questions, maxQs),
      }));
    }
    return out;
  }, [levels, coverageMap, masteryByTopic]);

  const allNodes = useMemo(
    () => LEVEL_COLUMNS.flatMap((id) => nodesByLevel[id] || []),
    [nodesByLevel],
  );
  const nodesById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // Cross-level edges: same topicId in consecutive levels.
  const edges = useMemo(() => {
    const out = [];
    for (let i = 0; i < LEVEL_COLUMNS.length - 1; i += 1) {
      const a = LEVEL_COLUMNS[i];
      const b = LEVEL_COLUMNS[i + 1];
      const aById = new Map((nodesByLevel[a] || []).map((n) => [n.topicId, n]));
      const bById = new Map((nodesByLevel[b] || []).map((n) => [n.topicId, n]));
      for (const [topicId, fromNode] of aById) {
        const toNode = bById.get(topicId);
        if (toNode) out.push({ id: `${fromNode.id}->${toNode.id}`, from: fromNode, to: toNode, topicId });
      }
    }
    return out;
  }, [nodesByLevel]);

  const maxRows = Math.max(...LEVEL_COLUMNS.map((id) => (nodesByLevel[id] || []).length));
  const height = FIRST_ROW_Y + maxRows * ROW_HEIGHT + 40;
  const width = 1160;

  const selected = hoverId ? nodesById.get(hoverId) : null;

  return (
    <div className="page-container">
      <PageHeader
        tone="analytics"
        badge="KNOWLEDGE GRAPH"
        title="Curriculum Knowledge Graph"
        subtitle="Every CFA topic across Levels I, II, and III. Edges link topics that recur across levels; size reflects authored question volume; color reflects the selected overlay."
        meta={
          <>
            <StatusBadge tone="analytics">
              <Network size={14} /> {allNodes.length} topics
            </StatusBadge>
            <StatusBadge tone="exam">{edges.length} cross-level links</StatusBadge>
            {coverageMap && (
              <StatusBadge tone="accent">
                {allNodes.filter((n) => n.hasCurriculum).length} with curriculum
              </StatusBadge>
            )}
          </>
        }
        actions={
          <SegmentedControl
            label="Color overlay"
            density="compact"
            options={[
              { value: 'coverage', label: 'Curriculum' },
              { value: 'mastery', label: 'Mastery' },
            ]}
            value={colorMode}
            onChange={setColorMode}
          />
        }
      />

      <Surface tone="analytics" status="accent" style={{ marginBottom: 'var(--space-6)' }}>
        <div style={{ overflowX: 'auto' }}>
          <svg
            role="img"
            aria-label="CFA curriculum knowledge graph"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ display: 'block', maxWidth: '100%' }}
          >
            {/* Column headers */}
            {LEVEL_COLUMNS.map((id) => (
              <g key={id}>
                <text
                  x={COLUMN_X[id]}
                  y={COLUMN_HEADER_Y}
                  textAnchor="middle"
                  fontSize="18"
                  fontWeight="700"
                  fill="var(--text-secondary, #cbd5e1)"
                >
                  {LEVEL_LABELS[id]}
                </text>
              </g>
            ))}

            {/* Edges */}
            {edges.map((edge) => {
              const isActive = hoverId === edge.from.id || hoverId === edge.to.id;
              return (
                <line
                  key={edge.id}
                  x1={edge.from.x + edge.from.radius}
                  y1={edge.from.y}
                  x2={edge.to.x - edge.to.radius}
                  y2={edge.to.y}
                  stroke={isActive ? 'var(--accent, #60a5fa)' : 'var(--border, #334155)'}
                  strokeWidth={isActive ? 2 : 1}
                  strokeDasharray={isActive ? '0' : '4 4'}
                  opacity={isActive ? 0.95 : 0.45}
                />
              );
            })}

            {/* Nodes */}
            {allNodes.map((node) => {
              const isActive = hoverId === node.id;
              return (
                <Link key={node.id} to={`/cfa/${node.levelId}/${node.topicId}`} role="link" aria-label={`Open ${node.title}`}>
                  <g
                    onMouseEnter={() => setHoverId(node.id)}
                    onMouseLeave={() => setHoverId((id) => (id === node.id ? null : id))}
                    onFocus={() => setHoverId(node.id)}
                    onBlur={() => setHoverId((id) => (id === node.id ? null : id))}
                    style={{ cursor: 'pointer' }}
                    tabIndex={0}
                  >
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.radius}
                      fill={colorMode === 'mastery' ? masteryColor(node.mastery) : nodeColor(node.hasCurriculum)}
                      stroke={isActive ? 'var(--text-primary, #f8fafc)' : 'transparent'}
                      strokeWidth={2}
                      opacity={isActive ? 1 : 0.85}
                    />
                    <text
                      x={node.x + node.radius + 8}
                      y={node.y + 4}
                      fontSize="12"
                      fontWeight={isActive ? 700 : 500}
                      fill="var(--text-primary, #f1f5f9)"
                    >
                      {node.title}
                    </text>
                    <text
                      x={node.x + node.radius + 8}
                      y={node.y + 18}
                      fontSize="10"
                      fill="var(--text-muted, #94a3b8)"
                    >
                      {node.weight} · {node.questions}Q · {node.vignettes} cases
                    </text>
                  </g>
                </Link>
              );
            })}
          </svg>
        </div>
      </Surface>

      <div className="grid-2" style={{ gap: 'var(--space-4)' }}>
        <Surface tone="analytics" density="compact">
          <StatusBadge tone="accent">Legend</StatusBadge>
          {colorMode === 'coverage' ? (
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--accent)' }} />
                <span>Topic has ingested curriculum (Ask the curriculum will return grounded answers)</span>
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--text-muted)', opacity: 0.65 }} />
                <span>No curriculum yet — only authored questions available; ingest from System Health</span>
              </li>
            </ul>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: masteryColor(0) }} />
                <span>0–25% mastery — schedule focused review</span>
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: masteryColor(50) }} />
                <span>~50% — exam-edge; keep drilling</span>
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: masteryColor(85) }} />
                <span>85%+ — exam-ready; maintain with spaced reviews</span>
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--text-muted)', opacity: 0.65 }} />
                <span>No mastery snapshots yet — answer a few quiz questions</span>
              </li>
            </ul>
          )}
          <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <svg width="40" height="14" viewBox="0 0 40 14"><line x1="0" y1="7" x2="40" y2="7" stroke="var(--border)" strokeDasharray="4 4" /></svg>
              <span>Dashed edge: same topic across consecutive levels (the curriculum spiral)</span>
            </li>
            <li style={{ color: 'var(--text-muted)' }}>
              Node radius scales with authored question count. Click any node to open the topic; hover/focus to highlight its cross-level chain.
            </li>
          </ul>
        </Surface>
        <Surface tone="analytics" density="compact">
          <StatusBadge tone="accent">Selected topic</StatusBadge>
          {selected ? (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <h3 style={{ margin: 0 }}>{selected.title}</h3>
              <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                {LEVEL_LABELS[selected.levelId]} · weight {selected.weight} · {selected.questions} questions ·{' '}
                {selected.vignettes} vignettes · {selected.flashcards} flashcards
              </p>
              <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                Curriculum: {selected.hasCurriculum ? 'ingested' : 'not yet ingested'}
                {' · Mastery: '}
                {selected.mastery == null ? 'no snapshots' : `${selected.mastery}%`}
              </p>
              <Link
                to={`/cfa/${selected.levelId}/${selected.topicId}`}
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 'var(--space-2)' }}
              >
                Open {selected.title}
              </Link>
            </div>
          ) : (
            <p className="muted-copy" style={{ margin: 'var(--space-2) 0 0' }}>
              Hover or focus a node to see its details.
            </p>
          )}
        </Surface>
      </div>
    </div>
  );
}
