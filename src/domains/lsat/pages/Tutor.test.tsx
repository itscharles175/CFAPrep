import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SocraticEvidence } from "./Tutor";

describe("SocraticEvidence", () => {
  it("renders similar-miss and notebook evidence without answer keys", () => {
    render(
      <SocraticEvidence
        context={{
          answer_key_hidden: true,
          prior_turn_count: 2,
          recent_turns: [
            { role: "user", content: "I thought the author broadened the claim." },
            { role: "assistant", content: "Which actor does the passage keep fixed?" },
          ],
          question_context: {
            question_id: 24,
            q_type: "Inference",
            section_type: "RC",
            passage_topic: "watershed permits",
            passage_excerpt:
              "The passage contrasts a conservation board's narrow permit rule with a broader watershed plan.",
          },
          similar_misses: [
            {
              question_id: 42,
              q_type: "Flaw",
              matched_by: "semantic",
              similarity: 0.93,
              trap_guess: "scope_shift",
              rationale_excerpt: "I overread the actor shift.",
            },
            {
              question_id: 43,
              q_type: "Inference",
              matched_by: "trap_type",
              trap_type: "scope_shift",
              note_excerpt: "I broadened a narrow passage claim.",
            },
          ],
          notebook_context: {
            count: 1,
            items: [
              {
                kind: "note",
                id: 7,
                title: "Scope shift notebook",
                excerpt: "Preserve actor and scope.",
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("Why this nudge")).toBeInTheDocument();
    expect(screen.getByText("Answer hidden")).toBeInTheDocument();
    expect(screen.getByText("2 persisted turns")).toBeInTheDocument();
    expect(screen.getByText("Passage-aware context")).toBeInTheDocument();
    expect(screen.getByText("RC · watershed permits")).toBeInTheDocument();
    expect(screen.getByText(/conservation board's narrow permit rule/)).toBeInTheDocument();
    expect(screen.getByText("Trap-similar misses")).toBeInTheDocument();
    const q42Rows = screen.getAllByText(/Q42/).map((node) => node.closest("div") ?? node);
    expect(q42Rows.some((row) => row.textContent?.includes("Flaw"))).toBe(true);
    expect(q42Rows.some((row) => row.textContent?.includes("scope_shift"))).toBe(true);
    expect(screen.getAllByText(/matched by semantic · 93%/).length).toBeGreaterThan(0);
    const q43Rows = screen.getAllByText(/Q43/).map((node) => node.closest("div") ?? node);
    expect(q43Rows.some((row) => row.textContent?.includes("scope_shift"))).toBe(true);
    expect(screen.getByText("Notebook · Scope shift notebook")).toBeInTheDocument();
    expect(screen.getByText("Persisted turn context")).toBeInTheDocument();
    expect(screen.getByText(/Which actor does the passage keep fixed/)).toBeInTheDocument();
    expect(screen.queryByText(/correct_answer/i)).not.toBeInTheDocument();
  });
});
