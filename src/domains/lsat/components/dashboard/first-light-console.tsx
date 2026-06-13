import { useNavigate } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import { Compass, Sparkles, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Logo } from "@/components/logo";
import { fadeUp, stagger } from "@/lib/motion";

/**
 * R9 F3.2 — the honest empty / first-run Console ("observatory before first
 * light"). Shown only when the dashboard is on sample data AND the user is
 * genuinely new (no real goal + zero sessions): instead of presenting fabricated
 * sample numbers (predicted 164, a 12-day streak) as if they were the user's, we
 * render an unlit instrument — an engraved `— / 180`, a calm aurora, and a
 * guided "set goal → take a section" path. No backend; pure presentation.
 */
export function FirstLightConsole() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  return (
    <m.div
      variants={reduce ? undefined : stagger}
      initial={reduce ? false : "hidden"}
      animate="show"
      className="space-y-8 pb-12"
    >
      {/* The unlit instrument — an engraved blank where the score will arrive. */}
      <m.div
        variants={reduce ? undefined : fadeUp}
        className="flex flex-col items-center gap-6 py-10 text-center"
      >
        <div className="aurora flex items-center justify-center">
          <Logo className="h-12 w-12" />
        </div>
        <div className="space-y-2">
          <p className="type-overline text-muted-foreground">Predicted score</p>
          <div className="aurora inline-flex items-baseline gap-2">
            <span className="type-numeric text-stat-xl font-semibold leading-none text-muted-foreground">
              —
            </span>
            <span className="type-numeric text-2xl text-muted-foreground">
              / 180
            </span>
          </div>
          <p className="type-counsel mx-auto max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
            Your console is dark until you take your first section. Set a goal and
            run one section — your real score, trend, and readiness light up here.
            We won&apos;t show you numbers you haven&apos;t earned.
          </p>
        </div>
      </m.div>

      {/* The guided first-light path. */}
      <m.div
        variants={reduce ? undefined : fadeUp}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Card interactive onClick={() => navigate("/settings")}>
          <CardContent className="flex h-full flex-col gap-3 p-[var(--card-pad)]">
            <span className="inline-flex w-fit items-center justify-center rounded-card bg-surface-2 p-2 text-primary">
              <Icon as={Target} size="md" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">1 · Set your goal</p>
              <p className="type-counsel text-sm text-muted-foreground [text-wrap:pretty]">
                A target score and exam date so the console can tell you whether
                you&apos;re on pace.
              </p>
            </div>
            <Button
              size="sm"
              className="mt-auto w-fit"
              onClick={(e) => {
                e.stopPropagation();
                navigate("/settings");
              }}
            >
              Set goal
            </Button>
          </CardContent>
        </Card>

        <Card interactive onClick={() => navigate("/practice")}>
          <CardContent className="flex h-full flex-col gap-3 p-[var(--card-pad)]">
            <span className="inline-flex w-fit items-center justify-center rounded-card bg-surface-2 p-2 text-primary">
              <Icon as={Compass} size="md" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">2 · Take a section</p>
              <p className="type-counsel text-sm text-muted-foreground [text-wrap:pretty]">
                One timed section is all it takes to light the first star — your
                first real data point.
              </p>
            </div>
            <Button
              size="sm"
              className="mt-auto w-fit"
              onClick={(e) => {
                e.stopPropagation();
                navigate("/practice");
              }}
            >
              <Icon as={Sparkles} size="sm" />
              Start a section
            </Button>
          </CardContent>
        </Card>
      </m.div>
    </m.div>
  );
}
