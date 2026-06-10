import { useState, useRef, useEffect } from 'react';
import {
  Surface,
  StatusBadge,
  PageHeader,
  MetricTile,
  Panel,
  Dialog,
  SegmentedControl,
  InlineCluster,
  ProgressRail,
  EmptyPanel,
  QuestionStage,
  RubricPanel,
} from '../components/ui/Primitives';

/* ── helpers ─────────────────────────────────────────────── */

const compactGrid = (minWidth = 160) => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))`,
});


function TokenLabel({ name }) {
  return (
    <code className="qv-fs-xs qv-text-muted qv-mono">
      {name}
    </code>
  );
}

function SectionTitle({ children }) {
  return (
    <h2
      style={{
        fontSize: 'var(--fs-2xl)',
        fontWeight: 'var(--fw-bold)',
        margin: '0 0 var(--space-2)',
        paddingBottom: 'var(--space-3)',
        borderBottom: '1px solid var(--color-border)',
        color: 'var(--color-text-primary)',
      }}
    >
      {children}
    </h2>
  );
}

function SectionDesc({ children }) {
  return (
    <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', margin: '0 0 var(--space-6)' }}>
      {children}
    </p>
  );
}

function GallerySection({ id, children }) {
  return (
    <section
      id={id}
      style={{ marginBottom: 'var(--space-16)', scrollMarginTop: 'calc(var(--topbar-height, 64px) + var(--space-4))' }}
    >
      {children}
    </section>
  );
}

/* ── 1. Colors ───────────────────────────────────────────── */

const COLOR_GROUPS = [
  {
    label: 'Background',
    tokens: ['--color-bg-canvas', '--color-bg-surface', '--color-bg-surface-2'],
  },
  {
    label: 'Text',
    tokens: ['--color-text-primary', '--color-text-secondary', '--color-text-muted'],
  },
  {
    label: 'Border',
    tokens: ['--color-border', '--color-border-strong'],
  },
  {
    label: 'Accent',
    tokens: ['--color-accent', '--color-accent-soft'],
  },
  {
    label: 'Status',
    tokens: ['--color-success', '--color-warning', '--color-danger', '--color-exam'],
  },
  {
    label: 'Domains',
    tokens: [
      '--color-domain-cfa',
      '--color-domain-quant',
      '--color-domain-excel',
      '--color-domain-vault',
      '--color-domain-analytics',
      '--color-domain-ops',
    ],
  },
];

function ColorSwatch({ token }) {
  const [hex, setHex] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) {
      const v = getComputedStyle(ref.current).backgroundColor;
      setHex(v || '');
    }
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
      <div
        ref={ref}
        style={{
          width: '100%',
          height: 56,
          borderRadius: 'var(--radius-md)',
          background: `var(${token})`,
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--elevation-1)',
        }}
      />
      <TokenLabel name={token} />
      {hex && (
        <span className="qv-fs-xs qv-text-muted">{hex}</span>
      )}
    </div>
  );
}

function ColorsSection() {
  return (
    <GallerySection id="colors">
      <SectionTitle>Colors</SectionTitle>
      <SectionDesc>Semantic token layer. Values resolve through the existing src/index.css core palette.</SectionDesc>
      {COLOR_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 'var(--space-8)' }}>
          <p
            style={{
              fontSize: 'var(--fs-xs)',
              fontWeight: 'var(--fw-black)',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
              marginBottom: 'var(--space-3)',
            }}
          >
            {group.label}
          </p>
          <div
            style={{
              ...compactGrid(120),
              gap: 'var(--space-4)',
            }}
          >
            {group.tokens.map((t) => (
              <ColorSwatch key={t} token={t} />
            ))}
          </div>
        </div>
      ))}
    </GallerySection>
  );
}

/* ── 2. Typography ───────────────────────────────────────── */

const FONT_SIZES = [
  { token: '--fs-xs', label: 'xs' },
  { token: '--fs-sm', label: 'sm' },
  { token: '--fs-base', label: 'base' },
  { token: '--fs-md', label: 'md' },
  { token: '--fs-lg', label: 'lg' },
  { token: '--fs-xl', label: 'xl' },
  { token: '--fs-2xl', label: '2xl' },
  { token: '--fs-3xl', label: '3xl' },
  { token: '--fs-4xl', label: '4xl' },
];

const FONT_WEIGHTS = [
  { token: '--fw-regular', label: 'Regular', value: 400 },
  { token: '--fw-medium', label: 'Medium', value: 500 },
  { token: '--fw-semibold', label: 'Semibold', value: 600 },
  { token: '--fw-bold', label: 'Bold', value: 700 },
  { token: '--fw-black', label: 'Black', value: 800 },
];

function TypographySection() {
  return (
    <GallerySection id="typography">
      <SectionTitle>Typography</SectionTitle>
      <SectionDesc>Font-size ramp (rem) and weight scale. Font stacks are offline-safe system fonts.</SectionDesc>

      <p style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-black)', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
        Size ramp
      </p>
      <div style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-10)' }}>
        {FONT_SIZES.map(({ token, label }) => (
          <div
            key={token}
            style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-2)' }}
          >
            <TokenLabel name={token} />
            <span style={{ fontSize: `var(${token})`, color: 'var(--color-text-primary)', lineHeight: 1.3 }}>
              {label} — The quick brown fox jumps over the lazy dog
            </span>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-black)', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
        Weight ramp
      </p>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {FONT_WEIGHTS.map(({ token, label, value }) => (
          <div
            key={token}
            style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-2)' }}
          >
            <TokenLabel name={token} />
            <span style={{ fontWeight: value, fontSize: 'var(--fs-lg)', color: 'var(--color-text-primary)' }}>
              {label} ({value}) — QuantVault
            </span>
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

/* ── 3. Spacing ──────────────────────────────────────────── */

const SPACE_TOKENS = [
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--space-10',
  '--space-12',
  '--space-16',
];

function SpacingSection() {
  return (
    <GallerySection id="spacing">
      <SectionTitle>Spacing</SectionTitle>
      <SectionDesc>8-step modular scale based on 4 px. Each box is sized at the token value.</SectionDesc>
      <div className="qv-stack-3">
        {SPACE_TOKENS.map((token) => (
          <div key={token} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
            <div style={{ width: 140 }}>
              <TokenLabel name={token} />
            </div>
            <div
              style={{
                height: `var(${token})`,
                width: `var(${token})`,
                minWidth: 4,
                minHeight: 4,
                background: 'var(--color-accent)',
                borderRadius: 2,
              }}
            />
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

/* ── 4. Radius ───────────────────────────────────────────── */

const RADIUS_TOKENS = [
  { token: '--radius-xs', label: 'xs — 4px' },
  { token: '--radius-sm', label: 'sm — 6px' },
  { token: '--radius-md', label: 'md — 8px' },
  { token: '--radius-lg', label: 'lg — 12px' },
  { token: '--radius-xl', label: 'xl — 16px' },
  { token: '--radius-full', label: 'full — 9999px' },
];

function RadiusSection() {
  return (
    <GallerySection id="radius">
      <SectionTitle>Radius</SectionTitle>
      <SectionDesc>Border-radius scale. The full token creates pill shapes.</SectionDesc>
      <div
        style={{
          ...compactGrid(140),
          gap: 'var(--space-6)',
        }}
      >
        {RADIUS_TOKENS.map(({ token, label }) => (
          <div key={token} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
            <div
              style={{
                width: 80,
                height: 80,
                background: 'var(--color-accent-soft)',
                border: '1.5px solid var(--color-accent)',
                borderRadius: `var(${token})`,
              }}
            />
            <TokenLabel name={token} />
            <span className="qv-fs-xs qv-text-muted">{label}</span>
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

/* ── 5. Elevation ────────────────────────────────────────── */

const ELEVATION_TOKENS = [
  { token: '--elevation-0', label: '0 — flat' },
  { token: '--elevation-1', label: '1 — subtle' },
  { token: '--elevation-2', label: '2 — raised' },
  { token: '--elevation-3', label: '3 — elevated' },
  { token: '--elevation-floating', label: 'floating — modal / toast' },
];

function ElevationSection() {
  return (
    <GallerySection id="elevation">
      <SectionTitle>Elevation</SectionTitle>
      <SectionDesc>Box-shadow depth scale. Cards are shown against a recessed background to make shadows visible.</SectionDesc>
      <div
        style={{
          ...compactGrid(150),
          gap: 'var(--space-6)',
          padding: 'clamp(var(--space-4), 5vw, var(--space-8))',
          background: 'rgba(0,0,0,0.18)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        {ELEVATION_TOKENS.map(({ token, label }) => (
          <div
            key={token}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                width: '100%',
                height: 80,
                background: 'var(--color-bg-surface)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                boxShadow: `var(${token})`,
              }}
            />
            <TokenLabel name={token} />
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', textAlign: 'center' }}>{label}</span>
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

/* ── 6. Motion ───────────────────────────────────────────── */

const MOTION_DURATIONS = [
  { token: '--duration-fast', label: 'fast — 120ms' },
  { token: '--duration-base', label: 'base — 200ms' },
  { token: '--duration-slow', label: 'slow — 320ms' },
];

function MotionBox({ token, label, reducedPreview }) {
  const [active, setActive] = useState(false);

  const duration = reducedPreview ? '0ms' : `var(${token})`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
      <div
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => setActive(false)}
        style={{
          width: 80,
          height: 80,
          background: active ? 'var(--color-accent)' : 'var(--color-accent-soft)',
          borderRadius: `var(${active ? '--radius-full' : '--radius-md'})`,
          border: '1.5px solid var(--color-accent)',
          transition: `all ${duration} var(--ease-default)`,
          cursor: 'default',
          transform: active ? 'scale(1.12)' : 'scale(1)',
        }}
      />
      <TokenLabel name={token} />
      <span className="qv-fs-xs qv-text-muted">{label}</span>
    </div>
  );
}

function MotionSection() {
  const [reducedPreview, setReducedPreview] = useState(false);

  return (
    <GallerySection id="motion">
      <SectionTitle>Motion</SectionTitle>
      <SectionDesc>Hover each box to preview the easing + duration. Toggle the checkbox to simulate prefers-reduced-motion.</SectionDesc>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-6)',
          fontSize: 'var(--fs-sm)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={reducedPreview}
          onChange={(e) => setReducedPreview(e.target.checked)}
          style={{ width: 'auto' }}
        />
        Simulate prefers-reduced-motion
      </label>
      <div
        style={{
          ...compactGrid(140),
          gap: 'var(--space-8)',
        }}
      >
        {MOTION_DURATIONS.map(({ token, label }) => (
          <MotionBox key={token} token={token} label={label} reducedPreview={reducedPreview} />
        ))}
      </div>
    </GallerySection>
  );
}

/* ── 7. Components ───────────────────────────────────────── */

const STATUS_BADGE_TONES = ['accent', 'exam', 'success', 'warning', 'danger', 'vault', 'quant', 'excel', 'ops', 'default'];

const SEG_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'complete', label: 'Complete' },
];

const STUB_RUBRIC_CRITERIA = [
  { id: 'c1', label: 'Risk identification', description: 'Identifies at least two portfolio risks.', points: 3 },
  { id: 'c2', label: 'Return attribution', description: 'Decomposes alpha vs factor return.', points: 4 },
  { id: 'c3', label: 'Recommendation', description: 'Provides actionable recommendation with rationale.', points: 3 },
];

function ComponentsRow({ label, children }) {
  return (
    <div style={{ marginBottom: 'var(--space-8)' }}>
      <p style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-black)', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
        {label}
      </p>
      {children}
    </div>
  );
}

function ComponentsSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [seg, setSeg] = useState('all');
  const [rubricScores, setRubricScores] = useState({ c1: 0, c2: 0, c3: 0 });

  return (
    <GallerySection id="components">
      <SectionTitle>Components</SectionTitle>
      <SectionDesc>Every Primitive used across the app, rendered with representative data.</SectionDesc>

      {/* Surface */}
      <ComponentsRow label="Surface — tone variants">
        <div style={{ ...compactGrid(150), gap: 'var(--space-4)' }}>
          {['default', 'study', 'exam', 'vault', 'quant', 'excel', 'ops', 'metric'].map((tone) => (
            <Surface key={tone} tone={tone}>
              <code className="qv-fs-xs qv-text-muted">tone="{tone}"</code>
            </Surface>
          ))}
        </div>
      </ComponentsRow>

      {/* StatusBadge */}
      <ComponentsRow label="StatusBadge — all tones">
        <InlineCluster>
          {STATUS_BADGE_TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone}>{tone}</StatusBadge>
          ))}
        </InlineCluster>
      </ComponentsRow>

      {/* PageHeader */}
      <ComponentsRow label="PageHeader">
        <PageHeader
          badge="Style Gallery"
          title="Design System"
          subtitle="Canonical tokens and primitives for the QuantVault visual language."
          tone="study"
        />
      </ComponentsRow>

      {/* MetricTile */}
      <ComponentsRow label="MetricTile — all tones">
        <div style={{ ...compactGrid(180), gap: 'var(--space-4)' }}>
          {['accent', 'success', 'warning', 'danger', 'exam', 'vault', 'quant'].map((tone) => (
            <MetricTile key={tone} label="Questions answered" value="142" detail="+12 today" tone={tone} />
          ))}
        </div>
      </ComponentsRow>

      {/* Panel */}
      <ComponentsRow label="Panel">
        <div style={{ ...compactGrid(240), gap: 'var(--space-4)' }}>
          <Panel title="Study Progress" subtitle="Last 30 days" eyebrow="CFA Level I" tone="study">
            <ProgressRail value={68} max={100} label="Coverage" />
          </Panel>
          <Panel title="Risk Management" eyebrow="Quant" tone="quant">
            <ProgressRail value={42} max={100} label="Confidence" tone="quant" />
          </Panel>
        </div>
      </ComponentsRow>

      {/* Dialog */}
      <ComponentsRow label="Dialog">
        <button className="btn btn-secondary" type="button" onClick={() => setDialogOpen(true)}>
          Open Dialog preview
        </button>
        {dialogOpen && (
          <Dialog
            title="Confirm action"
            description="This is a sample dialog showing the Dialog primitive. Press Esc or click outside to close."
            onClose={() => setDialogOpen(false)}
            actions={
              <>
                <button className="btn btn-ghost" type="button" onClick={() => setDialogOpen(false)}>Cancel</button>
                <button className="btn btn-primary" type="button" onClick={() => setDialogOpen(false)}>Confirm</button>
              </>
            }
          >
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--fs-sm)' }}>
              Dialog content goes here. Focus is trapped inside and restored on close.
            </p>
          </Dialog>
        )}
      </ComponentsRow>

      {/* SegmentedControl */}
      <ComponentsRow label="SegmentedControl">
        <SegmentedControl
          label="Filter options"
          options={SEG_OPTIONS}
          value={seg}
          onChange={setSeg}
        />
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)' }}>
          Selected: <strong>{seg}</strong>
        </p>
      </ComponentsRow>

      {/* InlineCluster */}
      <ComponentsRow label="InlineCluster — align variants">
        {['start', 'center', 'end', 'between'].map((align) => (
          <div key={align} style={{ marginBottom: 'var(--space-3)', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
            <InlineCluster align={align}>
              <StatusBadge tone="accent">Token</StatusBadge>
              <StatusBadge tone="exam">System</StatusBadge>
              <StatusBadge tone="vault">Primitives</StatusBadge>
              <code className="qv-fs-xs qv-text-muted">align="{align}"</code>
            </InlineCluster>
          </div>
        ))}
      </ComponentsRow>

      {/* ProgressRail */}
      <ComponentsRow label="ProgressRail — tones">
        <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 520 }}>
          {[
            { tone: 'accent', value: 35 },
            { tone: 'exam', value: 52 },
            { tone: 'success', value: 74 },
            { tone: 'danger', value: 88 },
          ].map(({ tone, value }) => (
            <ProgressRail key={tone} value={value} max={100} label={`Progress (${tone})`} tone={tone} />
          ))}
        </div>
      </ComponentsRow>

      {/* EmptyPanel */}
      <ComponentsRow label="EmptyPanel">
        <EmptyPanel
          title="Nothing here yet"
          description="Add study items and they will appear here, sorted by due date."
          action={<button className="btn btn-primary" type="button">Get started</button>}
        />
      </ComponentsRow>

      {/* QuestionStage */}
      <ComponentsRow label="QuestionStage">
        <QuestionStage
          badge="Q 12 / 60"
          question="A portfolio manager estimates the standard deviation of monthly active returns to be 1.8%. What is the annualised tracking error closest to?"
          objective="Quantitative Methods — 2.2"
          footer={
            <InlineCluster align="end">
              <button className="btn btn-ghost" type="button">Skip</button>
              <button className="btn btn-primary" type="button">Submit answer</button>
            </InlineCluster>
          }
        >
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {['A. 3.6%', 'B. 6.2%', 'C. 7.2%', 'D. 12.5%'].map((opt) => (
              <button key={opt} className="btn btn-secondary" style={{ justifyContent: 'flex-start' }} type="button">
                {opt}
              </button>
            ))}
          </div>
        </QuestionStage>
      </ComponentsRow>

      {/* RubricPanel */}
      <ComponentsRow label="RubricPanel">
        <RubricPanel
          title="Level III Constructed Response — Rubric"
          criteria={STUB_RUBRIC_CRITERIA}
          scores={rubricScores}
          maxPoints={10}
          onScore={(id, val) => setRubricScores((prev) => ({ ...prev, [id]: val }))}
        />
      </ComponentsRow>
    </GallerySection>
  );
}

/* ── TOC sidebar ─────────────────────────────────────────── */

const TOC_ITEMS = [
  { id: 'colors', label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'radius', label: 'Radius' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'motion', label: 'Motion' },
  { id: 'components', label: 'Components' },
];

function TableOfContents() {
  return (
    <nav
      aria-label="Style Gallery sections"
      style={{
        position: 'sticky',
        top: 'calc(var(--topbar-height, 64px) + var(--space-8))',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        minWidth: 160,
      }}
    >
      <p style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-black)', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)', margin: '0 0 var(--space-3)' }}>
        Sections
      </p>
      {TOC_ITEMS.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--color-text-secondary)',
            padding: 'var(--space-1) var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            textDecoration: 'none',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-primary)'; e.currentTarget.style.background = 'rgba(148,163,184,0.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; e.currentTarget.style.background = 'transparent'; }}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

/* ── Page ────────────────────────────────────────────────── */

export default function StyleGallery() {
  return (
    <div className="page-container">
      <header style={{ marginBottom: 'var(--space-10)' }}>
        <StatusBadge tone="accent">Design System</StatusBadge>
        <h1 style={{ fontSize: 'var(--fs-4xl)', fontWeight: 'var(--fw-black)', margin: 'var(--space-3) 0 var(--space-3)', color: 'var(--color-text-primary)' }}>
          Style Gallery
        </h1>
        <p style={{ fontSize: 'var(--fs-md)', color: 'var(--color-text-secondary)', maxWidth: '68ch', margin: 0 }}>
          Canonical design tokens and every Primitive component in one discoverable reference. Read-only — no data is written.
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 160px) minmax(0, 1fr)', gap: 'clamp(var(--space-4), 5vw, var(--space-12))', alignItems: 'start' }}>
        <TableOfContents />
        <main>
          <ColorsSection />
          <TypographySection />
          <SpacingSection />
          <RadiusSection />
          <ElevationSection />
          <MotionSection />
          <ComponentsSection />
        </main>
      </div>
    </div>
  );
}
