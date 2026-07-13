import {
  Anchor,
  BookMarked,
  FlaskConical,
  Lock,
  type LucideIcon,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Icon } from "@lsat/components/ui/icon";
import { cn } from "@lsat/lib/utils";

/**
 * R8 (docs/18) — "The Archive" provenance system.
 *
 * One calm, colorblind-safe identity per question source, used everywhere a
 * source appears (Browse rows, preview drawer, Operations by-source breakdown,
 * dataset import rows). Redundancy is intentional: each source carries BOTH a
 * tint and a distinct lucide glyph, so the distinction survives color-blindness
 * and the high-contrast theme.
 *
 * Color rules (hard constraints):
 *  - the violet Verdict accent is reserved for UI (primary/active) and is NEVER
 *    used as a data color here;
 *  - the Okabe–Ito q-type palette (lib/labels.ts) is reserved for question
 *    TYPE, never source — so source and type never collide visually.
 * Everything below rides on semantic/graphite tokens, so it re-themes for free
 * across light / dark / focus / high-contrast.
 */

export type ProvenanceSource =
  | "official"
  | "ai_generated"
  | "sample"
  | "research"
  | "reclor";

interface SourceMeta {
  /** Canonical, human-readable label (single source of truth — replaces the
   * duplicate SOURCE_LABEL maps + raw `src.key` text the Archive used to ship). */
  label: string;
  /** Short label for tight chips (Browse rows / dataset rows). */
  short: string;
  icon: LucideIcon;
  /** Faint token-driven tint + matching readable foreground. */
  tint: string;
  /** One-line gloss for the legend / tooltips. */
  hint: string;
}

const UNKNOWN: SourceMeta = {
  label: "Unknown source",
  short: "Unknown",
  icon: BookMarked,
  tint: "bg-muted text-muted-foreground",
  hint: "Source not recorded.",
};

const SOURCE_META: Record<ProvenanceSource, SourceMeta> = {
  official: {
    label: "Official",
    short: "Official",
    icon: ShieldCheck,
    tint: "bg-success-subtle text-success",
    hint: "Real LSAC content you imported — the gold standard.",
  },
  research: {
    label: "Research dataset",
    short: "Research",
    icon: BookMarked,
    tint: "bg-info-subtle text-info",
    hint: "Pulled from a public research dataset (e.g. Hugging Face).",
  },
  reclor: {
    label: "ReClor (non-commercial)",
    short: "ReClor",
    icon: Lock,
    tint: "bg-warning-subtle text-warning",
    hint: "Research dataset under a non-commercial / personal-study license.",
  },
  ai_generated: {
    label: "AI generated",
    short: "AI",
    icon: Sparkles,
    // Neutral graphite — machine-made items read as "synthetic", not alarming.
    tint: "bg-secondary text-secondary-foreground",
    hint: "Synthesised on-device and approved out of quarantine.",
  },
  sample: {
    label: "Sample",
    short: "Sample",
    icon: FlaskConical,
    tint: "bg-muted text-muted-foreground",
    hint: "Bundled demo content shown when the bank is empty or offline.",
  },
};

function metaFor(source: string): SourceMeta {
  return SOURCE_META[source as ProvenanceSource] ?? UNKNOWN;
}

/** Canonical label for any source string — replaces the old SOURCE_LABEL maps. */
export function sourceLabel(source: string): string {
  return metaFor(source).label;
}

/** Ordered list for the legend (matches the bank's trust hierarchy). */
const LEGEND_ORDER: ProvenanceSource[] = [
  "official",
  "research",
  "reclor",
  "ai_generated",
  "sample",
];

export function ProvenanceBadge({
  source,
  trainingEligible = false,
  trainingNotes,
  size = "sm",
  className,
}: {
  source: string;
  /** Wave 1.6 training-corpus flag — rendered as a separate companion pill. */
  trainingEligible?: boolean | null;
  trainingNotes?: string | null;
  size?: "xs" | "sm";
  className?: string;
}) {
  const meta = metaFor(source);
  const pad = size === "xs" ? "px-1.5 py-0.5 text-2xs gap-1" : "px-2 py-0.5 text-xs gap-1.5";
  const iconSize = size === "xs" ? "xs" : "sm";
  return (
    <span className={cn("inline-flex items-center", className)}>
      <span
        className={cn(
          "inline-flex items-center rounded-full font-medium",
          pad,
          meta.tint,
        )}
        title={meta.hint}
      >
        <Icon as={meta.icon} size={iconSize} />
        {size === "xs" ? meta.short : meta.label}
      </span>
      {trainingEligible ? (
        <span
          className={cn(
            "ml-1 inline-flex items-center rounded-full border border-border bg-surface-2 font-medium text-foreground",
            pad,
          )}
          title={trainingNotes || "Marked as training-corpus anchor data"}
        >
          <Icon as={Anchor} size={iconSize} />
          Training
        </span>
      ) : null}
    </span>
  );
}

/**
 * Compact, token-driven legend keying each source glyph + tint to its meaning.
 * Drop it under a by-source breakdown or a browse list so the encoding is never
 * a guessing game.
 */
export function ProvenanceLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-x-4 gap-y-1.5", className)}>
      {LEGEND_ORDER.map((src) => {
        const meta = SOURCE_META[src];
        return (
          <span
            key={src}
            className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
          >
            <span
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full",
                meta.tint,
              )}
            >
              <Icon as={meta.icon} size="xs" className="h-3 w-3" />
            </span>
            {meta.label}
          </span>
        );
      })}
      <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface-2">
          <Icon as={Anchor} size="xs" className="h-3 w-3" />
        </span>
        Training corpus
      </span>
    </div>
  );
}
