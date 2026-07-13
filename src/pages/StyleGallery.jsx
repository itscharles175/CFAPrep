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

/**
 * Resolve the live computed value of one or more CSS custom properties from the
 * document root, re-reading whenever the active theme changes. Driving the gallery
 * from the *resolved* values (rather than hard-coded strings) is what keeps it from
 * drifting away from src/index.css + tokens.css — if a token changes, this reflects it.
 */
function useComputedVars(tokens) {
  const key = Array.isArray(tokens) ? tokens.join('|') : tokens;
  const [values, setValues] = useState({});

  useEffect(() => {
    const list = Array.isArray(tokens) ? tokens : [tokens];
    const read = () => {
      const styles = getComputedStyle(document.documentElement);
      const next = {};
      for (const token of list) next[token] = styles.getPropertyValue(token).trim();
      setValues(next);
    };
    read();
    // The theme provider toggles `data-theme` on <html>; re-read so the live
    // readouts (colors especially) track light ↔ dark without a reload.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return values;
}

// G6 (UIv2) — token names are click-to-copy so the gallery is a usable reference,
// not just a readout. Falls back silently if the Clipboard API is unavailable
// (e.g. an insecure context); shows a brief "Copied ✓" then reverts.
function TokenLabel({ name }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(name).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${name}`}
      aria-label={`Copy token ${name} to clipboard`}
      className="qv-fs-xs qv-text-muted qv-mono"
      style={{ background: 'none', border: 0, padding: 0, cursor: 'copy', font: 'inherit', color: 'inherit', textAlign: 'left' }}
    >
      {copied ? 'Copied ✓' : name}
    </button>
  );
}

function ComputedValue({ token }) {
  const values = useComputedVars(token);
  const value = values[token];
  if (!value) return null;
  return <span className="qv-fs-xs qv-text-muted qv-mono">{value}</span>;
}

function GroupLabel({ children }) {
  return (
    <p
      className="type-overline"
      style={{ margin: '0 0 var(--space-3)' }}
    >
      {children}
    </p>
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

// The three routes App.jsx re-tints via `data-domain` on <body>. tokens.css
// rebinds `--color-accent` (and `--accent`) under [data-domain="…"], so wrapping
// a swatch in the attribute shows the live re-tinted accent.
const DOMAIN_ACCENTS = [
  { domain: 'cfa', label: 'CFA — blue (app default)' },
  { domain: 'excel', label: 'Excel — green' },
  { domain: 'quant', label: 'Quant — purple/magenta' },
];

function ColorSwatch({ token }) {
  const ref = useRef(null);
  const [resolved, setResolved] = useState('');

  // Read the *rendered* color so the chip shows what the eye actually sees
  // (the var() can resolve through several aliases; computed backgroundColor is
  // the final rgb()/rgba()). Re-reads on theme change like the other readouts.
  useEffect(() => {
    const read = () => {
      if (ref.current) setResolved(getComputedStyle(ref.current).backgroundColor || '');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
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
      {resolved && (
        <span className="qv-fs-xs qv-text-muted qv-mono">{resolved}</span>
      )}
    </div>
  );
}

function ColorsSection() {
  return (
    <GallerySection id="colors">
      <SectionTitle>Colors</SectionTitle>
      <SectionDesc>Semantic token layer (live computed values). Swatches resolve through the src/index.css core palette and re-read when you toggle the app theme.</SectionDesc>
      {COLOR_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 'var(--space-8)' }}>
          <GroupLabel>{group.label}</GroupLabel>
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

      {/* Per-domain accent re-tint — driven by the live `data-domain` override
          that App.jsx applies on /cfa, /excel, /quant. Wrapping each chip in a
          [data-domain] element reproduces the same cascade here so the gallery
          shows the resolved accent per domain without leaving the page. */}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <GroupLabel>Per-domain accent (live re-tint via data-domain)</GroupLabel>
        <div style={{ ...compactGrid(150), gap: 'var(--space-4)' }}>
          {DOMAIN_ACCENTS.map(({ domain, label }) => (
            <div key={domain} data-domain={domain} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
              <div
                style={{
                  width: '100%',
                  height: 56,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-accent)',
                  border: '1px solid var(--color-border)',
                  boxShadow: 'var(--elevation-1)',
                }}
              />
              <code className="qv-fs-xs qv-text-muted qv-mono">data-domain="{domain}"</code>
              <span className="qv-fs-xs qv-text-muted">{label}</span>
            </div>
          ))}
        </div>
      </div>
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

const LINE_HEIGHTS = [
  { token: '--lh-tight', label: 'tight' },
  { token: '--lh-snug', label: 'snug' },
  { token: '--lh-normal', label: 'normal' },
  { token: '--lh-relaxed', label: 'relaxed' },
];

const TYPE_VOICES = [
  {
    cls: 'type-display',
    label: 'Display — Newsreader serif, for hero / section headings',
    sample: 'Constructed Response',
    style: { fontSize: 'var(--fs-3xl)', color: 'var(--color-text-primary)' },
  },
  {
    cls: 'type-counsel',
    label: 'Counsel — serif long-form body',
    sample: 'A portfolio manager weighing tracking error against expected active return must reconcile the mandate constraints with the client’s risk tolerance.',
    style: { fontSize: 'var(--fs-lg)', color: 'var(--color-text-secondary)', lineHeight: 'var(--lh-relaxed)' },
  },
  {
    cls: 'type-numeric',
    label: 'Numeric — tabular figures for timers, scores, metrics',
    sample: '1,284.50  →  +12.4%  —  00:42:17',
    style: { fontSize: 'var(--fs-xl)', color: 'var(--color-text-primary)' },
  },
  {
    cls: 'type-overline',
    label: 'Overline — small uppercase eyebrow labels',
    sample: 'Quantitative Methods',
    style: {},
  },
];

function TypographySection() {
  return (
    <GallerySection id="typography">
      <SectionTitle>Typography</SectionTitle>
      <SectionDesc>Font-size ramp (17px reading anchor at --fs-lg), weight + line-height scales, and the four type-voice utilities. Font stacks are offline-safe (Geist / Newsreader).</SectionDesc>

      <GroupLabel>Size ramp</GroupLabel>
      <div style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-10)' }}>
        {FONT_SIZES.map(({ token, label }) => (
          <div
            key={token}
            style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--space-3)', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-2)' }}
          >
            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, minWidth: 110 }}>
              <TokenLabel name={token} />
              <ComputedValue token={token} />
            </span>
            <span style={{ fontSize: `var(${token})`, color: 'var(--color-text-primary)', lineHeight: 1.3 }}>
              {label} — The quick brown fox jumps over the lazy dog
            </span>
          </div>
        ))}
      </div>

      <GroupLabel>Weight ramp</GroupLabel>
      <div style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-10)' }}>
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

      <GroupLabel>Line-height ramp</GroupLabel>
      <div style={{ ...compactGrid(220), gap: 'var(--space-4)', marginBottom: 'var(--space-10)' }}>
        {LINE_HEIGHTS.map(({ token, label }) => (
          <div key={token} className="qv-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              <TokenLabel name={token} />
              <ComputedValue token={token} />
            </div>
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)', lineHeight: `var(${token})` }}>
              {label} leading. The annualised tracking error scales with the square root of twelve, so monthly active-return dispersion compounds across the year.
            </p>
          </div>
        ))}
      </div>

      <GroupLabel>Type voices</GroupLabel>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {TYPE_VOICES.map(({ cls, label, sample, style }) => (
          <div
            key={cls}
            style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-3)' }}
          >
            <code className="qv-fs-xs qv-text-muted qv-mono">.{cls}</code>
            <div className={cls} style={{ marginTop: 'var(--space-2)', ...style }}>
              {sample}
            </div>
            <span className="qv-fs-xs qv-text-muted" style={{ display: 'block', marginTop: 'var(--space-1)' }}>{label}</span>
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
      <SectionDesc>4 px modular scale (live computed values). Each box is sized at the token value.</SectionDesc>
      <div className="qv-stack-3">
        {SPACE_TOKENS.map((token) => (
          <div key={token} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
            <div style={{ width: 140, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TokenLabel name={token} />
              <ComputedValue token={token} />
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
  { token: '--radius-lg', label: 'lg — 8px' },
  { token: '--radius-xl', label: 'xl — 10px' },
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
            <ComputedValue token={token} />
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
  { token: '--elevation-4', label: '4 — overlay' },
  { token: '--elevation-floating', label: 'floating — alias of 4' },
];

function ElevationSection() {
  return (
    <GallerySection id="elevation">
      <SectionTitle>Elevation</SectionTitle>
      <SectionDesc>5-step box-shadow depth ramp (--elevation-0..4). Cards are shown against a recessed background to make shadows visible.</SectionDesc>
      <div
        style={{
          ...compactGrid(150),
          gap: 'var(--space-6)',
          padding: 'clamp(var(--space-4), 5vw, var(--space-8))',
          background: 'var(--surface-data)',
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
            <ComputedValue token={token} />
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', textAlign: 'center' }}>{label}</span>
          </div>
        ))}
      </div>
    </GallerySection>
  );
}

/* ── 6. Motion ───────────────────────────────────────────── */

const MOTION_DURATIONS = [
  { token: '--duration-fast', label: 'fast' },
  { token: '--duration-base', label: 'base' },
  { token: '--duration-slow', label: 'slow' },
];

const MOTION_EASES = [
  { token: '--ease-standard', label: 'standard — most transitions' },
  { token: '--ease-emphasized', label: 'emphasized — enter / expand' },
  { token: '--ease-exit', label: 'exit — leave / collapse' },
];

function MotionBox({ token, label, reducedPreview, easeToken = '--ease-standard', durationToken = '--duration-base' }) {
  const [active, setActive] = useState(false);

  const duration = reducedPreview ? '0ms' : `var(${durationToken})`;
  const ease = `var(${easeToken})`;

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
          transition: `all ${duration} ${ease}`,
          cursor: 'default',
          transform: active ? 'scale(1.12)' : 'scale(1)',
        }}
      />
      <TokenLabel name={token} />
      <ComputedValue token={token} />
      <span className="qv-fs-xs qv-text-muted">{label}</span>
    </div>
  );
}

function MotionSection() {
  const [reducedPreview, setReducedPreview] = useState(false);

  return (
    <GallerySection id="motion">
      <SectionTitle>Motion</SectionTitle>
      <SectionDesc>Hover each box to preview the curve + duration (live computed values). Toggle the checkbox to simulate prefers-reduced-motion — a global damp already zeroes durations when the OS asks.</SectionDesc>
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

      <GroupLabel>Durations (eased with --ease-standard)</GroupLabel>
      <div
        style={{
          ...compactGrid(140),
          gap: 'var(--space-8)',
          marginBottom: 'var(--space-10)',
        }}
      >
        {MOTION_DURATIONS.map(({ token, label }) => (
          <MotionBox key={token} token={token} label={label} reducedPreview={reducedPreview} durationToken={token} />
        ))}
      </div>

      <GroupLabel>Easing curves (at --duration-slow so the curve is legible)</GroupLabel>
      <div
        style={{
          ...compactGrid(140),
          gap: 'var(--space-8)',
        }}
      >
        {MOTION_EASES.map(({ token, label }) => (
          <MotionBox key={token} token={token} label={label} reducedPreview={reducedPreview} easeToken={token} durationToken="--duration-slow" />
        ))}
      </div>
    </GallerySection>
  );
}

/* ── Focus ring ──────────────────────────────────────────── */

function FocusRingSection() {
  return (
    <GallerySection id="focus">
      <SectionTitle>Focus ring</SectionTitle>
      <SectionDesc>The shared keyboard-focus treatment: an outline reading the canonical --ring (HSL triplet) at --ring-offset. Tab through these controls to see the live ring; pointer focus stays quiet via :focus-visible.</SectionDesc>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', maxWidth: 360, marginBottom: 'var(--space-6)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <TokenLabel name="--ring" />
          <ComputedValue token="--ring" />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <TokenLabel name="--ring-offset" />
          <ComputedValue token="--ring-offset" />
        </div>
      </div>
      <InlineCluster>
        <button className="btn btn-primary" type="button">Primary button</button>
        <button className="btn btn-secondary" type="button">Secondary button</button>
        <button className="surface-interactive" type="button" style={{ padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)' }}>
          surface-interactive
        </button>
        <a
          href="#focus"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: 'var(--space-2) var(--space-3)',
            color: 'var(--color-accent)',
            borderRadius: 'var(--radius-sm)',
            textDecoration: 'underline',
          }}
        >
          Focusable link
        </a>
      </InlineCluster>
    </GallerySection>
  );
}

/* ── Tactile primitives ──────────────────────────────────── */

function TactileSection() {
  return (
    <GallerySection id="tactile">
      <SectionTitle>Tactile surfaces</SectionTitle>
      <SectionDesc>The shared tactile classes — .glass-card (raised panel with hover lift), .surface-interactive (pressable row), and the .btn family — all wired to the elevation, motion, and focus tokens above.</SectionDesc>

      <GroupLabel>.glass-card (hover to lift)</GroupLabel>
      <div style={{ ...compactGrid(240), gap: 'var(--space-4)', marginBottom: 'var(--space-8)' }}>
        <div className="glass-card">
          <p className="type-overline" style={{ margin: '0 0 var(--space-2)' }}>Readiness</p>
          <p className="type-numeric" style={{ margin: 0, fontSize: 'var(--fs-2xl)', color: 'var(--color-text-primary)' }}>82%</p>
        </div>
        <div className="glass-card no-hover">
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--color-text-secondary)' }}>
            <code className="qv-fs-xs qv-mono">.glass-card.no-hover</code> — same surface, no lift on hover.
          </p>
        </div>
      </div>

      <GroupLabel>.btn family</GroupLabel>
      <InlineCluster>
        <button className="btn btn-primary" type="button">Primary</button>
        <button className="btn btn-secondary" type="button">Secondary</button>
        <button className="btn btn-ghost" type="button">Ghost</button>
        <button className="btn btn-primary" type="button" disabled>Disabled</button>
      </InlineCluster>
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
  { id: 'focus', label: 'Focus ring' },
  { id: 'motion', label: 'Motion' },
  { id: 'tactile', label: 'Tactile surfaces' },
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
          <FocusRingSection />
          <MotionSection />
          <TactileSection />
          <ComponentsSection />
        </main>
      </div>
    </div>
  );
}
