/**
 * GAP-ENTAIL-1 — the ONE shared groundedness / entailment primitive.
 *
 * Wave 5 needs a single place that answers "does this evidence support this
 * claim?" for both halves of the grounding story:
 *
 *   - RAG-4 (citation-faithfulness): per-claim entailment over the cited chunks
 *     so a generated answer can be REFUSED when a claim isn't supported.
 *   - AI-2 contentGate seam (`groundednessFn`): generated questions/flashcards
 *     reuse the SAME entailment instead of a bespoke token-overlap heuristic.
 *
 * Contract: `entail(claim, evidence) -> { entailed, score, method }` where
 *   - `score` is in [0,1] — higher means "more supported",
 *   - `entailed` is `score >= threshold`,
 *   - `method` records which path produced it ('llm' | 'lexical' | 'empty').
 *
 * OFFLINE-FIRST (hard rule): the local-LLM NLI call is best-effort. When no
 * model server is reachable — or the model returns garbage — we DEGRADE to a
 * deterministic lexical-overlap score and NEVER throw on the no-network path.
 * This keeps every caller (the gate, the verifier) usable fully offline; the
 * LLM only RAISES the bar when it happens to be running.
 *
 * Determinism: the lexical fallback is a pure function of its inputs, and the
 * LLM path pins temperature=0 + a tiny token budget, so repeated calls over the
 * same (claim, evidence) are stable enough for the eval harness. Tests inject a
 * mock `generate` so they never touch a server.
 */

import { generateText } from '../localLlm';

/** Result of an entailment check. */
export interface EntailmentResult {
  /** True when `score >= threshold`. */
  entailed: boolean;
  /** Support strength in [0,1] — higher is better supported. */
  score: number;
  /** Which path produced the score. */
  method: 'llm' | 'lexical' | 'empty';
}

/** A generator compatible with {@link generateText} (the test seam). */
export type EntailmentGenerate = (input: {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  settings?: { baseUrl?: string; model?: string; contextWindow?: number };
  signal?: AbortSignal;
}) => Promise<{ text: string }>;

export interface EntailmentOptions {
  /** `score >= threshold` ⇒ entailed. Default 0.5. */
  threshold?: number;
  /**
   * Use the local LLM NLI judge as the primary signal (default `true`). When
   * `false`, or when the LLM is unreachable/unparseable, the lexical fallback is
   * used. Tests + the eval harness flip this off for determinism.
   */
  useLlm?: boolean;
  /** Override the generator (tests). Defaults to the host {@link generateText}. */
  generate?: EntailmentGenerate;
  /** LLM settings override (baseUrl/model/contextWindow). */
  settings?: { baseUrl?: string; model?: string; contextWindow?: number };
  signal?: AbortSignal;
}

export const DEFAULT_ENTAILMENT_THRESHOLD = 0.5;

// Common English stopwords + study-boilerplate that carry no grounding signal.
// Kept in lock-step with contentGate.js's STOPWORDS so the lexical fallback and
// the gate's legacy heuristic agree on what counts as "salient".
const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at for with without by from as is are was were be been being ' +
    'this that these those it its which who whom whose what when where why how all any each every both few more ' +
    'most other some such no nor not only own same so than too very can will just should now about into over under ' +
    'question following best correct answer option options explanation true false none above'
  ).split(/\s+/),
);

/** Normalise text into a set of salient lowercase tokens (>=3 chars, no stopwords). */
export function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  if (typeof text !== 'string') return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Deterministic lexical-overlap support score in [0,1]: the fraction of the
 * CLAIM's salient tokens that also appear in the EVIDENCE. A claim every token
 * of which is in the evidence scores 1; an unrelated claim scores 0.
 *
 * Edge cases (mirrors contentGate.tokenOverlapGroundedness so the seam swap is
 * behaviour-compatible): empty evidence ⇒ 1 (nothing to ground against, don't
 * penalise); a claim with no salient tokens ⇒ 1 (not assessable, don't
 * penalise — shape checks catch genuinely empty content elsewhere).
 */
export function lexicalEntailmentScore(claim: string, evidence: string): number {
  const ev = salientTokens(evidence);
  if (ev.size === 0) return 1;
  const claimTokens = salientTokens(claim);
  if (claimTokens.size === 0) return 1;
  let hit = 0;
  for (const t of claimTokens) if (ev.has(t)) hit += 1;
  return hit / claimTokens.size;
}

const NLI_SYSTEM = [
  'You are a strict natural-language-inference judge for an exam-prep tutor.',
  'Decide whether the EVIDENCE supports the CLAIM.',
  'Respond with ONLY a number from 0 to 100: 100 = the evidence fully entails the claim,',
  '0 = the evidence contradicts or is unrelated to the claim. No words, just the number.',
].join(' ');

/** Pull the first 0..100 integer out of a model reply; null when none/invalid. */
function parseNliScore(text: string): number | null {
  if (typeof text !== 'string') return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  // Clamp to [0,100] then map to [0,1].
  return Math.max(0, Math.min(100, n)) / 100;
}

/**
 * The shared entailment primitive. Returns the support of `evidence` for
 * `claim` as `{ entailed, score, method }`.
 *
 * Resolution order:
 *   1. Empty claim AND empty evidence ⇒ trivially entailed (score 1, 'empty').
 *   2. If `useLlm` (default), try the local-LLM NLI judge (temp 0, tiny budget).
 *      A parseable 0..100 reply ⇒ `method:'llm'`.
 *   3. ANY LLM failure (offline, CORS, timeout, unparseable) ⇒ fall through to
 *      the deterministic lexical score ⇒ `method:'lexical'`. NEVER throws on the
 *      offline path.
 */
export async function entail(
  claim: string,
  evidence: string,
  options: EntailmentOptions = {},
): Promise<EntailmentResult> {
  const threshold = options.threshold ?? DEFAULT_ENTAILMENT_THRESHOLD;
  const claimText = (claim ?? '').trim();
  const evidenceText = (evidence ?? '').trim();

  if (!claimText && !evidenceText) {
    return { entailed: true, score: 1, method: 'empty' };
  }

  const useLlm = options.useLlm !== false;
  if (useLlm && claimText) {
    const generate = options.generate ?? (generateText as unknown as EntailmentGenerate);
    try {
      const { text } = await generate({
        prompt: `CLAIM:\n${claimText}\n\nEVIDENCE:\n${evidenceText || '(none)'}\n\nScore (0-100):`,
        system: NLI_SYSTEM,
        temperature: 0,
        maxTokens: 8,
        settings: options.settings,
        signal: options.signal,
      });
      const score = parseNliScore(text);
      if (score !== null) {
        return { entailed: score >= threshold, score, method: 'llm' };
      }
      // Unparseable reply — fall through to the deterministic fallback.
    } catch {
      // Offline / CORS / timeout — degrade gracefully. NEVER rethrow here.
    }
  }

  const score = lexicalEntailmentScore(claimText, evidenceText);
  return { entailed: score >= threshold, score, method: 'lexical' };
}

/**
 * A {@link contentGate} `groundednessFn`-shaped adapter (sync, returns a 0..1
 * score) backed by the SHARED lexical entailment. This is what wires
 * GAP-ENTAIL-1 into the AI-2 gate's seam WITHOUT making the gate async: the gate
 * stays synchronous + offline, but now scores grounding through the same token
 * model the entailment service uses, so the two never drift.
 *
 * For the heavier async LLM-backed grounding (used by the RAG-4 verifier) call
 * {@link entail} directly.
 */
export function lexicalGroundednessFn(content: string, context: string): number {
  return lexicalEntailmentScore(content, context);
}
