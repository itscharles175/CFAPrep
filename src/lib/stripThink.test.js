import { describe, it, expect } from 'vitest';
import { createThinkStreamFilter, stripThink } from './stripThink';

describe('stripThink', () => {
  it('removes a simple <think>...</think> block', () => {
    const input = '<think>let me reason</think>The answer is 42.';
    expect(stripThink(input)).toBe('The answer is 42.');
  });

  it('keeps text before and after the block', () => {
    const input = 'Before. <think>private reasoning</think> After.';
    expect(stripThink(input)).toBe('Before.  After.');
  });

  it('passes ordinary text through unchanged (trimmed)', () => {
    expect(stripThink('  Just a normal answer.  ')).toBe('Just a normal answer.');
  });

  it('does NOT touch the word "think" in prose', () => {
    const input = 'I think the discount rate matters here.';
    expect(stripThink(input)).toBe('I think the discount rate matters here.');
  });

  it('is case-insensitive on the tag name', () => {
    expect(stripThink('<THINK>noise</THINK>visible')).toBe('visible');
    expect(stripThink('<Think>noise</Think>visible')).toBe('visible');
  });

  it('handles multiline reasoning blocks', () => {
    const input = '<think>\nstep 1\nstep 2\nstep 3\n</think>\nFinal answer.';
    expect(stripThink(input)).toBe('Final answer.');
  });

  it('drops an UNCLOSED <think> tag to end-of-text', () => {
    const input = 'Visible intro.\n<think>reasoning that never closes because output was cut';
    expect(stripThink(input)).toBe('Visible intro.');
  });

  it('drops an unclosed tag even when it is the whole output', () => {
    expect(stripThink('<think>only reasoning, truncated')).toBe('');
  });

  it('removes multiple separate blocks', () => {
    const input = '<think>a</think>One. <think>b</think>Two.';
    // input has one space (after "One.") and none before "Two.", so removing both
    // blocks yields a single space — not two. The block contents never merge.
    expect(stripThink(input)).toBe('One. Two.');
  });

  it('handles nested / repeated open tags inside a block', () => {
    const input = '<think>outer <think>inner</think> still outer</think>Answer.';
    expect(stripThink(input)).toBe('Answer.');
  });

  it('does NOT merge two separate blocks (keeps content between them)', () => {
    const input = 'A<think>x</think>KEEP ME<think>y</think>B';
    expect(stripThink(input)).toBe('AKEEP MEB');
  });

  it('strips a closed block then drops a later unclosed block to end', () => {
    const input = 'pre <think>a</think> mid <think>b unclosed forever';
    expect(stripThink(input)).toBe('pre  mid');
  });

  it('strips the <reasoning>...</reasoning> variant', () => {
    expect(stripThink('<reasoning>chain</reasoning>Done.')).toBe('Done.');
  });

  it('strips <thought> and <thinking> variants', () => {
    expect(stripThink('<thought>hmm</thought>X')).toBe('X');
    expect(stripThink('<thinking>hmm</thinking>Y')).toBe('Y');
  });

  it('strips a tag with attributes', () => {
    expect(stripThink('<think id="1">noise</think>ok')).toBe('ok');
  });

  it('removes a stray dangling close tag', () => {
    expect(stripThink('Answer.</think>')).toBe('Answer.');
  });

  it('removes a leading ```thinking fenced block', () => {
    const input = '```thinking\nlet me plan this out\nstep by step\n```\nThe real answer.';
    expect(stripThink(input)).toBe('The real answer.');
  });

  it('removes a leading ```reasoning fence with no closing fence', () => {
    const input = '```reasoning\ntruncated reasoning fence';
    expect(stripThink(input)).toBe('');
  });

  it('does NOT strip a legitimate fenced code block later in the answer', () => {
    const input = 'Here is code:\n```js\nconst x = 1;\n```\nDone.';
    expect(stripThink(input)).toBe(input.trim());
  });

  it('does NOT treat a non-reasoning leading fence as a think block', () => {
    const input = '```python\nprint("hi")\n```';
    expect(stripThink(input)).toBe(input.trim());
  });

  it('combines a leading fence and a tagged block', () => {
    const input = '```think\nplan\n```\n<think>more reasoning</think>Clean output.';
    expect(stripThink(input)).toBe('Clean output.');
  });

  it('returns empty string for non-string input', () => {
    expect(stripThink(null)).toBe('');
    expect(stripThink(undefined)).toBe('');
    expect(stripThink(42)).toBe('');
    expect(stripThink({})).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(stripThink('')).toBe('');
  });

  it('handles a realistic qwen3-style completion', () => {
    const input = [
      '<think>',
      'The question asks about Macaulay duration.',
      'I should recall the formula and compare to modified duration.',
      '</think>',
      '',
      'Macaulay duration is the weighted-average time to receive a bond\'s cash flows.',
    ].join('\n');
    expect(stripThink(input)).toBe(
      "Macaulay duration is the weighted-average time to receive a bond's cash flows.",
    );
  });
});

describe('createThinkStreamFilter', () => {
  function filterChunks(chunks) {
    const filter = createThinkStreamFilter();
    return chunks.map((chunk) => filter.feed(chunk)).join('') + filter.flush();
  }

  it('buffers split reasoning tags so partial markup never reaches the stream', () => {
    expect(filterChunks(['Visible', '<thi', 'nk>private', '</thi', 'nk>', ' answer'])).toBe(
      'Visible answer',
    );
  });

  it('drops unclosed streamed reasoning to the end of the stream', () => {
    expect(filterChunks(['Intro ', '<reason', 'ing>private chain'])).toBe('Intro ');
  });

  it('handles nested streamed reasoning blocks', () => {
    expect(filterChunks(['A', '<think>outer ', '<think>inner</think>', ' outer</think>', 'B'])).toBe(
      'AB',
    );
  });

  it('strips a leading streamed reasoning fence', () => {
    expect(filterChunks(['```thi', 'nking\nprivate', '\n``', '`\nAnswer'])).toBe('Answer');
  });

  it('passes ordinary chunks through without waiting for completion', () => {
    const filter = createThinkStreamFilter();
    expect(filter.feed('Duration ')).toBe('Duration ');
    expect(filter.feed('measures price sensitivity.')).toBe('measures price sensitivity.');
    expect(filter.flush()).toBe('');
  });
});
