import { AlertTriangle } from "lucide-react";
import { Badge } from "@lsat/components/ui/badge";
import { Input } from "@lsat/components/ui/input";
import { Textarea } from "@lsat/components/ui/textarea";
import { qTypeLabel } from "@lsat/lib/labels";
import type { ImportCountMismatch } from "@lsat/lib/importDiff";
import type { ParsedPrepTest } from "@lsat/lib/types";

/** Match warnings to section/question indices when possible (R4-F3). */
function warningsForQuestion(
  warnings: string[],
  si: number,
  qi: number,
): string[] {
  const hints = [
    `section ${si + 1}`,
    `S${si + 1}`,
    `Q${qi + 1}`,
    `question ${qi + 1}`,
  ];
  return warnings.filter((w) => {
    const lower = w.toLowerCase();
    return hints.some((h) => lower.includes(h.toLowerCase()));
  });
}

export function ImportStructureTree({
  edited,
  warnings,
  countMismatch,
  onEdit,
}: {
  edited: ParsedPrepTest;
  warnings: string[];
  countMismatch?: ImportCountMismatch | null;
  onEdit: (next: ParsedPrepTest) => void;
}) {
  return (
    <div className="space-y-4">
      {edited.sections.map((sec, si) => {
        const secWarnings = warningsForQuestion(warnings, si, -1).filter(
          (w) => !w.match(/Q\d/i),
        );
        const countFlag = countMismatch?.sectionFlags[si];
        return (
          <div
            key={si}
            className={
              secWarnings.length || countFlag
                ? "rounded-md border border-warning/40 bg-warning-subtle p-3"
                : "rounded-md border p-3"
            }
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{sec.type}</Badge>
              <span
                className={
                  countFlag
                    ? "text-sm font-medium text-warning"
                    : "text-sm text-muted-foreground"
                }
              >
                {sec.questions.length} questions
                {countFlag && countMismatch
                  ? ` (raw ~${countMismatch.rawTotal} total)`
                  : ""}
              </span>
              {secWarnings.map((w, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-xs text-warning"
                >
                  <AlertTriangle className="h-3 w-3" />
                  {w}
                </span>
              ))}
            </div>
            <div className="space-y-3">
              {sec.questions.map((q, qi) => {
                const qWarnings = warningsForQuestion(warnings, si, qi);
                return (
                  <div
                    key={qi}
                    className={
                      qWarnings.length
                        ? "rounded border border-warning/30 bg-warning-subtle p-2"
                        : "rounded border p-2"
                    }
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Q{qi + 1}</span>
                      {q.q_type && (
                        <Badge variant="outline">{qTypeLabel(q.q_type)}</Badge>
                      )}
                      {q.correct_answer && (
                        <span>answer: {q.correct_answer}</span>
                      )}
                      {qWarnings.map((w, i) => (
                        <span key={i} className="text-warning">
                          {w}
                        </span>
                      ))}
                    </div>
                    <Textarea
                      className="mb-1 text-xs"
                      value={q.stem}
                      onChange={(e) => {
                        const next = structuredClone(edited);
                        next.sections[si].questions[qi].stem = e.target.value;
                        onEdit(next);
                      }}
                    />
                    <Input
                      className="text-xs"
                      value={q.prompt}
                      onChange={(e) => {
                        const next = structuredClone(edited);
                        next.sections[si].questions[qi].prompt = e.target.value;
                        onEdit(next);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
