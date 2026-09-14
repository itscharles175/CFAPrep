import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { SystemNotice } from "@lsat/components/system-notice";
import { unwrap, useErrorLog } from "@lsat/lib/hooks";
import { detectErrorPatterns } from "@lsat/lib/errorPatterns";
import { SampleDataRecovery } from "@lsat/components/sample-data-recovery";

/**
 * R4-A9 — surfaces recurring error-log reasons.
 *
 * R9 (docs/19 F4) — uses the unified {@link SystemNotice} language and drops the
 * deprecated `bg-warning/10` opacity idiom for the token-driven `warning` tone.
 */
export function ErrorPatternBanner() {
  const { data, usingSample, refetch } = unwrap(useErrorLog());
  const patterns = useMemo(
    () => (usingSample ? [] : detectErrorPatterns(data ?? [])),
    [data, usingSample],
  );

  // Fallback error-log rows are fixtures, not the learner's diagnosis. Keep
  // them out of pattern detection and make the unavailable source actionable.
  if (usingSample)
    return (
      <SampleDataRecovery
        compact
        section="Error patterns"
        affectedSections={["Recurring misses", "Targeted remediation"]}
        onRetry={refetch}
      />
    );
  if (!patterns.length) return null;

  const top = patterns[0];
  return (
    <SystemNotice tone="warning" icon={AlertTriangle}>
      <strong className="text-foreground">
        {top.count} {top.label} errors
      </strong>{" "}
      logged this week
      {patterns.length > 1 &&
        ` · also ${patterns.slice(1).map((p) => `${p.count} ${p.label}`).join(", ")}`}
      . Drill traps from Review → Error log.
    </SystemNotice>
  );
}
