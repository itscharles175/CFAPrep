/**
 * 128K-aware context budgeting for Gemma 4 E4B.
 *
 * Why this exists:
 *   The local LLM (Gemma 4 E4B at LM Studio) advertises a 128K context, but
 *   `lms load -c 32768` is the realistic default and longer contexts trigger
 *   the "Context size has been exceeded" model crash we hit during content
 *   expansion.  Every caller that stuffs curriculum chunks into a prompt
 *   needs a deterministic budget so prompts stay below a working ceiling.
 *
 * This module:
 *   - estimates token counts cheaply (no tokenizer download required)
 *   - packs an ordered list of chunks under a budget, dropping from the
 *     END when the budget is exceeded (FIFO chronological preservation —
 *     callers should pre-sort by salience)
 *   - exposes a 'profile' helper that picks a sensible budget from the
 *     active model name + a safety margin
 *
 * The token estimator is the standard "GPT-style" 4-chars-per-token
 * heuristic plus an explicit overhead for tokenizer-special chars
 * (newlines/tabs cost ~1 token each, code blocks cost more, etc).  It is
 * deliberately a slight overcount so the budget has headroom.
 *
 * Storage: there's no state — pure functions.  No cross-module imports
 * that drag the LLM client into module init.
 */

export const TOKENS_PER_CHAR = 0.28;

export interface ContextBudget {
  /** Total tokens the prompt may consume (system + user combined). */
  total: number;
  /** Reserved for the model's response. */
  reservedForResponse: number;
  /** What's left for the user message + grounding excerpts. */
  forUserAndGrounding: number;
}

export interface PackedExcerpts<T> {
  kept: T[];
  dropped: T[];
  estimatedTokens: number;
}

/** Coarse but conservative token estimator. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Base estimate: char-based.
  let tokens = Math.ceil(text.length * TOKENS_PER_CHAR);
  // Newlines and tabs round up to whole tokens.
  const newlineHits = (text.match(/\n/g) || []).length;
  tokens += Math.ceil(newlineHits * 0.5);
  // Code-block fences usually each cost 1 token.
  const fenceHits = (text.match(/```/g) || []).length;
  tokens += fenceHits;
  // Long URLs are token-heavy.
  const urlHits = (text.match(/https?:\/\/\S+/g) || []).length;
  tokens += urlHits * 2;
  return tokens;
}

/**
 * Pick a budget from the model name + an explicit override path.
 *
 * Rules:
 *   - If the user has overridden `contextWindow` (in settings.contextWindow),
 *     respect that exactly.
 *   - Otherwise infer from the model name suffix '-cw32768' / '-cw131072' if
 *     present; fall back to 32768 (Gemma 4 E4B's LM Studio default).
 *   - Reserve `min(8192, total * 0.25)` tokens for the response.
 *   - Reserve ~256 tokens for system-prompt overhead.
 */
export function pickBudget(opts: { modelName?: string; contextWindow?: number; reservedForResponse?: number } = {}): ContextBudget {
  let total = opts.contextWindow ?? inferContextWindowFromName(opts.modelName);
  total = Math.max(2048, Math.floor(total));

  const reservedForResponse =
    typeof opts.reservedForResponse === 'number'
      ? Math.max(256, Math.floor(opts.reservedForResponse))
      : Math.min(8192, Math.floor(total * 0.25));

  const SYSTEM_OVERHEAD = 256;
  const forUserAndGrounding = Math.max(512, total - reservedForResponse - SYSTEM_OVERHEAD);

  return { total, reservedForResponse, forUserAndGrounding };
}

function inferContextWindowFromName(name?: string): number {
  if (!name) return 32768;
  const lower = name.toLowerCase();
  // LM Studio model-list often suffixes with -cw{n} or -ctx{n}.
  const match = lower.match(/(?:-cw|-ctx|@|-)(\d{4,6})\b/);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n >= 2048) return n;
  }
  if (lower.includes('128k')) return 131072;
  if (lower.includes('32k')) return 32768;
  if (lower.includes('16k')) return 16384;
  if (lower.includes('8k')) return 8192;
  return 32768;
}

/**
 * Pack an ordered list of excerpt-like items under `budget` tokens.
 * Drops from the END of the list (callers pre-sort by salience so the
 * top items survive).  Each item exposes the text via `textOf`.
 */
export function packExcerpts<T>(
  items: T[],
  budget: number,
  textOf: (item: T) => string,
): PackedExcerpts<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  let used = 0;
  for (const item of items) {
    const text = textOf(item) || '';
    const cost = estimateTokens(text);
    if (used + cost <= budget) {
      kept.push(item);
      used += cost;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped, estimatedTokens: used };
}

/**
 * Helper for callers that want to render the kept excerpts into a single
 * grounded-context string, the same shape every caller uses today:
 *   [locator] text\n\ntext\n\n…
 */
export function renderExcerpts<T>(
  items: T[],
  locatorOf: (item: T) => string | undefined,
  textOf: (item: T) => string,
): string {
  return items
    .map((item) => {
      const loc = locatorOf(item);
      const text = textOf(item);
      return loc ? `[${loc}] ${text}` : text;
    })
    .join('\n\n');
}
