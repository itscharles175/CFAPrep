import type { ErrorReason, Outcome, QType, TrapType } from "./types";

const QTYPE_LABELS: Record<string, string> = {
  MainPoint: "Main Point",
  NecessaryAssumption: "Necessary Assumption",
  SufficientAssumption: "Sufficient Assumption",
  Strengthen: "Strengthen",
  Weaken: "Weaken",
  Flaw: "Flaw",
  Inference: "Inference",
  MostStronglySupported: "Most Strongly Supported",
  PrincipleApply: "Principle (Apply)",
  PrincipleIdentify: "Principle (Identify)",
  Parallel: "Parallel Reasoning",
  ParallelFlaw: "Parallel Flaw",
  Method: "Method of Reasoning",
  Role: "Role in Argument",
  PointAtIssue: "Point at Issue",
  Paradox: "Paradox",
  Evaluate: "Evaluate",
  Attitude: "Attitude",
  Detail: "Detail",
  Function: "Function",
  Structure: "Structure",
  Application: "Application",
  StrengthenWeaken: "Strengthen/Weaken",
  Comparative: "Comparative",
};

export function qTypeLabel(t: QType): string {
  return QTYPE_LABELS[t] ?? String(t);
}

const TRAP_LABELS: Record<TrapType, string> = {
  reversal: "Reversal",
  out_of_scope: "Out of Scope",
  degree: "Degree",
  scope_shift: "Scope Shift",
  half_right: "Half Right",
  opposite: "Opposite",
  too_strong: "Too Strong",
  irrelevant_comparison: "Irrelevant Comparison",
  premise_restatement: "Premise Restatement",
  none: "—",
};

export function trapLabel(t: TrapType): string {
  return TRAP_LABELS[t] ?? t;
}

/** Plain-English description of each trap pattern (docs/06 §3.5). */
export const TRAP_DESCRIPTIONS: Record<TrapType, string> = {
  reversal: "Swaps the direction of the relationship (e.g. picks 'strengthen' on a weaken stem).",
  out_of_scope: "Introduces a consideration the argument never addresses.",
  degree: "Right idea, but overstated or understated — too strong or too weak.",
  scope_shift: "Subtly changes the subject between premise and conclusion.",
  half_right: "Starts correctly but the second half breaks down.",
  opposite: "States the exact reverse of the correct answer.",
  too_strong: "Uses absolute language ('all', 'never') the evidence can't support.",
  irrelevant_comparison: "Compares things the argument gives no basis to compare.",
  premise_restatement: "Merely repeats a premise instead of answering the question.",
  none: "No specific trap pattern.",
};

/** How to beat each trap — the actionable counter-move (A9 explainer). */
export const TRAP_COUNTERS: Record<TrapType, string> = {
  reversal: "Before reading choices, say the question's direction out loud (strengthen vs weaken) and reject any answer that flips it.",
  out_of_scope: "Underline the conclusion's exact terms; an answer must stay inside them.",
  degree: "Watch quantifiers — match the answer's strength to the stimulus, no stronger.",
  scope_shift: "Track the subject from premise to conclusion; reject silent topic changes.",
  half_right: "Read every word of a tempting answer; one wrong clause kills it.",
  opposite: "After picking, re-check it answers the question asked, not its mirror.",
  too_strong: "Prefer measured language unless the stimulus is itself absolute.",
  irrelevant_comparison: "Ask whether the argument gave any basis to compare the two things.",
  premise_restatement: "A correct answer adds something — reject pure restatements of given facts.",
  none: "Keep logging wrong answers so patterns can surface.",
};

export const ERROR_REASONS: { value: ErrorReason; label: string }[] = [
  { value: "misread", label: "Misread" },
  { value: "trap", label: "Fell for a trap" },
  { value: "concept", label: "Concept gap" },
  { value: "timing", label: "Timing / pressure" },
  { value: "careless", label: "Careless" },
];

export const OUTCOME_META: Record<
  Outcome,
  { label: string; description: string; variant: "success" | "warning" | "destructive" | "secondary" }
> = {
  timed_ok: {
    label: "Solid",
    description: "Right when timed and on review — trust it.",
    variant: "success",
  },
  timing_problem: {
    label: "Timing problem",
    description: "Wrong timed, right on review → drill speed.",
    variant: "warning",
  },
  concept_gap: {
    label: "Concept gap",
    description: "Wrong both times → concept review + SRS.",
    variant: "destructive",
  },
  lucky: {
    label: "Lucky guess",
    description: "Right timed, wrong on review → don't trust it.",
    variant: "secondary",
  },
};

// ---------------------------------------------------------------------------
// SRS card origin → friendly label (R7 6.3). The backend tags each card with
// why it entered the review queue; map the known origins to readable text and
// fall back to a Title-Cased form of any unknown value.
// ---------------------------------------------------------------------------
const SRS_ORIGIN_LABELS: Record<string, string> = {
  concept_gap: "Concept gap",
  lucky: "Lucky guess",
  timing_problem: "Timing problem",
  timed_ok: "Solid",
  manual: "Manual",
  flagged: "Flagged",
};

export function srsOriginLabel(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const key = String(origin).trim().toLowerCase();
  if (!key) return null;
  if (SRS_ORIGIN_LABELS[key]) return SRS_ORIGIN_LABELS[key];
  // Title-case an unknown snake_case origin ("foo_bar" -> "Foo bar").
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function difficultyStars(d: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(d)));
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

// ---------------------------------------------------------------------------
// Type-color palette (docs/07 §1.5) — THE highest-impact design artifact.
//
// Okabe–Ito color-blind-safe categorical set, assigned by question-type FAMILY
// (grouping ~17 LR + 9 RC types into families is more legible than 26 hues).
// The brand Verdict violet is intentionally NOT here — it is reserved for UI
// (primary actions, active state) so it never collides with a data category.
// Consume `typeColor()` everywhere a type appears: charts, <TypeBadge>, the
// navigator strip, drill cards, error log.
// ---------------------------------------------------------------------------

export type TypeFamily =
  | "Assumption"
  | "StrengthenWeaken"
  | "FlawStructure"
  | "Inference"
  | "Principle"
  | "Parallel"
  | "Paradox"
  | "RC";

export interface TypeFamilyMeta {
  family: TypeFamily;
  label: string;
  /** Okabe–Ito hex. */
  hex: string;
  /** Whether the swatch needs dark text for legibility (e.g. yellow). */
  darkText: boolean;
}

export const TYPE_FAMILIES: Record<TypeFamily, TypeFamilyMeta> = {
  Assumption: { family: "Assumption", label: "Assumption", hex: "#0072B2", darkText: false },
  StrengthenWeaken: { family: "StrengthenWeaken", label: "Strengthen / Weaken", hex: "#009E73", darkText: true },
  FlawStructure: { family: "FlawStructure", label: "Flaw / Structure", hex: "#D55E00", darkText: true },
  Inference: { family: "Inference", label: "Inference", hex: "#56B4E9", darkText: true },
  Principle: { family: "Principle", label: "Principle", hex: "#E69F00", darkText: true },
  Parallel: { family: "Parallel", label: "Parallel", hex: "#CC79A7", darkText: true },
  Paradox: { family: "Paradox", label: "Paradox", hex: "#F0E442", darkText: true },
  RC: { family: "RC", label: "Reading Comprehension", hex: "#374151", darkText: false },
};

/** Ordered list of families for legends/tables. */
export const TYPE_FAMILY_LIST: TypeFamilyMeta[] = [
  TYPE_FAMILIES.Assumption,
  TYPE_FAMILIES.StrengthenWeaken,
  TYPE_FAMILIES.FlawStructure,
  TYPE_FAMILIES.Inference,
  TYPE_FAMILIES.Principle,
  TYPE_FAMILIES.Parallel,
  TYPE_FAMILIES.Paradox,
  TYPE_FAMILIES.RC,
];

// Every concrete q_type → its family. RC-shared types (MainPoint, Inference)
// are mapped to their LR families; pure-RC types map to RC.
const QTYPE_FAMILY: Record<string, TypeFamily> = {
  // Assumption
  NecessaryAssumption: "Assumption",
  SufficientAssumption: "Assumption",
  // Strengthen / Weaken
  Strengthen: "StrengthenWeaken",
  Weaken: "StrengthenWeaken",
  Evaluate: "StrengthenWeaken",
  StrengthenWeaken: "StrengthenWeaken",
  // Flaw / Structure
  Flaw: "FlawStructure",
  Method: "FlawStructure",
  Role: "FlawStructure",
  PointAtIssue: "FlawStructure",
  Structure: "FlawStructure",
  Function: "FlawStructure",
  // Inference
  Inference: "Inference",
  MostStronglySupported: "Inference",
  MainPoint: "Inference",
  Detail: "Inference",
  // Principle
  PrincipleApply: "Principle",
  PrincipleIdentify: "Principle",
  Application: "Principle",
  // Parallel
  Parallel: "Parallel",
  ParallelFlaw: "Parallel",
  // Paradox
  Paradox: "Paradox",
  // RC-only
  Attitude: "RC",
  Comparative: "RC",
};

/** The family a given q_type belongs to (falls back to RC for unknowns). */
export function typeFamily(qType: QType): TypeFamily {
  return QTYPE_FAMILY[String(qType)] ?? "RC";
}

/** The stable Okabe–Ito hex for a given q_type. Use everywhere. */
export function typeColor(qType: QType): string {
  return TYPE_FAMILIES[typeFamily(qType)].hex;
}

/** Whether a type's color needs dark text laid over it. */
export function typeColorNeedsDarkText(qType: QType): boolean {
  return TYPE_FAMILIES[typeFamily(qType)].darkText;
}
