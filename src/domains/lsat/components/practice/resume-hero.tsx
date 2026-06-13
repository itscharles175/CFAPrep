import { useNavigate } from "react-router-dom";
import { PlayCircle, RotateCcw, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { CardTitle } from "@/components/ui/card";
import { AccentPanel } from "@/components/accent-panel";
import { getResume } from "@/lib/resume";
import { useSrsDue } from "@/lib/hooks";

/**
 * R7 6.4 — resume-first dashboard hero. Leads the dashboard with action:
 *  - if there is an in-progress section/exam, a prominent "Resume" CTA;
 *  - otherwise, a "Start here" card with "Start a section" + "Today's SRS".
 * Replaces the previously-buried ResumeBanner that lived mid-page.
 */
export function ResumeHero() {
  const navigate = useNavigate();
  const resume = getResume();
  const srs = useSrsDue();
  const due = srs.data?.data.due_count ?? 0;

  if (resume) {
    return (
      // R10 B3.2 — the unified verdict-accent hero idiom (aurora + edge + tint on
      // the system radius), replacing the hand-rolled `rounded-xl border-primary/30
      // bg-primary/5` panel (a corner-radius seam vs `rounded-card`). Static glow:
      // the page's single `breathe` is reserved for the rare recap ceremony.
      <AccentPanel className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="type-overline text-primary">Pick up where you left off</p>
          <CardTitle voice="display" className="leading-snug">
            {resume.label}
          </CardTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={() => navigate(resume.path)}>
            <Icon as={PlayCircle} size="md" />
            Resume
          </Button>
          {due > 0 && (
            <Button size="lg" variant="outline" onClick={() => navigate("/srs")}>
              <Icon as={RotateCcw} size="md" />
              SRS
              <Badge variant="secondary" className="ml-1">{due}</Badge>
            </Button>
          )}
        </div>
      </AccentPanel>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border bg-card p-[var(--card-pad)]">
      <div className="space-y-1">
        <p className="type-overline text-muted-foreground">Start here</p>
        <CardTitle voice="display" className="leading-snug">
          Jump back into practice
        </CardTitle>
        <p className="type-counsel text-sm text-muted-foreground">
          Run a timed section, or clear your due review cards.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="lg" onClick={() => navigate("/practice")}>
          <Icon as={Target} size="md" />
          Start a section
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={() => navigate("/srs")}
          disabled={due === 0}
        >
          <Icon as={RotateCcw} size="md" />
          Today&apos;s SRS
          {due > 0 && <Badge variant="secondary" className="ml-1">{due}</Badge>}
        </Button>
      </div>
    </div>
  );
}
