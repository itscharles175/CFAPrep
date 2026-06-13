import { useNavigate } from "react-router-dom";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { AccentPanel } from "@/components/accent-panel";
import { getResume } from "@/lib/resume";

export function ResumeBanner() {
  const navigate = useNavigate();
  const resume = getResume();
  if (!resume) return null;

  return (
    // R10 B3.2 — the unified verdict-accent idiom (aurora + edge + tint on the
    // system radius), replacing the hand-rolled `rounded-lg border-primary/30
    // bg-primary/5` banner. Compact padding overrides AccentPanel's default p-5.
    <AccentPanel className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div>
        <p className="text-sm font-medium">Resume where you left off</p>
        <p className="text-xs text-muted-foreground">{resume.label}</p>
      </div>
      <Button size="sm" onClick={() => navigate(resume.path)}>
        <Icon as={PlayCircle} size="sm" />
        Continue
      </Button>
    </AccentPanel>
  );
}
