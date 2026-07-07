import { describe, expect, it } from "vitest";
import { buildSectionHandsFreeQuestion } from "./section-runner";

describe("SectionRunner hands-free read-aloud helpers", () => {
  it("includes RC passage text before the prompt", () => {
    const script = buildSectionHandsFreeQuestion({
      isRc: true,
      passageText: "The passage argues that local archives preserve institutional memory.",
      stem: "This LR stimulus should not be used for RC.",
      prompt: "The primary purpose of the passage is to",
    });

    expect(script).toContain("Passage. The passage argues");
    expect(script).toContain("Question. The primary purpose");
    expect(script).not.toContain("LR stimulus");
  });

  it("includes LR stimulus before the prompt", () => {
    const script = buildSectionHandsFreeQuestion({
      isRc: false,
      passageText: "This RC passage should not be used for LR.",
      stem: "Some council members support the proposal because it lowers cost.",
      prompt: "Which one of the following most weakens the argument?",
    });

    expect(script).toContain("Stimulus. Some council members");
    expect(script).toContain("Question. Which one");
    expect(script).not.toContain("RC passage");
  });
});
