import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { SystemNotice } from "@/components/system-notice";
import { unwrap, useErrorLog } from "@/lib/hooks";
import { detectErrorPatterns } from "@/lib/errorPatterns";

/**
 * R4-A9 — surfaces recurring error-log reasons.
 *
 * R9 (docs/19 F4) — uses the unified {@link SystemNotice} language and drops the
 * deprecated `bg-warning/10` opacity idiom for the token-driven `warning` tone.
 */
export function ErrorPatternBanner() {
  const { data } = unwrap(useErrorLog());
  const patterns = useMemo(
    () => detectErrorPatterns(data ?? []),
    [data],
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
