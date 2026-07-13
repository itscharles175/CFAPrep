import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Target } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import { getGoal, getPlanBudgetMin, setGoal as persistGoal } from "@lsat/lib/prefs";
import { useSaveStudyPlan } from "@lsat/lib/mutations";

const schema = z.object({
  targetScore: z.number().min(120).max(180),
  examDate: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export function GoalSettingsForm() {
  const initial = getGoal();
  const saveStudyPlan = useSaveStudyPlan();
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      targetScore: initial?.targetScore ?? 165,
      examDate: initial?.examDate ?? "",
    },
  });

  const targetScore = watch("targetScore");

  function onSubmit(values: FormValues) {
    // Local mirror (keeps the dashboard working offline)…
    persistGoal({
      targetScore: values.targetScore,
      examDate: values.examDate ?? "",
      bandLow: values.targetScore - 2,
      bandHigh: values.targetScore + 2,
    });
    // …and the server plan (drives /study/today + /analytics/forecast). The
    // mutation handles its own success/error toast.
    saveStudyPlan.mutate({
      target_score: values.targetScore,
      exam_date: values.examDate || null,
      daily_minutes: getPlanBudgetMin(),
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Target className="h-4 w-4 text-primary" />
        <CardTitle className="text-base">Goal &amp; test date</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="target-score">
                Target score
                <span className="ml-2 font-mono tabular-nums text-primary">
                  {targetScore}
                </span>
              </Label>
              <input
                id="target-score"
                type="range"
                min={120}
                max={180}
                step={1}
                className="w-full accent-[hsl(var(--primary))]"
                {...register("targetScore", { valueAsNumber: true })}
              />
              {errors.targetScore && (
                <p className="text-xs text-destructive">{errors.targetScore.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exam-date">Exam date</Label>
              <Input id="exam-date" type="date" {...register("examDate")} />
            </div>
          </div>
          <Button type="submit" size="sm">
            Save goal
          </Button>
          <p className="text-xs text-muted-foreground">
            Drives the dashboard countdown, on-track indicator, and goal band on your
            score trend.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
