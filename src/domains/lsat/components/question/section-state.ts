import type { Highlight } from "@lsat/components/question/highlightable-text";

/**
 * One process-of-elimination interaction. `order_index` is the position in the
 * per-question event sequence; `time_ms` is the time since the question first
 * opened. Mirrors the backend `ChoiceEvent` wire shape.
 */
export interface ChoiceEventRecord {
  label: string;
  action: "select" | "eliminate" | "restore";
  order_index: number;
  time_ms: number;
}

export interface QState {
  answer: string | null;
  eliminated: Set<string>;
  flagged: boolean;
  timeMs: number;
  highlights: Highlight[];
  /** The user's process-of-elimination trace for this question. */
  choiceEvents: ChoiceEventRecord[];
}

export function blankState(): QState {
  return {
    answer: null,
    eliminated: new Set(),
    flagged: false,
    timeMs: 0,
    highlights: [],
    choiceEvents: [],
  };
}
