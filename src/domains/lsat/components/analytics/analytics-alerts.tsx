import { useEffect, useRef } from "react";
import { useBlindReviewGap, useRegressionAlerts } from "@lsat/lib/hooks";
import {
  captureGapSnapshot,
  computeGapAlerts,
  formatGapAlertMessage,
  formatRegressionAlertMessage,
} from "@lsat/lib/analyticsAlerts";
import {
  dismissAnalyticsAlertsToday,
  getAnalyticsAlertsDismissed,
} from "@lsat/lib/prefs";
import { toast } from "@lsat/lib/toast";

function warningToastOptions() {
  return {
    duration: 12_000,
    // Compact screens use the top band so an evidence warning cannot cover the
    // dashboard or analytics controls near the bottom of the viewport.
    position: typeof window !== "undefined" && window.innerWidth <= 640
      ? "top-center"
      : "bottom-right",
    classNames: {
      closeButton: "min-h-10 min-w-10",
      actionButton: "min-h-10 px-3",
    },
  } as const;
}

/** R4-E9 — dismissible toast when a type gap exceeds prefs thresholds. */
export function AnalyticsAlerts() {
  const gap = useBlindReviewGap(30);
  const regressions = useRegressionAlerts("all", { recentDays: 7, baselineDays: 30 });
  const shown = useRef(false);

  useEffect(() => {
    if (
      shown.current ||
      gap.isLoading ||
      regressions.isLoading ||
      gap.data?.usingSample ||
      regressions.data?.usingSample ||
      !gap.data?.data ||
      !regressions.data?.data
    )
      return;
    const today = new Date().toISOString().slice(0, 10);
    if (getAnalyticsAlertsDismissed() === today) return;

    const regressionAlerts = regressions.data.data.alerts ?? [];
    if (regressionAlerts.length) {
      shown.current = true;
      toast.warning(formatRegressionAlertMessage(regressionAlerts), {
        ...warningToastOptions(),
        action: {
          label: "Dismiss",
          onClick: () => {
            dismissAnalyticsAlertsToday();
            captureGapSnapshot(gap.data!.data);
          },
        },
        onDismiss: () => {
          dismissAnalyticsAlertsToday();
          captureGapSnapshot(gap.data!.data);
        },
      });
      return;
    }

    const alerts = computeGapAlerts(gap.data.data);
    if (!alerts.length) {
      captureGapSnapshot(gap.data.data);
      return;
    }

    shown.current = true;
    toast.warning(formatGapAlertMessage(alerts), {
      ...warningToastOptions(),
      action: {
        label: "Dismiss",
        onClick: () => {
          dismissAnalyticsAlertsToday();
          captureGapSnapshot(gap.data!.data);
        },
      },
      onDismiss: () => {
        dismissAnalyticsAlertsToday();
        captureGapSnapshot(gap.data!.data);
      },
    });
  }, [gap.isLoading, gap.data, regressions.isLoading, regressions.data]);

  return null;
}
