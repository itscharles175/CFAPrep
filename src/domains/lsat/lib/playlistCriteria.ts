// Smart-set (playlist) criteria model + serialization.
//
// The backend smart-set `criteria` is a free-form object (PlaylistCreate.criteria
// is `{[k: string]: unknown}`); the supported keys are documented in the R7
// roadmap and verified against the playlists router:
//   q_type, section_type, source, difficulty, flagged(bool),
//   outcome(concept_gap|lucky|timing_problem|timed_ok),
//   preptest_ids, preptest_name_contains, passage_type,
//   incorrect_only(bool), limit
//
// This module is the single source of truth for turning the UI builder state
// into the wire `criteria` object (and a human-readable summary). It is pure so
// it is unit-tested directly (see playlistCriteria.test.ts).

import type { Outcome, SectionType } from "./types";
import { qTypeLabel } from "./labels";

/** UI-side draft of a smart-set's criteria. Everything optional/"any". */
export interface CriteriaDraft {
  sectionType?: SectionType | "any";
  qType?: string; // q_type or "any"
  source?: "real" | "ai" | "any" | "official";
  difficulty?: number | "any"; // 1..5
  outcome?: Outcome | "any";
  flagged?: boolean;
  incorrectOnly?: boolean;
  preptestNameContains?: string;
  passageType?: string;
  limit?: number;
}

export const EMPTY_CRITERIA: CriteriaDraft = {
  sectionType: "any",
  qType: "any",
  source: "any",
  difficulty: "any",
  outcome: "any",
  flagged: false,
  incorrectOnly: false,
  preptestNameContains: "",
  passageType: "",
  limit: 20,
};

/** Outcome options offered in the builder, with friendly labels. */
export const CRITERIA_OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "concept_gap", label: "Concept gap" },
  { value: "lucky", label: "Lucky guess" },
  { value: "timing_problem", label: "Timing problem" },
  { value: "timed_ok", label: "Solid (timed ok)" },
];

/** The wire criteria object — only meaningful (non-"any"/non-empty) keys. */
export type WireCriteria = Record<string, unknown>;

function isAny(v: unknown): boolean {
  return v == null || v === "any" || v === "";
}

/**
 * Build the backend `criteria` payload from the UI draft. Drops every key left
 * at its "any"/empty/false default so the smart set only constrains what the
 * user actually picked. `limit` is clamped to a sane 1..200 range when present.
 */
export function buildCriteria(draft: CriteriaDraft): WireCriteria {
  const out: WireCriteria = {};
  if (!isAny(draft.sectionType)) out.section_type = draft.sectionType;
  if (!isAny(draft.qType)) out.q_type = draft.qType;
  if (!isAny(draft.source)) out.source = draft.source;
  if (!isAny(draft.difficulty)) out.difficulty = Number(draft.difficulty);
  if (!isAny(draft.outcome)) out.outcome = draft.outcome;
  if (draft.flagged) out.flagged = true;
  if (draft.incorrectOnly) out.incorrect_only = true;
  const name = draft.preptestNameContains?.trim();
  if (name) out.preptest_name_contains = name;
  const passage = draft.passageType?.trim();
  if (passage) out.passage_type = passage;
  if (draft.limit != null && Number.isFinite(draft.limit)) {
    const lim = Math.max(1, Math.min(200, Math.round(draft.limit)));
    out.limit = lim;
  }
  return out;
}

/** Inverse of {@link buildCriteria} — hydrate a draft from a saved criteria. */
export function criteriaToDraft(criteria: WireCriteria | null | undefined): CriteriaDraft {
  const c = criteria ?? {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
  return {
    sectionType: (c.section_type as SectionType) ?? "any",
    qType: (c.q_type as string) ?? "any",
    source: (c.source as CriteriaDraft["source"]) ?? "any",
    difficulty: num(c.difficulty) ?? "any",
    outcome: (c.outcome as Outcome) ?? "any",
    flagged: c.flagged === true,
    incorrectOnly: c.incorrect_only === true,
    preptestNameContains: typeof c.preptest_name_contains === "string" ? c.preptest_name_contains : "",
    passageType: typeof c.passage_type === "string" ? c.passage_type : "",
    limit: num(c.limit) ?? 20,
  };
}

/**
 * A short human summary of a saved criteria object (for list rows / chips).
 * Returns "All questions" when nothing constrains the set.
 */
export function summarizeCriteria(criteria: WireCriteria | null | undefined): string {
  const c = criteria ?? {};
  const parts: string[] = [];
  if (typeof c.section_type === "string") parts.push(c.section_type);
  if (typeof c.q_type === "string") parts.push(qTypeLabel(c.q_type));
  if (typeof c.source === "string") {
    const src =
      c.source === "real" || c.source === "official"
        ? "Official"
        : c.source === "ai"
          ? "AI-generated"
          : String(c.source);
    parts.push(src);
  }
  const diff = c.difficulty;
  if (typeof diff === "number" || (typeof diff === "string" && diff !== "")) {
    parts.push("★".repeat(Math.max(0, Math.min(5, Number(diff)))));
  }
  if (typeof c.outcome === "string") {
    const o = CRITERIA_OUTCOMES.find((x) => x.value === c.outcome);
    parts.push(o ? o.label : String(c.outcome));
  }
  if (c.flagged === true) parts.push("Flagged");
  if (c.incorrect_only === true) parts.push("Incorrect only");
  if (typeof c.preptest_name_contains === "string" && c.preptest_name_contains.trim())
    parts.push(`PT "${c.preptest_name_contains.trim()}"`);
  if (typeof c.passage_type === "string" && c.passage_type.trim())
    parts.push(c.passage_type.trim());
  const summary = parts.join(" · ");
  const base = summary || "All questions";
  if (typeof c.limit === "number" && c.limit > 0) return `${base} · up to ${c.limit}`;
  return base;
}
