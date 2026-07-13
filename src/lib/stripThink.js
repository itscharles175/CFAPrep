// AI-8 host think-tag / reasoning-trace filter.
//
// Reasoning-capable local models (qwen3, deepseek-r1, etc.) emit a
// chain-of-thought block before the user-facing answer. The lsat-backend
// strips this server-side (see services/lsat-backend/app/ai.py `strip_think`),
// but the host's localLlm.js historically returned the raw completion verbatim,
// so reasoning traces could leak into flashcards, explanations, summaries, and
// — worst of all — the spoken coach (TTS reading the model's private thoughts
// aloud).
//
// `stripThink(text)` removes those blocks robustly. It mirrors the backend's
// behaviour (complete blocks, then dangling open/close tags) and goes further
// to cover the failure modes a local host actually sees:
//
//   - <think>...</think>           the canonical block (qwen3)
//   - <reasoning>...</reasoning>   a common variant
//   - <think> with NO close tag    truncated / streamed-and-cut output: we drop
//                                  everything from the open tag to end-of-text
//                                  rather than leaking the whole trace
//   - case-insensitive, multiline  <THINK>, mixed case, blocks spanning newlines
//   - leading ```thinking fences   some models wrap reasoning in a fenced code
//                                  block (```thinking / ```reasoning / ```think)
//                                  at the very start of the reply
//
// It is deliberately conservative: it never touches text outside a recognised
// reasoning construct, so ordinary answers (including ones that merely mention
// the word "think") pass through unchanged.

// Tag names we treat as reasoning wrappers.
const REASONING_TAGS = ['think', 'reasoning', 'thought', 'thinking'];
const TAG_ALT = REASONING_TAGS.join('|');

// Open / close reasoning tags, for the depth-aware scanner below. We don't use a
// single paired regex because reasoning models sometimes emit NESTED same-name
// tags (`<think> ... <think> ... </think> ... </think>`); a non-greedy paired
// regex would close on the first inner `</think>` and leak the outer remainder.
const ANY_TAG_RE = new RegExp(`<(/?)(?:${TAG_ALT})\\b[^>]*>`, 'gi');

/**
 * Remove balanced <tag>...</tag> reasoning regions, honouring nesting depth so a
 * nested same-name block is consumed as part of its outer block (not leaked). An
 * UNbalanced open tail (open without a matching close) is left in place — step 3
 * of stripThink drops it to end-of-text. A stray leading close is also left for
 * the stray-tag sweep. Text outside any reasoning region is preserved verbatim.
 */
function removeBalancedReasoning(text) {
  ANY_TAG_RE.lastIndex = 0;
  let result = '';
  let cursor = 0; // start of the not-yet-emitted slice of `text`
  let depth = 0;
  let regionStart = -1; // index of the outermost open tag while depth > 0
  let m;
  while ((m = ANY_TAG_RE.exec(text)) !== null) {
    const isClose = m[1] === '/';
    if (!isClose) {
      if (depth === 0) {
        // Entering a reasoning region: emit everything before it, mark its start.
        result += text.slice(cursor, m.index);
        regionStart = m.index;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        // Closed the outermost open: drop the whole region, resume after it.
        cursor = ANY_TAG_RE.lastIndex;
        regionStart = -1;
      }
    }
    // A close tag at depth 0 is stray markup — leave it for the stray sweep.
  }
  if (depth > 0 && regionStart >= 0) {
    // Unbalanced open region: the pre-region prefix was already emitted when we
    // entered it. Re-attach the open tag + its tail (verbatim) so the dangling-
    // open pass in stripThink can drop them to end-of-text.
    result += text.slice(regionStart);
  } else {
    result += text.slice(cursor);
  }
  return result;
}

// A dangling OPEN tag with no matching close: drop from the tag to end-of-text.
// Reasoning models stream the trace first, so an unclosed <think> means the
// answer was cut off mid-thought — there is nothing user-facing to keep after it.
const OPEN_TO_END_RE = new RegExp(`<(?:${TAG_ALT})\\b[^>]*>[\\s\\S]*$`, 'i');

// Any remaining stray open OR close tags (e.g. a lone </think> at the start
// after the paired pass, or self-noise). These are pure markup, never content.
const STRAY_TAG_RE = new RegExp(`</?(?:${TAG_ALT})\\b[^>]*>`, 'gi');

// A leading fenced reasoning block: ```thinking ... ``` at the very start of the
// reply (optionally preceded by whitespace). Only the FIRST fence is treated as
// reasoning — a fenced block later in the answer is assumed to be legitimate
// content (e.g. a code sample). Case-insensitive; the language tag must be one
// of our reasoning words.
const LEADING_FENCE_RE = new RegExp(
  `^\\s*\`\`\`(?:${TAG_ALT})[^\\n]*\\n[\\s\\S]*?(?:\`\`\`|$)`,
  'i',
);

/**
 * Strip chain-of-thought / reasoning traces from user-facing model text.
 *
 * Removes <think>...</think> (and <reasoning>/<thought>/<thinking>) blocks,
 * unterminated open reasoning tags (dropped to end-of-text), stray reasoning
 * tags, and a leading ```thinking fenced block. Case-insensitive and multiline.
 * Non-string input returns an empty string; ordinary answers are returned
 * trimmed and otherwise untouched.
 *
 * @param {string} text - Raw model completion text.
 * @returns {string} The cleaned, user-safe text (trimmed).
 */
export function stripThink(text) {
  if (typeof text !== 'string' || text === '') return '';

  let out = text;

  // 1. Strip a leading fenced reasoning block first, so its inner backticks
  //    can't confuse later passes.
  out = out.replace(LEADING_FENCE_RE, '');

  // 2. Remove all balanced <tag>...</tag> reasoning regions (nesting-aware).
  out = removeBalancedReasoning(out);

  // 3. A dangling OPEN tag with no close = truncated reasoning. Drop it and
  //    everything after it (there is no trustworthy answer past an unclosed
  //    reasoning block).
  out = out.replace(OPEN_TO_END_RE, '');

  // 4. Sweep any remaining stray reasoning tags (e.g. a leftover lone close).
  out = out.replace(STRAY_TAG_RE, '');

  return out.trim();
}

const LEADING_FENCE_HEADER_RE = new RegExp(
  `^\\s*\`\`\`(?:${TAG_ALT})[^\\n]*\\n`,
  'i',
);

function findNextReasoningTag(text) {
  const re = new RegExp(`<(/?)(?:${TAG_ALT})\\b[^>]*>`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    end: m.index + m[0].length,
    isClose: m[1] === '/',
  };
}

function isPotentialReasoningTagPrefix(text, index) {
  const tail = text.slice(index).toLowerCase();
  if (!tail.startsWith('<') || tail.includes('>')) return false;

  let rest = tail.slice(1);
  if (rest.startsWith('/')) rest = rest.slice(1);
  if (!rest) return true;

  return REASONING_TAGS.some((tag) => {
    if (tag.startsWith(rest)) return true;
    if (!rest.startsWith(tag)) return false;
    const next = rest[tag.length];
    return next === undefined || /\s|\//.test(next);
  });
}

function findPotentialReasoningTagPrefix(text) {
  for (let index = text.lastIndexOf('<'); index >= 0; index = text.lastIndexOf('<', index - 1)) {
    if (isPotentialReasoningTagPrefix(text, index)) return index;
  }
  return -1;
}

function splitOutsideReasoning(text) {
  const partial = findPotentialReasoningTagPrefix(text);
  if (partial < 0) return { emit: text, hold: '' };
  return { emit: text.slice(0, partial), hold: text.slice(partial) };
}

function keepPossibleClosingFence(text) {
  if (text.endsWith('``')) return '``';
  if (text.endsWith('`')) return '`';
  return '';
}

function isPotentialLeadingFencePrefix(text) {
  const tail = text.replace(/^\s+/, '').toLowerCase();
  if (!tail) return true;
  if (!tail.startsWith('```')) return '`'.repeat(Math.min(tail.length, 3)).startsWith(tail);
  const header = tail.slice(3);
  if (!header) return true;
  const lineEnd = header.indexOf('\n');
  const headerPart = lineEnd >= 0 ? header.slice(0, lineEnd) : header;
  if (!headerPart) return true;
  return REASONING_TAGS.some((tag) => tag.startsWith(headerPart) || (lineEnd < 0 && headerPart.startsWith(tag)));
}

/**
 * Create a stateful filter for streaming model deltas.
 *
 * `stripThink()` is intentionally a completed-text cleaner. Streamed deltas can
 * split a tag (`<thi` + `nk>`) or a closing tag (`</thi` + `nk>`), so callers
 * need a small parser that buffers ambiguous tails instead of forwarding raw
 * chunks to live UI/TTS consumers.
 */
export function createThinkStreamFilter() {
  let buffer = '';
  let depth = 0;
  let atStart = true;
  let droppingLeadingFence = false;

  function processLeadingFence() {
    if (!atStart || depth > 0) return 'none';

    if (droppingLeadingFence) {
      const closeIndex = buffer.indexOf('```');
      if (closeIndex < 0) {
        buffer = keepPossibleClosingFence(buffer);
        return 'hold';
      }
      buffer = buffer.slice(closeIndex + 3).replace(/^\r?\n/, '');
      droppingLeadingFence = false;
      atStart = false;
      return 'handled';
    }

    const header = buffer.match(LEADING_FENCE_HEADER_RE);
    if (header) {
      buffer = buffer.slice(header[0].length);
      droppingLeadingFence = true;
      return 'handled';
    }

    if (isPotentialLeadingFencePrefix(buffer)) return 'hold';
    atStart = false;
    return 'none';
  }

  function feed(chunk) {
    if (typeof chunk !== 'string' || chunk === '') return '';
    buffer += chunk;
    let out = '';

    while (buffer) {
      const fenceState = processLeadingFence();
      if (fenceState === 'hold') break;
      if (fenceState === 'handled') continue;

      const tag = findNextReasoningTag(buffer);
      if (depth > 0) {
        if (!tag) {
          const partial = findPotentialReasoningTagPrefix(buffer);
          buffer = partial >= 0 ? buffer.slice(partial) : '';
          break;
        }
        depth += tag.isClose ? -1 : 1;
        if (depth < 0) depth = 0;
        buffer = buffer.slice(tag.end);
        continue;
      }

      if (!tag) {
        const split = splitOutsideReasoning(buffer);
        out += split.emit;
        buffer = split.hold;
        break;
      }

      out += buffer.slice(0, tag.index);
      buffer = buffer.slice(tag.end);
      if (!tag.isClose) depth = 1;
    }

    return out;
  }

  function flush() {
    if (droppingLeadingFence || depth > 0) {
      buffer = '';
      depth = 0;
      atStart = false;
      droppingLeadingFence = false;
      return '';
    }

    if (atStart && isPotentialLeadingFencePrefix(buffer)) {
      buffer = '';
      atStart = false;
      return '';
    }

    const split = splitOutsideReasoning(buffer);
    buffer = '';
    atStart = false;
    return split.emit;
  }

  return { feed, flush };
}

export default stripThink;
