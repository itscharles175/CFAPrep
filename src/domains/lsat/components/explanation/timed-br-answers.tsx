import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** R4-D6 — timed vs blind-review answers side-by-side. */
export function TimedBrAnswers({
  timedAnswer,
  brAnswer,
  correct,
}: {
  timedAnswer: string;
  brAnswer: string | null;
  correct: string;
}) {
  if (timedAnswer === "—" && brAnswer == null) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Your answers</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <p className="type-overline text-muted-foreground">
              Timed
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{timedAnswer}</p>
            {timedAnswer !== "—" && (
              <Badge
                variant={timedAnswer === correct ? "success" : "destructive"}
                className="mt-2"
              >
                {timedAnswer === correct ? "Correct" : "Incorrect"}
              </Badge>
            )}
          </div>
          <div className="rounded-md border p-3">
            <p className="type-overline text-muted-foreground">
              Blind review
            </p>
            {brAnswer != null ? (
              <>
                <p className="mt-1 text-lg font-semibold tabular-nums">{brAnswer}</p>
                <Badge
                  variant={brAnswer === correct ? "success" : "destructive"}
                  className="mt-2"
                >
                  {brAnswer === correct ? "Correct" : "Incorrect"}
                </Badge>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Not reviewed yet</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
