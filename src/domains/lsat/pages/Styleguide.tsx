import { useEffect, useState } from "react";
import { m } from "motion/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { TYPE_FAMILY_LIST, qTypeLabel } from "@/lib/labels";
import type { QType } from "@/lib/types";
import { PageLayout } from "@/components/page-layout";
import { fadeUp, stagger } from "@/lib/motion";
import { toast } from "@/lib/toast";
import {
  ContributionHeatmap,
  GapDumbbell,
  HeatStrip,
  MasteryMatrix,
  ProgressRing,
  Sparkline,
  StatNumber,
  TrendChart,
  TypeBadge,
} from "@/components/viz";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Skeleton,
  SkeletonCard,
  SkeletonChart,
  SkeletonList,
} from "@/components/states";
import {
  IllustrationAnalytics,
  IllustrationPrepTests,
  IllustrationSrsCaughtUp,
} from "@/components/illustrations";

// R8 truth-fix (docs/18): the Styleguide MUST read the live design tokens, never
// re-declare them. Swatches render via the Tailwind classes that resolve to the
// CSS vars (e.g. `bg-graphite-300` → hsl(var(--graphite-300))), and the caption
// reads the *computed* var value at runtime — so this page can never drift from
// index.css again. (The old version hardcoded HSL strings and had a real bug:
// graphite-300 listed as "223 15% 83%" while the token is "223 16% 83%".)
// Full literal class strings so Tailwind's JIT scanner generates them (it can't
// see `bg-graphite-${n}` template interpolation). Each class still resolves to
// its CSS var; nothing here re-declares an HSL value.
const GRAPHITE: { step: number; cls: string; varName: string }[] = [
  { step: 50, cls: "bg-graphite-50", varName: "--graphite-50" },
  { step: 100, cls: "bg-graphite-100", varName: "--graphite-100" },
  { step: 200, cls: "bg-graphite-200", varName: "--graphite-200" },
  { step: 300, cls: "bg-graphite-300", varName: "--graphite-300" },
  { step: 400, cls: "bg-graphite-400", varName: "--graphite-400" },
  { step: 500, cls: "bg-graphite-500", varName: "--graphite-500" },
  { step: 600, cls: "bg-graphite-600", varName: "--graphite-600" },
  { step: 700, cls: "bg-graphite-700", varName: "--graphite-700" },
  { step: 800, cls: "bg-graphite-800", varName: "--graphite-800" },
  { step: 900, cls: "bg-graphite-900", varName: "--graphite-900" },
  { step: 950, cls: "bg-graphite-950", varName: "--graphite-950" },
];
const VERDICT: { step: number; cls: string; varName: string }[] = [
  { step: 300, cls: "bg-verdict-300", varName: "--verdict-300" },
  { step: 400, cls: "bg-verdict-400", varName: "--verdict-400" },
  { step: 500, cls: "bg-verdict-500", varName: "--verdict-500" },
  { step: 600, cls: "bg-verdict-600", varName: "--verdict-600" },
  { step: 700, cls: "bg-verdict-700", varName: "--verdict-700" },
];
const SEMANTIC: { name: string; cls: string; varName: string }[] = [
  { name: "success", cls: "bg-success", varName: "--success" },
  { name: "warning", cls: "bg-warning", varName: "--warning" },
  { name: "danger", cls: "bg-destructive", varName: "--destructive" },
  { name: "info", cls: "bg-info", varName: "--info" },
];

const SURFACES: { name: string; cls: string; varName: string }[] = [
  { name: "surface-0", cls: "bg-surface-0", varName: "--surface-0" },
  { name: "surface-1", cls: "bg-surface-1", varName: "--surface-1" },
  { name: "surface-2", cls: "bg-surface-2", varName: "--surface-2" },
  { name: "surface-3", cls: "bg-surface-3", varName: "--surface-3" },
];

const SUBTLE: { name: string; cls: string }[] = [
  { name: "success-subtle", cls: "bg-success-subtle" },
  { name: "warning-subtle", cls: "bg-warning-subtle" },
  { name: "info-subtle", cls: "bg-info-subtle" },
  { name: "destructive-subtle", cls: "bg-destructive-subtle" },
];

/** Reads a CSS custom property's *computed* value off the document root so the
 * Styleguide displays the live token, re-reading whenever the theme changes. */
function useLiveToken(varName: string): string {
  const [val, setVal] = useState("");
  useEffect(() => {
    const read = () =>
      setVal(
        getComputedStyle(document.documentElement)
          .getPropertyValue(varName)
          .trim(),
      );
    read();
    // Theme/density switches toggle classes on <html>; re-read on those.
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-density"],
    });
    return () => obs.disconnect();
  }, [varName]);
  return val;
}

const TYPE_SCALE: { name: string; cls: string }[] = [
  { name: "xs 12/16", cls: "text-xs" },
  { name: "sm 14/20", cls: "text-sm" },
  { name: "base 15/24", cls: "text-base" },
  { name: "lg 17/26", cls: "text-lg" },
  { name: "xl 20/28", cls: "text-xl" },
  { name: "2xl 24/32", cls: "text-2xl" },
  { name: "3xl 30/38", cls: "text-3xl" },
  { name: "4xl 38/44", cls: "text-4xl" },
];

const SAMPLE_TYPES: QType[] = [
  "NecessaryAssumption",
  "Strengthen",
  "Flaw",
  "Inference",
  "PrincipleApply",
  "Parallel",
  "Paradox",
  "Detail",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <m.section variants={fadeUp} className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </m.section>
  );
}

/**
 * A color swatch driven entirely by a Tailwind class that references the live
 * CSS var (no inline HSL). When `varName` is given, the caption shows the
 * token's *computed* value, so the page literally renders the source of truth.
 */
function Swatch({
  label,
  cls,
  varName,
}: {
  label: string;
  cls: string;
  varName?: string;
}) {
  const live = useLiveToken(varName ?? "");
  return (
    <div className="space-y-1">
      <div className={`h-12 w-full rounded-md border ${cls}`} />
      <div className="text-[10px] leading-tight text-muted-foreground">{label}</div>
      {varName && (
        <div className="type-numeric text-[9px] leading-none text-muted-foreground/60">
          {live || "—"}
        </div>
      )}
    </div>
  );
}

/** Inline live token value (caption), reading the computed CSS var. */
function LiveTokenValue({ varName }: { varName: string }) {
  const live = useLiveToken(varName);
  return <>{live || "—"}</>;
}

/** Toggles a tactile <Button> through its `loading` state for the contract. */
function LoadingButtonDemo() {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={loading}
      onClick={() => {
        setLoading(true);
        window.setTimeout(() => setLoading(false), 1400);
      }}
    >
      {loading ? "Working…" : "Try loading state"}
    </Button>
  );
}

export default function Styleguide() {
  const [selected, setSelected] = useState<string>("—");

  const trend = [
    { date: "2026-01-01", score: 158 },
    { date: "2026-01-20", score: 160 },
    { date: "2026-02-10", score: 162 },
    { date: "2026-03-05", score: 161 },
    { date: "2026-04-01", score: 165 },
    { date: "2026-05-01", score: 167 },
  ];

  const heatCells = Array.from({ length: 25 }, (_, i) => ({
    value: 20 + Math.round(Math.abs(Math.sin(i)) * 100),
    correct: i % 4 !== 0,
    label: `Q${i + 1}`,
  }));

  const gapRows = SAMPLE_TYPES.slice(0, 6).map((t, i) => ({
    q_type: t,
    timed: 0.45 + (i % 5) * 0.07,
    blindReview: 0.6 + (i % 4) * 0.08,
  }));

  const masteryRows = SAMPLE_TYPES.map((t, i) => ({
    q_type: t,
    accuracy: 0.5 + ((i * 7) % 45) / 100,
    avgTimeMs: 40000 + i * 6500,
    volume: 12 + i * 9,
  }));

  const contrib = Array.from({ length: 130 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      value: Math.max(0, Math.round(Math.sin(i / 3) * 6 + 3)),
    };
  });

  return (
    <PageLayout
      title="Design System"
      description="Tokens, components, and motion — dev reference."
      width="xl"
      className="pb-16"
    >
    <m.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="space-y-10"
    >
      <m.div variants={fadeUp}>
        <p className="text-sm text-muted-foreground">
          The visual contract for LSAT Lab (docs/07). Every wave is checked against this.
        </p>
      </m.div>

      <Section title="Graphite ramp">
        <p className="-mt-1 text-xs text-muted-foreground">
          Swatches read the live <code className="font-mono">--graphite-*</code> tokens —
          the value under each can never drift from index.css.
        </p>
        <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
          {GRAPHITE.map((g) => (
            <Swatch key={g.step} label={`graphite-${g.step}`} cls={g.cls} varName={g.varName} />
          ))}
        </div>
      </Section>

      <Section title="Verdict accent (UI only — never a data category)">
        <div className="grid grid-cols-5 gap-2">
          {VERDICT.map((v) => (
            <Swatch key={v.step} label={`verdict-${v.step}`} cls={v.cls} varName={v.varName} />
          ))}
        </div>
      </Section>

      <Section title="Semantic colors">
        <div className="grid grid-cols-4 gap-2">
          {SEMANTIC.map((s) => (
            <Swatch key={s.name} label={s.name} cls={s.cls} varName={s.varName} />
          ))}
        </div>
      </Section>

      {/* ===== R8 "Quiet Observatory" tokens — the living visual contract ===== */}
      <Section title="Observatory · depth surfaces">
        <p className="-mt-1 text-xs text-muted-foreground">
          The elevation ladder expressed as luminance, not borders. In dark — the
          hero theme — surfaces step <em>up</em> toward light.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SURFACES.map((s) => (
            <div key={s.name} className="space-y-1">
              <div
                className={`flex h-16 items-center justify-center rounded-card border text-xs ${s.cls}`}
              >
                {s.name}
              </div>
              <div className="type-numeric text-[9px] leading-none text-muted-foreground/60">
                <LiveTokenValue varName={s.varName} />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Observatory · aurora & glass">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="aurora flex h-32 flex-col items-center justify-center rounded-card border bg-surface-1">
            <div className="type-numeric text-stat leading-none text-foreground">167</div>
            <div className="type-overline mt-1 text-muted-foreground">.aurora glow</div>
          </div>
          <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-card border bg-surface-2">
            <div className="absolute inset-0 grid grid-cols-6 opacity-50">
              {VERDICT.concat(VERDICT.slice(0, 1)).map((v, i) => (
                <div key={i} className={v.cls} />
              ))}
            </div>
            <div className="glass glow-verdict relative z-10 rounded-card border px-5 py-3 text-sm font-medium">
              .glass + .glow-verdict
            </div>
          </div>
        </div>
      </Section>

      <Section title="Observatory · semantic-subtle status tints">
        <p className="-mt-1 text-xs text-muted-foreground">
          One source for status backgrounds — replaces scattered <code>/5 /10 /15</code>{" "}
          opacity improvisations.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SUBTLE.map((s) => (
            <div
              key={s.name}
              className={`flex h-14 items-center justify-center rounded-card border text-xs font-medium ${s.cls}`}
            >
              {s.name}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Observatory · type voices">
        <div className="space-y-3 rounded-card border bg-surface-1 p-5">
          <div className="flex items-baseline gap-4">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">.type-display</span>
            <span className="type-display text-3xl">Predicted score</span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">.type-counsel</span>
            <span className="type-counsel reading-md">
              The argument assumes, without warrant, that the sample is representative.
            </span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">.type-numeric</span>
            <span className="type-numeric text-2xl">00:42 · 167 · 84%</span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">.type-overline</span>
            <span className="type-overline text-muted-foreground">Section · Logical Reasoning</span>
          </div>
        </div>
      </Section>

      <Section title="Observatory · brand mark & tactile buttons">
        <div className="flex flex-wrap items-center gap-6 rounded-card border bg-surface-1 p-5">
          <div className="flex items-center gap-4">
            <Logo className="h-10 w-10" />
            <Logo withWordmark wordmarkClassName="text-lg" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
          </div>
          <LoadingButtonDemo />
        </div>
      </Section>

      <Section title="Type-color families (Okabe–Ito, color-blind safe)">
        <div className="overflow-hidden rounded-card border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Family</th>
                <th className="px-3 py-2">Hex</th>
                <th className="px-3 py-2">Swatch</th>
              </tr>
            </thead>
            <tbody>
              {TYPE_FAMILY_LIST.map((f) => (
                <tr key={f.family} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-medium">{f.label}</td>
                  <td className="px-3 py-2 font-mono text-xs">{f.hex}</td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-block h-5 w-16 rounded"
                      style={{ backgroundColor: f.hex }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2">
          {SAMPLE_TYPES.map((t) => (
            <TypeBadge key={String(t)} qType={t} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {SAMPLE_TYPES.slice(0, 4).map((t) => (
            <TypeBadge key={String(t)} qType={t} variant="solid" />
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        <div className="space-y-1">
          {TYPE_SCALE.map((t) => (
            <div key={t.name} className="flex items-baseline gap-4">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{t.name}</span>
              <span className={t.cls}>The quick brown fox 0123456789</span>
            </div>
          ))}
          <div className="flex items-baseline gap-4 pt-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">mono / tabular</span>
            <span className="font-mono tabular-nums text-lg">00:42 · 167 · 84%</span>
          </div>
          <div className="flex items-baseline gap-4">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">serif reading</span>
            <span className="reading-serif reading-md">
              The argument assumes, without warrant, that…
            </span>
          </div>
        </div>
      </Section>

      <Section title="Elevation">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {(["e0", "e1", "e2", "e3", "e4"] as const).map((e) => (
            <div
              key={e}
              className={`flex h-20 items-center justify-center rounded-card border bg-card text-sm shadow-${e}`}
            >
              {e}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Motion demo">
        <m.div variants={stagger} initial="hidden" animate="show" className="flex gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <m.div
              key={i}
              variants={fadeUp}
              className="flex h-16 w-16 items-center justify-center rounded-card bg-primary/10 text-sm font-medium text-primary"
            >
              {i + 1}
            </m.div>
          ))}
        </m.div>
        <Button onClick={() => toast.success("Saved — toasts work")}>Fire a toast</Button>
      </Section>

      <Section title="Stat numbers & sparklines">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card className="p-4">
            <StatNumber label="Predicted" value={167} delta={3} />
          </Card>
          <Card className="p-4">
            <StatNumber label="Accuracy" value={84} suffix="%" delta={-2} deltaSuffix="%" />
          </Card>
          <Card className="flex items-center gap-3 p-4">
            <Sparkline data={[3, 5, 4, 6, 7, 6, 8]} fill />
            <span className="text-sm text-muted-foreground">7-day</span>
          </Card>
          <Card className="flex items-center justify-center p-4">
            <ProgressRing value={0.72} sublabel="of goal" />
          </Card>
        </div>
      </Section>

      <Section title="TrendChart (goal band · projection cone · exam marker)">
        <Card className="p-4">
          <TrendChart
            series={trend}
            goal={[168, 172]}
            examDate="2026-06-08"
            projection={{ score: 170, lowSpread: 3, highSpread: 3 }}
          />
        </Card>
      </Section>

      <Section title="HeatStrip (per-question timing)">
        <Card className="p-4">
          <HeatStrip cells={heatCells} ramp="inferno" />
        </Card>
      </Section>

      <Section title="GapDumbbell (timed vs blind-review)">
        <Card className="p-4">
          <GapDumbbell rows={gapRows} />
        </Card>
      </Section>

      <Section title={`MasteryMatrix (clicked: ${selected})`}>
        <MasteryMatrix
          rows={masteryRows}
          onSelect={(r) => setSelected(qTypeLabel(r.q_type))}
        />
      </Section>

      <Section title="ContributionHeatmap">
        <Card className="overflow-x-auto p-4">
          <ContributionHeatmap data={contrib} />
        </Card>
      </Section>

      <Section title="Skeletons">
        <div className="grid gap-4 sm:grid-cols-2">
          <SkeletonCard />
          <SkeletonChart />
        </div>
        <SkeletonList rows={3} />
        <Skeleton className="h-4 w-1/2" />
      </Section>

      <Section title="System status (one calm language)">
        <p className="-mt-1 text-xs text-muted-foreground">
          Error / loading / empty all share the same iconography, semantic-subtle
          tints, and spacing. Offline &amp; AI-prereq banners (rendered only when the
          backend/Ollama are down) use the same family.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <ErrorState error={new Error("Failed to fetch analytics")} onRetry={() => {}} />
          <div className="rounded-card border">
            <LoadingState label="Loading your data…" />
          </div>
        </div>
      </Section>

      <Section title="Empty states (bespoke illustrations)">
        <div className="grid gap-4 sm:grid-cols-2">
          <EmptyState
            title="No attempts yet"
            description="Import a PrepTest or start a drill to see your data come alive here."
            illustration={<IllustrationPrepTests />}
            action={<Button size="sm">Import a PrepTest</Button>}
          />
          <EmptyState
            title="All caught up"
            description="No cards are due for review right now. Beautiful work."
            illustration={<IllustrationSrsCaughtUp />}
          />
          <EmptyState
            title="Not enough data yet"
            description="Complete a few more sessions to unlock trend analytics."
            illustration={<IllustrationAnalytics />}
          />
          <EmptyState
            title="Nothing here yet"
            description="The default inbox icon is used when no illustration is supplied."
          />
        </div>
      </Section>
    </m.div>
    </PageLayout>
  );
}
