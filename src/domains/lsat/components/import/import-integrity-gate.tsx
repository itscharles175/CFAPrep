import { useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@lsat/components/ui/alert";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import { Textarea } from "@lsat/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@lsat/components/ui/table";
import { api } from "@lsat/lib/api";
import { toast } from "@lsat/lib/toast";
import type {
  ImportIntegrityIssue,
  ImportReconcileResult,
  ParsedPrepTest,
} from "@lsat/lib/types";

/**
 * Parse a pasted answer key into an array of A–E letters. Accepts entries
 * separated by newlines, commas, spaces or semicolons, and tolerates a leading
 * question number / period (e.g. "1. C" -> "C"). Letters are upper-cased.
 */
export function parseAnswerKey(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .flatMap((line) => line.split(/\s+/))
    .map((tok) => tok.replace(/^\d+[).:-]?/, "").trim().toUpperCase())
    .filter((tok) => tok.length > 0)
    .map((tok) => tok[0])
    .filter((ch) => /[A-E]/.test(ch));
}

/**
 * D1 — Import commit integrity gate. Rendered when POST /api/import/commit
 * returns 409 with `{error:"unresolved_integrity_issues", issues:[…]}`.
 *
 * Offers two recovery paths:
 *  (a) paste the official answer key, reconcile it against the parse, review
 *      mismatches, then re-commit with the corrected structure; and
 *  (b) "Commit anyway" which re-commits with force:true (storing the parsed
 *      key as-is, which may be wrong).
 */
export function ImportIntegrityGate({
  jobId,
  parsed,
  issues,
  committing,
  onReconciledCommit,
  onForceCommit,
}: {
  jobId: number | string;
  parsed: ParsedPrepTest;
  issues: ImportIntegrityIssue[];
  /** True while a re-commit is in flight (disables actions). */
  committing: boolean;
  /** Re-commit with a reconciled structure (preferred path). */
  onReconciledCommit: (corrected: ParsedPrepTest) => void;
  /** Re-commit with force:true, accepting the parsed key as-is. */
  onForceCommit: () => void;
}) {
  const [keyText, setKeyText] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [result, setResult] = useState<ImportReconcileResult | null>(null);

  const parsedKey = parseAnswerKey(keyText);
  const totalQuestions = parsed.sections.reduce(
    (n, s) => n + s.questions.length,
    0,
  );

  async function runReconcile(apply: boolean) {
    if (parsedKey.length === 0) {
      toast.error("Paste an answer key (A–E, one per question) first.");
      return;
    }
    setReconciling(true);
    try {
      const res = await api.importReconcile({
        job_id: jobId,
        parsed,
        answer_key: parsedKey,
        apply,
      });
      setResult(res);
      if (apply && res.applied) {
        toast.success(
          `Applied key — ${res.match_count}/${res.total_questions} already matched.`,
        );
        onReconciledCommit(res.parsed);
      } else if (apply && !res.applied) {
        toast.warning("Key did not apply cleanly — review mismatches below.");
      }
    } catch {
      toast.error("Could not reconcile against the backend.");
    } finally {
      setReconciling(false);
    }
  }

  const busy = reconciling || committing;

  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Integrity check failed — not committed</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            The parsed structure has problems with its answer key or choices.
            Resolve them by pasting the official answer key below, or commit
            anyway (which may store an incorrect key).
          </p>
          <ul className="space-y-1">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge variant="destructive" className="mt-0.5 shrink-0">
                  {issue.kind}
                </Badge>
                <span>
                  {issue.where ? (
                    <span className="font-medium">{issue.where}: </span>
                  ) : null}
                  {issue.detail}
                </span>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>

      <div className="rounded-card border bg-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-semibold">Enter the official answer key</h3>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          One answer per line or comma-separated, in question order (A–E).
          Leading numbers like “1. C” are fine. This PrepTest has{" "}
          <span className="font-medium tabular-nums">{totalQuestions}</span>{" "}
          parsed question{totalQuestions === 1 ? "" : "s"}.
        </p>
        <Textarea
          value={keyText}
          onChange={(e) => setKeyText(e.target.value)}
          rows={5}
          placeholder={"A\nC\nB\nE\n…"}
          className="font-mono text-xs"
          aria-label="Official answer key"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Detected{" "}
            <span className="font-medium tabular-nums">{parsedKey.length}</span>{" "}
            answer{parsedKey.length === 1 ? "" : "s"}
            {parsedKey.length > 0 && parsedKey.length !== totalQuestions && (
              <span className="ml-1 text-warning">
                (expected {totalQuestions})
              </span>
            )}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || parsedKey.length === 0}
            onClick={() => void runReconcile(false)}
          >
            {reconciling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            Preview mismatches
          </Button>
          <Button
            size="sm"
            disabled={busy || parsedKey.length === 0}
            onClick={() => void runReconcile(true)}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            Apply key &amp; commit
          </Button>
        </div>
      </div>

      {result && (
        <div className="rounded-card border bg-card p-4">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              {result.mismatches.length === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
              )}
              {result.match_count}/{result.total_questions} match the parsed key
            </span>
            <Badge variant="outline" className="tabular-nums">
              key length {result.key_length}
            </Badge>
            {result.key_length !== result.total_questions && (
              <Badge variant="warning">
                length mismatch (parsed {result.total_questions})
              </Badge>
            )}
          </div>
          {result.mismatches.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No mismatches — the parsed answers agree with the key.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead className="w-16">Parsed</TableHead>
                  <TableHead className="w-16">Key</TableHead>
                  <TableHead>Prompt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.mismatches.map((m) => (
                  <TableRow key={m.index}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {m.index + 1}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono">
                        {m.parsed ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono">
                        {m.key ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                      {m.prompt}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {result.mismatches.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Applying the key replaces the parsed answers above with the key
              values, then commits.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          Can’t find the key? You can commit as-is, but a wrong answer key will
          mis-score every attempt on this section.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10"
          disabled={busy}
          onClick={onForceCommit}
        >
          {committing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : null}
          Commit anyway
        </Button>
      </div>
    </div>
  );
}
