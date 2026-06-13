import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  HighlightableText,
  splitParagraphBlocks,
  type Highlight,
} from "./highlightable-text";

// A realistic multi-paragraph passage with blank-line separators (the on-disk
// convention) AND a soft single-newline line break inside the first paragraph.
const PASSAGE =
  "Few phenomena are as striking as bioluminescence.\nIt appears across the deep sea.\n\nSeveral explanations have been advanced for it.\n\nWhat unites them is that light carries information.";

describe("splitParagraphBlocks", () => {
  it("covers every character with no gaps or overlaps (offset-preserving)", () => {
    const blocks = splitParagraphBlocks(PASSAGE);
    expect(blocks.length).toBe(3);
    // Reconstruct the original string from the block ranges (content + sep) and
    // confirm it is byte-for-byte identical — i.e. no character is dropped/added.
    let rebuilt = "";
    for (const b of blocks) {
      rebuilt += PASSAGE.slice(b.contentStart, b.contentEnd);
      rebuilt += PASSAGE.slice(b.sepStart, b.sepEnd);
    }
    expect(rebuilt).toBe(PASSAGE);
    // Blocks must be contiguous and ordered.
    expect(blocks[0].contentStart).toBe(0);
    expect(blocks[blocks.length - 1].sepEnd).toBe(PASSAGE.length);
    for (let i = 0; i < blocks.length; i++) {
      expect(blocks[i].sepStart).toBeGreaterThanOrEqual(blocks[i].contentEnd);
      if (i > 0) expect(blocks[i].contentStart).toBe(blocks[i - 1].sepEnd);
    }
  });

  it("keeps a soft single newline inside a paragraph, splits only on blank lines", () => {
    const blocks = splitParagraphBlocks(PASSAGE);
    // The first paragraph contains the soft `\n` (not a separator).
    expect(PASSAGE.slice(blocks[0].contentStart, blocks[0].contentEnd)).toContain(
      "\n",
    );
    expect(PASSAGE.slice(blocks[0].contentStart, blocks[0].contentEnd)).toBe(
      "Few phenomena are as striking as bioluminescence.\nIt appears across the deep sea.",
    );
  });
});

describe("HighlightableText paragraph rendering — offset safety", () => {
  it("renders multiple <p> paragraphs whose combined text equals the source", () => {
    const { container } = render(
      <HighlightableText text={PASSAGE} highlights={[]} activeColor={null} readOnly />,
    );
    const paras = container.querySelectorAll("p");
    expect(paras.length).toBe(3);
    // The container's textContent must be byte-for-byte identical to the source,
    // including the separator newlines — this is what guarantees that absolute
    // character offsets (highlights, notes) and the `\n`-counting line-reference
    // math map to the SAME characters before and after the <p> split.
    expect(container.querySelector("div")?.textContent).toBe(PASSAGE);
  });

  it("a known highlight range marks exactly the same substring after the split", () => {
    // Choose a range that lands in the SECOND paragraph (i.e. after a separator),
    // which is the case most likely to break if offsets shifted.
    const needle = "explanations";
    const start = PASSAGE.indexOf(needle);
    const end = start + needle.length;
    expect(start).toBeGreaterThan(0);

    const highlights: Highlight[] = [{ start, end, color: "yellow" }];
    const { container } = render(
      <HighlightableText
        text={PASSAGE}
        highlights={highlights}
        activeColor={null}
        readOnly
      />,
    );

    // The highlighted segment is the span carrying the highlight class.
    const marked = container.querySelector(".hl-yellow");
    expect(marked).not.toBeNull();
    expect(marked?.textContent).toBe(needle);

    // And the highlight lives inside the correct (second) paragraph.
    const paras = Array.from(container.querySelectorAll("p"));
    const owner = paras.find((p) => p.contains(marked));
    expect(owner).toBeDefined();
    expect(owner?.textContent).toContain(needle);
  });

  it("preserves offsets when a highlight spans across a paragraph boundary", () => {
    // Range from inside paragraph 2 into paragraph 3 (crossing the separator).
    const start = PASSAGE.indexOf("advanced");
    const end = PASSAGE.indexOf("unites") + "unites".length;
    const highlights: Highlight[] = [{ start, end, color: "green" }];
    const { container } = render(
      <HighlightableText
        text={PASSAGE}
        highlights={highlights}
        activeColor={null}
        readOnly
      />,
    );
    // Collect every highlighted fragment in document order; concatenated they
    // must equal the exact source substring for [start, end), separators and all.
    const marked = Array.from(container.querySelectorAll(".hl-green"))
      .map((el) => el.textContent ?? "")
      .join("");
    expect(marked).toBe(PASSAGE.slice(start, end));
  });
});
