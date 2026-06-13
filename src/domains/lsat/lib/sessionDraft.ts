/**
 * Durable in-progress session drafts (R7 Wave-5 1.5).
 *
 * The shared SectionRunner keeps the live per-question state (answers,
 * eliminations, highlights, per-question timers, flags) plus the current
 * question index and the remaining time in component state. Before this module
 * that state was lost on a refresh/crash mid-section — only a resume *pointer*
 * (path + index) survived.
 *
 * We persist the full state to localStorage, keyed per section/session, debounced
 * on change, and rehydrate it on mount. The draft is cleared once the section is
 * finished/submitted.
 *
 * Key scheme: `lsatlab.sessionDraft.<scope>` where <scope> is a stable id built
 * by the caller. We anchor the scope on the *section id* (always known on first
 * mount) rather than the session id, which can arrive asynchronously — this
 * keeps the scope constant across the null→id transition so we never orphan a
 * draft under the old key:
 *   - standalone section:   `section:<sectionId>`
 *   - full exam section:    `exam:<sectionId>`
 * Each section of a multi-section exam therefore gets its own draft and they
 * never collide. The session id (when present) is recorded inside the payload
 * for diagnostics only.
 */

import type { ChoiceEventRecord, QState } from "@/components/question/section-runner";
import type { Highlight } from "@/components/question/highlightable-text";

const PREFIX = "lsatlab.sessionDraft.";

/** Bump if the persisted shape changes incompatibly. */
const DRAFT_VERSION = 1;

/** Drafts older than this are considered stale and ignored/cleared on read. */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** JSON-safe mirror of QState (Set<string> → string[]). */
interface SerializedQState {
  answer: string | null;
  eliminated: string[];
  flagged: boolean;
  timeMs: number;
  highlights: Highlight[];
  /** 1.2 — process-of-elimination trace (already JSON-safe). */
  choiceEvents?: ChoiceEventRecord[];
}

interface SessionDraft {
  v: number;
  /** Per-question state, keyed by question index (matches the runner). */
  states: Record<number, SerializedQState>;
  /** Current question index. */
  index: number;
  /** Seconds left on the section clock at the last save (null = untimed). */
  timeLeft: number | null;
  updatedAt: number;
}

/** Stable draft scope for a standalone section run. */
export function draftKeyForSection(sectionId: number): string {
  return `section:${sectionId}`;
}

/** Stable draft scope for one section of a full exam. */
export function draftKeyForExamSection(sectionId: number): string {
  return `exam:${sectionId}`;
}

function storageKey(scope: string): string {
  return `${PREFIX}${scope}`;
}

function serializeStates(
  states: Record<number, QState>,
): Record<number, SerializedQState> {
  const out: Record<number, SerializedQState> = {};
  for (const [k, s] of Object.entries(states)) {
    out[Number(k)] = {
      answer: s.answer,
      eliminated: Array.from(s.eliminated),
      flagged: s.flagged,
      timeMs: s.timeMs,
      highlights: s.highlights,
      choiceEvents: s.choiceEvents,
    };
  }
  return out;
}

function deserializeStates(
  states: Record<number, SerializedQState>,
): Record<number, QState> {
  const out: Record<number, QState> = {};
  for (const [k, s] of Object.entries(states)) {
    out[Number(k)] = {
      answer: s.answer ?? null,
      eliminated: new Set(Array.isArray(s.eliminated) ? s.eliminated : []),
      flagged: !!s.flagged,
      timeMs: typeof s.timeMs === "number" ? s.timeMs : 0,
      highlights: Array.isArray(s.highlights) ? s.highlights : [],
      choiceEvents: Array.isArray(s.choiceEvents) ? s.choiceEvents : [],
    };
  }
  return out;
}

export interface RehydratedDraft {
  states: Record<number, QState>;
  index: number;
  timeLeft: number | null;
}

/** Read + rehydrate a draft. Returns null when absent, stale, or unparsable. */
export function loadSessionDraft(scope: string): RehydratedDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionDraft>;
    if (parsed.v !== DRAFT_VERSION || typeof parsed.updatedAt !== "number") {
      return null;
    }
    if (Date.now() - parsed.updatedAt > MAX_AGE_MS) {
      clearSessionDraft(scope);
      return null;
    }
    return {
      states: deserializeStates(parsed.states ?? {}),
      index: typeof parsed.index === "number" ? parsed.index : 0,
      timeLeft:
        parsed.timeLeft === null || typeof parsed.timeLeft === "number"
          ? (parsed.timeLeft ?? null)
          : null,
    };
  } catch {
    return null;
  }
}

export function saveSessionDraft(
  scope: string,
  draft: { states: Record<number, QState>; index: number; timeLeft: number | null },
): void {
  try {
    const payload: SessionDraft = {
      v: DRAFT_VERSION,
      states: serializeStates(draft.states),
      index: draft.index,
      timeLeft: draft.timeLeft,
      updatedAt: Date.now(),
    };
    localStorage.setItem(storageKey(scope), JSON.stringify(payload));
  } catch {
    /* ignore quota / serialization errors — drafts are best-effort */
  }
}

export function clearSessionDraft(scope: string): void {
  try {
    localStorage.removeItem(storageKey(scope));
  } catch {
    /* ignore */
  }
}
