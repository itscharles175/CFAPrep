import { m, useReducedMotion } from "motion/react";
import { Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";
import { fadeUp, stagger } from "@/lib/motion";

export interface Milestone {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  date?: string;
}

const DEFAULT_MILESTONES: Milestone[] = [
  {
    id: "first-section",
    title: "First timed section",
    description: "Complete any timed LR or RC section.",
    unlocked: false,
  },
  {
    id: "br-pass",
    title: "Blind review graduate",
    description: "Finish blind review on a full section.",
    unlocked: false,
  },
  {
    id: "streak-7",
    title: "Week streak",
    description: "Study seven days in a row.",
    unlocked: false,
  },
  {
    id: "pb",
    title: "Personal best",
    description: "Beat your highest scaled score.",
    unlocked: false,
  },
];

/**
 * Round 2 — local milestone gallery (no backend dependency).
 *
 * R10 B1.4 cohesion note: the Console's canonical milestone language is the
 * single {@link import("./progress-ledger").ProgressLedger}. This badge gallery
 * is the standalone variant and now speaks the same token language as the rest
 * (`<Icon>`, depth surfaces, `bg-warning-subtle`, `rounded-card`).
 */
export function MilestoneGallery({
  milestones = DEFAULT_MILESTONES,
  unlockedIds = [],
}: {
  milestones?: Milestone[];
  unlockedIds?: string[];
}) {
  const reduce = useReducedMotion();
  const items = milestones.map((milestone) => ({
    ...milestone,
    unlocked: milestone.unlocked || unlockedIds.includes(milestone.id),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon as={Trophy} size="md" className="text-warning" />
          Milestones
        </CardTitle>
      </CardHeader>
      <CardContent>
        <m.div
          variants={stagger}
          initial={reduce ? false : "hidden"}
          animate="show"
          className="grid gap-3 sm:grid-cols-2"
        >
          {items.map((milestone) => (
            <m.div
              key={milestone.id}
              variants={fadeUp}
              className={
                milestone.unlocked
                  ? "rounded-card border border-warning/30 bg-warning-subtle p-3"
                  : "rounded-card border border-dashed bg-surface-2 p-3 opacity-60"
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-sm">{milestone.title}</div>
                <Badge variant={milestone.unlocked ? "default" : "outline"}>
                  {milestone.unlocked ? "Unlocked" : "Locked"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{milestone.description}</p>
              {milestone.date && (
                <p className="mt-2 text-2xs text-muted-foreground">
                  {formatDate(milestone.date)}
                </p>
              )}
            </m.div>
          ))}
        </m.div>
      </CardContent>
    </Card>
  );
}
