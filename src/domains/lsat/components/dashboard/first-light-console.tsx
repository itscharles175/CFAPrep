import { useNavigate } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import { ArrowRight, Compass, Target } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Icon } from "@lsat/components/ui/icon";
import { Logo } from "@lsat/components/logo";
import { fadeUp, stagger } from "@lsat/lib/motion";

/**
 * The honest empty state for a genuinely new learner. It uses the same
 * page-led hierarchy as StudyVault Today and Learn: one next action first,
 * followed by the smaller preparatory choice. No score is invented while the
 * backend is serving sample data.
 */
export function FirstLightConsole() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  return (
    <m.div variants={reduce ? undefined : stagger} initial={reduce ? false : "hidden"} animate="show" className="space-y-8 pb-12">
      <m.div variants={reduce ? undefined : fadeUp} className="grid gap-6 border-b border-border pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-card bg-primary/10 text-primary">
              <Logo className="h-5 w-5" />
            </span>
            <p className="type-overline text-muted-foreground">LSAT · Curriculum</p>
          </div>
          <div className="space-y-1">
            <h2 className="type-display text-3xl leading-tight">Start with one real signal.</h2>
            <p className="type-counsel max-w-xl text-sm text-muted-foreground [text-wrap:pretty]">
              Set the target you are working toward, then take a section. Your home view will build from that work instead of showing sample progress.
            </p>
          </div>
        </div>
        <div className="rounded-card border border-border bg-surface-1 px-5 py-4 lg:min-w-48">
          <p className="type-overline text-muted-foreground">Predicted score</p>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="type-numeric text-3xl font-semibold leading-none text-muted-foreground">—</span>
            <span className="type-numeric text-sm text-muted-foreground">/ 180</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Available after your first section</p>
        </div>
      </m.div>

      <m.div variants={reduce ? undefined : fadeUp} className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)]">
        <Card interactive onClick={() => navigate("/practice")} className="border-primary/25 bg-primary/[0.035]">
          <CardContent className="flex h-full flex-col gap-5 p-[var(--card-pad)]">
            <div className="flex items-start justify-between gap-4">
              <span className="inline-flex w-fit items-center justify-center rounded-card bg-primary/10 p-2 text-primary">
                <Icon as={Compass} size="md" />
              </span>
              <span className="type-overline text-primary">Recommended next</span>
            </div>
            <div className="space-y-1">
              <p className="text-lg font-semibold">Take your first timed section</p>
              <p className="type-counsel max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
                This gives LSAT Learn an honest starting point for your score trend, readiness, and next study action.
              </p>
            </div>
            <Button
              className="mt-auto w-fit"
              onClick={(e) => {
                e.stopPropagation();
                navigate("/practice");
              }}
            >
              Start a section
              <Icon as={ArrowRight} size="sm" />
            </Button>
          </CardContent>
        </Card>

        <Card interactive onClick={() => navigate("/settings")}>
          <CardContent className="flex h-full flex-col gap-4 p-[var(--card-pad)]">
            <span className="inline-flex w-fit items-center justify-center rounded-card bg-surface-2 p-2 text-primary">
              <Icon as={Target} size="md" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">Set your target</p>
              <p className="type-counsel text-sm text-muted-foreground [text-wrap:pretty]">Add an exam date and target score when you are ready to see your pace alongside your practice data.</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-auto w-fit min-h-10"
              onClick={(e) => {
                e.stopPropagation();
                navigate("/settings");
              }}
            >
              Set goal
            </Button>
          </CardContent>
        </Card>
      </m.div>
    </m.div>
  );
}
