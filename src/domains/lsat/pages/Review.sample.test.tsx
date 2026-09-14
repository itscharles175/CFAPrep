import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Review from "./Review";

const mocks = vi.hoisted(() => ({
  useSrsDue: vi.fn(),
  useSessions: vi.fn(),
  useErrorLog: vi.fn(),
  useSessionResults: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useSrsDue: mocks.useSrsDue,
  useSessions: mocks.useSessions,
  useErrorLog: mocks.useErrorLog,
  useSessionResults: mocks.useSessionResults,
}));
vi.mock("@lsat/components/review/bucket-queue", () => ({ BucketQueue: () => <div>Bucket queue</div> }));
vi.mock("@lsat/components/review/flagged-queue", () => ({ FlaggedQueue: () => <div>Flagged queue</div> }));
vi.mock("@lsat/components/review/error-log-workspace", () => ({ ErrorLogWorkspace: () => <div>Error log</div> }));
vi.mock("@lsat/components/review/error-pattern-banner", () => ({ ErrorPatternBanner: () => null }));
vi.mock("@lsat/components/review/annotations-hub", () => ({ AnnotationsHub: () => <div>Annotations</div> }));
vi.mock("@lsat/components/review/annotation-inline-editor", () => ({ AnnotationInlineEditor: () => null }));
vi.mock("@lsat/components/coach/docked-coach", () => ({ DockedCoach: () => null }));
vi.mock("@lsat/components/ui/animated-list", () => ({ AnimatedList: () => null }));
vi.mock("@/components/ui/Primitives", () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <header><h1>{title}</h1>{actions}</header>,
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ value, children }: { value: string; children: React.ReactNode }) => value === "buckets" ? <div>{children}</div> : null,
}));

const query = (data: unknown, usingSample = false) => ({
  data: { data, usingSample },
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});

function renderPage() {
  return render(<MemoryRouter><Review /></MemoryRouter>);
}

describe("Review history availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSrsDue.mockReturnValue(query({ due_count: 0, cards: [] }));
    mocks.useErrorLog.mockReturnValue(query([]));
    mocks.useSessionResults.mockReturnValue({ isLoading: false, data: undefined });
  });

  it("hides the detached history action when sessions are fallback data", () => {
    mocks.useSessions.mockReturnValue(query([{ id: 73 }], true));
    renderPage();

    expect(screen.queryByRole("button", { name: "Session history" })).not.toBeInTheDocument();
  });

  it("keeps history reachable when a real session exists", () => {
    mocks.useSessions.mockReturnValue(query([{ id: 73, scaled_score: null, started: "2026-09-14" }]));
    renderPage();

    expect(screen.getByRole("button", { name: "Session history" })).toBeInTheDocument();
  });
});
