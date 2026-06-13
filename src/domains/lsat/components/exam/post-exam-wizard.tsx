import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import {
  CheckCircle2,
  ListChecks,
  MessageSquare,
} from "lucide-react";
import { Logo } from "@lsat/components/logo";
import { Button } from "@lsat/components/ui/button";
import { Textarea } from "@lsat/components/ui/textarea";
import { Label } from "@lsat/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { OutcomeFunnel } from "@lsat/components/analytics/outcome-funnel";
import { useSessionResults } from "@lsat/lib/hooks";
import { useSaveReflection } from "@lsat/lib/mutations";
import { setReflection } from "@lsat/lib/prefs";
import type { SectionSummary } from "@lsat/lib/types";

type Step = "summary" | "reflect" | "next";

/** R4-B6 — guided loop after timed work: reflect → BR → review queue. */
export function PostExamWizard({
  title,
  sessionId,
  sections,
  onBlindReview,
  onDone,
}: {
  title: string;
  sessionId: number | null;
  sections?: SectionSummary[];
  onBlindReview: () => void;
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [step, setStep] = useState<Step>("summary");
  const [reflection, setReflectionNote] = useState("");
  const results = useSessionResults(sessionId ?? 0);
  const saveReflection = useSaveReflection();
  const outcomeItems = (results.data?.data.items ?? []).filter(
    (it) => it.attempt.outcome != null,
  );

  function finishReflection() {
    if (sessionId != null && reflection.trim()) {
      // E3 — persist to the backend (survives reinstall, feeds session history)
      // and keep a local copy for offline.
      setReflection(sessionId, reflection.trim());
      saveReflection.mutate({ sessionId, text: reflection.trim() });
    }
    setStep("next");
  }

  return (
    <m.div
      className="flex flex-1 flex-col items-center justify-center px-6 py-12"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {step === "summary" && (
        <>
          <Logo className="mb-4 h-10 w-10" />
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="mt-2 max-w-md text-center text-muted-foreground">
            Timed section complete. Take a breath, then continue the review loop.
          </p>
          {sections && sections.length > 0 && (
            <Card className="mt-6 w-full max-w-lg">
              <CardHeader>
                <CardTitle className="text-base">Section</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {sections[0].type} · {sections[0].question_count} questions
              </CardContent>
            </Card>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button size="lg" onClick={() => setStep("reflect")}>
              Continue
            </Button>
          </div>
        </>
      )}

      {step === "reflect" && (
        <>
          <MessageSquare className="mb-4 h-10 w-10 text-primary" />
          <h1 className="text-xl font-bold">Quick reflection</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Optional — what felt slow or uncertain?
          </p>
          <div className="mt-4 w-full max-w-md space-y-2">
            <Label htmlFor="reflection">Note</Label>
            <Textarea
              id="reflection"
              value={reflection}
              onChange={(e) => setReflectionNote(e.target.value)}
              placeholder="e.g. Parallel reasoning ate clock on Q8–12"
              rows={3}
            />
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={() => setStep("next")}>
              Skip
            </Button>
            <Button onClick={finishReflection}>Save & continue</Button>
          </div>
        </>
      )}

      {step === "next" && (
        <>
          <ListChecks className="mb-4 h-10 w-10 text-primary" />
          <h1 className="text-xl font-bold">Next steps</h1>
          {outcomeItems.length > 0 && (
            <Card className="mt-6 w-full max-w-lg">
              <CardHeader>
                <CardTitle className="text-base">Outcome breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <OutcomeFunnel items={outcomeItems} />
              </CardContent>
            </Card>
          )}
          <ol className="mt-4 max-w-md space-y-3 text-sm">
            <li className="flex gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
              Blind review flagged and unsure questions (no timer)
            </li>
            <li className="flex gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
              Work your review buckets by outcome
            </li>
            <li className="flex gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
              Open explanations for top misses
            </li>
          </ol>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button size="lg" onClick={onBlindReview}>
              Start blind review
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate("/review?tab=buckets")}
            >
              Review queue
            </Button>
            <Button variant="outline" onClick={() => navigate("/analytics")}>
              Analytics
            </Button>
            <Button
              variant="ghost"
              onClick={() => (onDone ? onDone() : navigate("/practice"))}
            >
              Done
            </Button>
          </div>
        </>
      )}
    </m.div>
  );
}
