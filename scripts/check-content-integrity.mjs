/**
 * CONTENT-3 — exploitability gate for the question banks.
 *
 * Coverage validation (scripts/content-validate.mjs) proves every objective has
 * questions attached. It says nothing about whether those questions can actually
 * TEACH, and a template-derived bank passes it perfectly while being worthless:
 * if every correct answer is phrased from one stem and every distractor from
 * another, a candidate learns the tell once and scores 100% without knowing any
 * curriculum. Shuffling option ORDER does not help — the wording is the tell.
 *
 * This gate measures exploitability directly, on the same content the runtime
 * serves:
 *
 *   1. leading-token giveaway — how often the correct option is the only one
 *      whose first word is what it is. That is the exact shortcut a candidate
 *      finds by accident, so it is measured rather than inferred.
 *   2. stem diversity — distinct question stems per question, after masking
 *      digits, to catch "…item 1 / …item 2" families counted as unique items.
 *   3. answer-position balance — a correct index that dominates is its own tell.
 *
 * Thresholds are deliberately permissive: they are meant to catch banks that are
 * systematically generated, not to grade editorial quality. Genuine authored
 * content clears them with room to spare.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { getAuthoredContentPacks } from '../src/domains/cfa/contentPacks.ts';

const LEADING_TOKEN_GIVEAWAY_MAX = 0.35;
const STEM_DIVERSITY_MIN = 0.5;
const ANSWER_POSITION_MAX = 0.5;
const MIN_SAMPLE = 20;

function leadingToken(option) {
  return String(option ?? '')
    .trim()
    .split(/\s+/)[0]
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function maskDigits(stem) {
  return String(stem ?? '')
    .replace(/\d+/g, '#')
    .trim()
    .toLocaleLowerCase('en-US');
}

function analyse(questions) {
  let giveaway = 0;
  let scored = 0;
  const stems = new Map();
  const positions = new Map();

  for (const question of questions) {
    const options = question.options ?? [];
    const correct = question.correct;
    stems.set(maskDigits(question.question), true);

    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) continue;
    scored += 1;
    positions.set(correct, (positions.get(correct) ?? 0) + 1);

    // The giveaway: no distractor shares the correct option's opening word, so
    // the answer is separable without reading past the first token.
    const correctToken = leadingToken(options[correct]);
    const shared = options.some((option, index) => index !== correct && leadingToken(option) === correctToken);
    if (!shared) giveaway += 1;
  }

  const topPosition = Math.max(0, ...positions.values());
  return {
    total: questions.length,
    scored,
    giveawayShare: scored === 0 ? 0 : giveaway / scored,
    stemDiversity: questions.length === 0 ? 1 : stems.size / questions.length,
    uniqueStems: stems.size,
    answerPositionShare: scored === 0 ? 0 : topPosition / scored,
  };
}

function questionsByLevel() {
  const byLevel = new Map();
  for (const pack of getAuthoredContentPacks()) {
    const level = pack.level ?? 'unknown';
    if (!byLevel.has(level)) byLevel.set(level, []);
    // Levels II and III are item-set exams, so their questions hang off vignettes
    // rather than the standalone bank. Both feed the same runtime, so both are
    // measured — scoring only the standalone bank would leave those levels ungated.
    const vignetteItems = (pack.authoredVignettes ?? []).flatMap((vignette) => vignette.questions ?? []);
    byLevel.get(level).push(...(pack.authoredQuestions ?? []), ...vignetteItems);
  }
  return byLevel;
}

export function runContentIntegrityGate() {
  const failures = [];
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  console.log('Content integrity (exploitability gate)');

  for (const [level, questions] of [...questionsByLevel().entries()].sort()) {
    const stats = analyse(questions);
    console.log(
      `  ${level}: ${stats.total} questions, ${stats.uniqueStems} distinct stems | ` +
        `leading-token giveaway ${pct(stats.giveawayShare)} | ` +
        `stem diversity ${pct(stats.stemDiversity)} | ` +
        `top answer position ${pct(stats.answerPositionShare)}`,
    );

    if (stats.scored < MIN_SAMPLE) continue;

    if (stats.giveawayShare > LEADING_TOKEN_GIVEAWAY_MAX) {
      failures.push(
        `${level}: the correct answer is identifiable from its first word alone in ${pct(stats.giveawayShare)} of ` +
          `questions (limit ${pct(LEADING_TOKEN_GIVEAWAY_MAX)}). A candidate can score without knowing the material. ` +
          `Distractors must be phrased so they are indistinguishable from the answer by form.`,
      );
    }
    if (stats.stemDiversity < STEM_DIVERSITY_MIN) {
      failures.push(
        `${level}: only ${stats.uniqueStems} distinct stems across ${stats.total} questions ` +
          `(${pct(stats.stemDiversity)} diversity, floor ${pct(STEM_DIVERSITY_MIN)}). Items that differ only by an ` +
          `index number are one item, and spaced repetition over them teaches nothing.`,
      );
    }
    if (stats.answerPositionShare > ANSWER_POSITION_MAX) {
      failures.push(
        `${level}: one answer position holds ${pct(stats.answerPositionShare)} of correct answers ` +
          `(limit ${pct(ANSWER_POSITION_MAX)}).`,
      );
    }
  }

  if (failures.length === 0) {
    console.log('check-content-integrity: OK');
    return true;
  }

  console.error('check-content-integrity: FAILED');
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error(
    'These banks are template-derived scaffolding, not exam-ready content. Until they are ' +
      'editorially replaced, the runtime must not advertise them as exam-ready.',
  );
  return false;
}

// Also runnable on its own for a focused content check. pathToFileURL is required
// rather than string-building the URL: on Windows a drive path yields file:///E:/…
// with three slashes, so a hand-built file://… never matches and the gate silently
// no-ops when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!runContentIntegrityGate()) process.exitCode = 1;
}
