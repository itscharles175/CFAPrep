import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsAlerts } from "./analytics-alerts";

const mocks = vi.hoisted(() => ({
  useBlindReviewGap: vi.fn(),
  useRegressionAlerts: vi.fn(),
  warning: vi.fn(),
  captureGapSnapshot: vi.fn(),
  getAnalyticsAlertsDismissed: vi.fn(() => null),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useBlindReviewGap: mocks.useBlindReviewGap,
  useRegressionAlerts: mocks.useRegressionAlerts,
}));

vi.mock("@lsat/lib/analyticsAlerts", () => ({
  captureGapSnapshot: mocks.captureGapSnapshot,
  computeGapAlerts: vi.fn(() => [{ q_type: "Flaw" }]),
  formatGapAlertMessage: vi.fn(() => "Sample-backed gap"),
  formatRegressionAlertMessage: vi.fn(() => "Sample-backed regression"),
}));

vi.mock("@lsat/lib/prefs", () => ({
  dismissAnalyticsAlertsToday: vi.fn(),
  getAnalyticsAlertsDismissed: mocks.getAnalyticsAlertsDismissed,
}));

vi.mock("@lsat/lib/toast", () => ({
  toast: { warning: mocks.warning },
}));

const sampleQuery = (usingSample: boolean) => ({
  isLoading: false,
  data: {
    usingSample,
    data: { gap: 0.21, alerts: [{ q_type: "Flaw" }] },
  },
});

describe("AnalyticsAlerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAnalyticsAlertsDismissed.mockReturnValue(null);
  });

  it("never turns fallback analytics into a global learner-progress toast", () => {
    mocks.useBlindReviewGap.mockReturnValue(sampleQuery(true));
    mocks.useRegressionAlerts.mockReturnValue(sampleQuery(false));

    render(<AnalyticsAlerts />);

    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.captureGapSnapshot).not.toHaveBeenCalled();
  });

  it("moves compact warning toasts into the top band and gives both controls 40px targets", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    mocks.useBlindReviewGap.mockReturnValue(sampleQuery(false));
    mocks.useRegressionAlerts.mockReturnValue(sampleQuery(false));

    render(<AnalyticsAlerts />);

    expect(mocks.warning).toHaveBeenCalledWith(
      "Sample-backed regression",
      expect.objectContaining({
        position: "top-center",
        classNames: expect.objectContaining({
          closeButton: "min-h-10 min-w-10",
          actionButton: "min-h-10 px-3",
        }),
      }),
    );
  });
});
