import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test/setup";
import RcLab from "./RcLab";

const mocks = vi.hoisted(() => ({
  useRCDashboard: vi.fn(),
  useRCPassageMaps: vi.fn(),
  rcPassageMap: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useRCDashboard: mocks.useRCDashboard,
  useRCPassageMaps: mocks.useRCPassageMaps,
}));

vi.mock("@/lib/api", () => ({
  api: {
    rcPassageMap: mocks.rcPassageMap,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
  },
}));

function query<T>(data: T) {
  return {
    data: { data, usingSample: false },
    isError: false,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RcLab />
    </QueryClientProvider>,
  );
}

describe("RcLab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRCDashboard.mockReturnValue(
      query({
        passages: 1,
        questions: 1,
        mapped_passages: 1,
        coverage: 1,
        by_q_type: { Detail: 1 },
        tag_coverage: {
          tagged_questions: 1,
          total_questions: 1,
          coverage: 1,
          low_confidence: 0,
          by_scope: { local_text: 1 },
        },
        timing: { attempts: 0, avg_time_ms: null, accuracy: null, by_q_type: {} },
        next_actions: ["Keep RC maps fresh after each import and timed section."],
      }),
    );
    mocks.useRCPassageMaps.mockReturnValue(
      query([
        {
          passage_id: 12,
          topic: "legal history",
          structure: {
            paragraph_count: 2,
            passage_type: "single",
            topic: "legal history",
            main_point_hint: "The author qualifies a conventional account.",
            question_mix: { Detail: 1 },
            line_reference_density: 0,
            viewpoint_count: 2,
            dominant_viewpoint: "qualified_or_opposing_view",
            evidence_anchor_count: 1,
            tag_coverage: {
              tagged_questions: 1,
              total_questions: 1,
              coverage: 1,
              low_confidence: 0,
              by_scope: { local_text: 1 },
            },
          },
          paragraph_roles: [
            {
              index: 1,
              line_ref: "P1",
              role: "setup",
              author_attitude: "neutral_descriptive",
              claim_density: 0.1,
              viewpoint: { label: "background_context", stance: "neutral", signals: [] },
              evidence_markers: [],
              text_preview: "The passage opens with an older account.",
            },
            {
              index: 2,
              line_ref: "P2",
              role: "contrast_or_shift",
              author_attitude: "skeptical_or_concerned",
              claim_density: 0.7,
              viewpoint: {
                label: "qualified_or_opposing_view",
                stance: "shift",
                signals: ["however"],
              },
              evidence_markers: ["because"],
              text_preview: "However, the author cites evidence because the old view is incomplete.",
            },
          ],
          evidence_refs: [
            {
              paragraph_index: 2,
              line_ref: "P2",
              marker: "because",
              evidence_type: "support",
              text_preview: "However, the author cites evidence because the old view is incomplete.",
            },
          ],
          question_tags: [
            {
              question_id: 44,
              q_type: "Detail",
              scope: "local_text",
              anchor_ref: "local_text",
              requires_evidence: true,
              tags: ["local", "text_lookup", "local_text"],
              tag_confidence: 1,
            },
          ],
          timing: { attempts: 0, avg_time_ms: null, accuracy: null, by_q_type: {} },
          generated_by: "local_heuristic_v1",
          updated_at: "2026-06-11T00:00:00Z",
        },
      ]),
    );
    mocks.rcPassageMap.mockResolvedValue({ ok: true });
  });

  it("surfaces paragraph viewpoints, evidence anchors, and question anchors", () => {
    renderPage();

    expect(screen.getByText("Evidence anchors")).toBeInTheDocument();
    expect(screen.getByText("qualified or opposing view")).toBeInTheDocument();
    expect(screen.getAllByText("because").length).toBeGreaterThan(1);
    expect(screen.getByText("Detail · local text · local_text")).toBeInTheDocument();
    expect(screen.getByText("P2")).toBeInTheDocument();
  });
});
