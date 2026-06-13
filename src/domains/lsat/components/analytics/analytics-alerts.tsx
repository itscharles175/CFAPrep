import { useEffect, useRef } from "react";
import { useBlindReviewGap, useRegressionAlerts } from "@/lib/hooks";
import {
  captureGapSnapshot,
  computeGapAlerts,
  formatGapAlertMessage,
  formatRegressionAlertMessage,
} from "@/lib/analyticsAlerts";
import {
  dismissAnalyticsAlertsToday,
  getAnalyticsAlertsDismissed,
} from "@/lib/prefs";
import { toast } from "@/lib/toast";

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
        duration: 12_000,
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
      duration: 12_000,
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
