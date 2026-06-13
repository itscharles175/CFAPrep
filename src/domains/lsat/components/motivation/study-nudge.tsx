import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { SystemNotice } from "@lsat/components/system-notice";
import { dismissStudyNudge, isStudyNudgeDismissed } from "@lsat/lib/prefs";
import type { SessionSummary } from "@lsat/lib/types";

/** R4-G9 — gentle reminder when timed work has lapsed. R9: speaks through the
 * unified <SystemNotice> language instead of the deprecated bg-warning/10. */
export function StudyNudge({ sessions }: { sessions: SessionSummary[] }) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(() => isStudyNudgeDismissed());

  const daysSinceTimed = useMemo(() => {
    const timed = sessions.filter((s) => s.type === "section" && s.ended);
    if (!timed.length) return null;
    const latest = timed
      .map((s) => s.ended ?? s.started)
      .sort()
      .pop();
    if (!latest) return null;
    const then = new Date(latest.slice(0, 10) + "T12:00:00");
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today.getTime() - then.getTime()) / 86_400_000);
  }, [sessions]);

  if (dismissed || daysSinceTimed == null || daysSinceTimed < 3) return null;

  return (
    <SystemNotice
      tone="warning"
      icon={CalendarClock}
      onDismiss={() => {
        dismissStudyNudge();
        setDismissed(true);
      }}
      action={
        <Button size="sm" onClick={() => navigate("/practice")}>
          Start timed section
        </Button>
      }
    >
      <span className="type-counsel">
        <span className="font-medium text-foreground">
          It has been {daysSinceTimed} days
        </span>{" "}
        since your last timed section. A short timed set keeps pacing honest.
      </span>
    </SystemNotice>
  );
}
