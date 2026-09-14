import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FileText, FileUp, GraduationCap, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@lsat/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icon } from '@lsat/components/ui/icon';
import { PageLayout } from '@lsat/components/page-layout';
import { SystemNotice } from '@lsat/components/system-notice';
import { IllustrationImport } from '@lsat/components/illustrations';
import { ScrollArea } from '@lsat/components/ui/scroll-area';
import { ApiError, api } from '@lsat/lib/api';
import { useImportCommit } from '@lsat/lib/mutations';
import { ImportNameField, isImportNameValid } from '@lsat/components/import/import-name-field';
import { ImportStructureTree } from '@lsat/components/import/import-structure-tree';
import { ImportJobHistory } from '@lsat/components/import/import-job-history';
import { ImportIntegrityGate } from '@lsat/components/import/import-integrity-gate';
import { ImportStepper } from '@lsat/components/import/import-stepper';
import { getImportCountMismatch, rawQuestionLineIndices } from '@lsat/lib/importDiff';
import { pickPdfFile, readFileFromPath } from '@lsat/lib/electron';
import { toast } from '@lsat/lib/toast';
import type { ImportIntegrityError, ImportIntegrityIssue, ImportParseResult, ParsedPrepTest } from '@lsat/lib/types';

/** Narrow an unknown ApiError.detail into the D1 integrity-gate payload. */
function integrityIssuesFrom(err: unknown): ImportIntegrityIssue[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const detail = err.detail as Partial<ImportIntegrityError> | undefined;
  if (detail?.error === 'unresolved_integrity_issues' && Array.isArray(detail.issues)) {
    return detail.issues;
  }
  return null;
}

type Step = 'upload' | 'verify' | 'done';

function RawTextPane({ rawText, highlightLines }: { rawText: string; highlightLines: Set<number> }) {
  const lines = rawText.split('\n');
  return (
    <pre className="whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-foreground/90">
      {lines.map((line, i) => (
        <span
          key={i}
          className={highlightLines.has(i) ? 'block rounded-sm bg-warning-subtle px-1 ring-1 ring-warning/40' : 'block'}
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export default function Import() {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<Step>('upload');
  const [parsing, setParsing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [edited, setEdited] = useState<ParsedPrepTest | null>(null);
  const [rawText, setRawText] = useState('');
  const [committedId, setCommittedId] = useState<number | null>(null);
  const importCommit = useImportCommit();
  const [error, setError] = useState<string | null>(null);
  // Wave 1.6 — opt-in flag for "this PDF is curated training data". Off by
  // default; turning it on prefers these items as parents in Tier-B generation
  // and feeds them into the Wave 6 QLoRA training set.
  const [trainingEligible, setTrainingEligible] = useState(false);
  const [trainingNotes, setTrainingNotes] = useState('');
  // D1 — integrity gate: populated when commit returns HTTP 409.
  const [integrityIssues, setIntegrityIssues] = useState<ImportIntegrityIssue[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const parsingRef = useRef(false);
  const choosePendingRef = useRef(false);
  const selectedFileRef = useRef<File | null>(null);
  // 4.3 — guards the "open-with" handoff so we read+parse the launch file at
  // most once even though the route may re-render. Holds the current handleFile.
  const handleFileRef = useRef<(file: File) => void>(() => {});
  const openedPathRef = useRef<string | null>(null);

  const countMismatch = useMemo(() => (edited ? getImportCountMismatch(edited, rawText) : null), [edited, rawText]);
  const rawHighlightLines = useMemo(() => {
    if (!countMismatch || Math.abs(countMismatch.delta) < 1) {
      return new Set<number>();
    }
    return rawQuestionLineIndices(rawText);
  }, [countMismatch, rawText]);

  async function handleFile(file: File) {
    if (parsingRef.current) return;
    parsingRef.current = true;
    selectedFileRef.current = file;
    setParsing(true);
    setError(null);
    setIntegrityIssues(null);
    try {
      setRawText((await file.text()).slice(0, 8000));
    } catch {
      setRawText(`[binary PDF: ${file.name}]`);
    }
    try {
      const res = await api.importParse(file);
      setParsed(res);
      setEdited(res.parsed);
      setStep('verify');
    } catch (err) {
      setParsed(null);
      setEdited(null);
      setStep('upload');
      const message =
        err instanceof ApiError
          ? `Parser failed: ${err.message}`
          : 'Parser unavailable. Start the local backend and try again; no demo parse was generated.';
      setError(message);
      toast.error(message);
    } finally {
      parsingRef.current = false;
      setParsing(false);
    }
  }

  // Keep the ref pointed at the latest handleFile so the open-with effect below
  // can invoke it without taking handleFile as a dependency (it's recreated each
  // render).
  handleFileRef.current = handleFile;

  // 4.3 — when routed here from "Open with LSAT Lab" (App.tsx passes the file
  // path in history state), read that file and run it through the wizard. The
  // state is cleared after consuming so a refresh/back-nav won't re-import.
  useEffect(() => {
    const openFile = (location.state as { openFile?: string } | null)?.openFile;
    if (!openFile || openedPathRef.current === openFile) return;
    openedPathRef.current = openFile;
    navigate(location.pathname, { replace: true, state: null });
    void readFileFromPath(openFile).then((file) => {
      if (file) handleFileRef.current(file);
      else toast.error('Could not open the selected file.');
    });
  }, [location.state, location.pathname, navigate]);

  async function chooseFile() {
    if (parsingRef.current || choosePendingRef.current) return;
    choosePendingRef.current = true;
    try {
      const desktopFile = await pickPdfFile();
      if (desktopFile) {
        void handleFile(desktopFile);
        return;
      }
      fileRef.current?.click();
    } finally {
      choosePendingRef.current = false;
    }
  }

  function isSupportedFile(file: File) {
    return file.type === 'application/pdf' || /\.(pdf|txt)$/i.test(file.name);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    if (parsingRef.current) return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!isSupportedFile(file)) {
      const message = 'Choose a PDF or plain-text PrepTest file.';
      setError(message);
      toast.error(message);
      return;
    }
    void handleFile(file);
  }

  function retryParse() {
    const file = selectedFileRef.current;
    if (file && !parsingRef.current) void handleFile(file);
  }

  async function resumeJob(jobId: number) {
    setIntegrityIssues(null);
    try {
      const detail = await api.getImportJob(jobId);
      setParsed({
        job_id: detail.job_id,
        parsed: detail.parsed,
        warnings: detail.warnings,
      });
      setEdited(detail.parsed);
      setRawText('(resume — raw PDF text not stored; compare counts on the right)');
      setStep('verify');
    } catch {
      toast.error('Could not load import job.');
    }
  }

  // Shared commit path. `force` re-commits past the integrity gate; a non-force
  // commit that returns 409 surfaces the integrity gate instead of "done".
  function runCommit(structure: ParsedPrepTest, force: boolean) {
    if (!parsed) return;
    setError(null);
    importCommit.mutate(
      {
        jobId: String(parsed.job_id),
        parsed: structure,
        force,
        trainingEligible,
        trainingNotes,
      },
      {
        onSuccess: (res) => {
          setIntegrityIssues(null);
          setCommittedId(res.preptest_id);
          setStep('done');
        },
        onError: (err) => {
          const issues = integrityIssuesFrom(err);
          if (issues) {
            // Stay on the verify step and show the integrity gate.
            setIntegrityIssues(issues);
            return;
          }
          setCommittedId(null);
          setStep('verify');
          const message =
            err instanceof ApiError
              ? `Commit failed: ${err.message}`
              : 'Commit failed before the import could be persisted.';
          setError(message);
          toast.error(message);
        },
      },
    );
  }

  function commit() {
    if (!parsed || !edited) return;
    if (!isImportNameValid(edited.name)) {
      toast.error('Enter a valid PrepTest name before committing.');
      return;
    }
    if (trainingEligible && !trainingNotes.trim()) {
      toast.error('Add a source description before marking as training data.');
      return;
    }
    runCommit(edited, false);
  }

  if (step === 'done')
    return (
      <PageLayout title="Import complete" eyebrow="Library · Import" icon={FileUp} width="md">
        <ImportStepper current="done" className="mb-6" />
        <div className="rounded-card border bg-card p-8 text-center shadow-sm">
          <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
          <p className="mt-4 text-sm text-muted-foreground">
            {committedId != null ? `Created PrepTest #${committedId}.` : (error ?? 'Committed.')}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Button onClick={() => navigate('/preptests')}>View PrepTests</Button>
            <Button variant="outline" onClick={() => setStep('upload')}>
              Import another
            </Button>
          </div>
        </div>
      </PageLayout>
    );

  if (step === 'verify' && edited)
    return (
      <PageLayout
        title="Verify parsed structure"
        eyebrow="Library · Import"
        icon={FileUp}
        width="2xl"
        actions={
          <Button onClick={commit} disabled={importCommit.isPending}>
            {importCommit.isPending ? 'Committing…' : 'Commit import'}
          </Button>
        }
      >
        <div className="space-y-4">
          <ImportStepper current="verify" />

          {error && (
            <SystemNotice tone="destructive" icon={AlertTriangle} title="Import not persisted">
              {error}
            </SystemNotice>
          )}

          {integrityIssues && (
            <ImportIntegrityGate
              jobId={parsed?.job_id ?? edited.name}
              parsed={edited}
              issues={integrityIssues}
              committing={importCommit.isPending}
              onReconciledCommit={(corrected) => {
                setEdited(corrected);
                runCommit(corrected, false);
              }}
              onForceCommit={() => runCommit(edited, true)}
            />
          )}

          {countMismatch && Math.abs(countMismatch.delta) >= 1 && (
            <SystemNotice tone="warning" icon={AlertTriangle} title="Question count mismatch">
              Raw text suggests ~{countMismatch.rawTotal} questions, parsed structure has {countMismatch.parsedTotal} (
              {countMismatch.delta > 0 ? `${countMismatch.delta} fewer parsed` : `${-countMismatch.delta} extra parsed`}
              ). Highlighted lines in the raw pane are likely question boundaries.
            </SystemNotice>
          )}

          {parsed && parsed.warnings.length > 0 && (
            <SystemNotice
              tone="warning"
              icon={AlertTriangle}
              title={`Parser ${parsed.warnings.length === 1 ? 'warning' : 'warnings'}`}
            >
              <ul className="space-y-1">
                {parsed.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </SystemNotice>
          )}

          {/* Wave 1.6 — training-corpus opt-in. Defaults off so a casual import
            never flows into the LoRA training set; the user explicitly toggles
            it when they're importing a vouched-for PDF (e.g. PT they own).
            Raised to the integrity-gate's visual grade (rounded-card + bg-card). */}
          <div className="rounded-card border bg-surface-1/60 p-4">
            <div className="flex items-start gap-3">
              <Checkbox
                id="trainingEligible"
                checked={trainingEligible}
                onCheckedChange={(v) => setTrainingEligible(v === true)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="trainingEligible"
                  className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold"
                >
                  <Icon as={GraduationCap} size="sm" className="text-muted-foreground" />
                  Mark this PDF as training data
                </Label>
                <p className="text-xs text-muted-foreground">
                  Questions become preferred few-shot anchors in Tier-B generation and will feed the local QLoRA
                  training corpus later. Use only for PDFs you own (your purchased PrepTests) or material LSAC publicly
                  posted.
                </p>
              </div>
            </div>
            {trainingEligible && (
              <div className="ml-7 mt-3 space-y-1.5">
                <Label className="text-xs text-muted-foreground" htmlFor="trainingNotes">
                  Source description (required)
                </Label>
                <Input
                  id="trainingNotes"
                  type="text"
                  placeholder="e.g. PT 89, June 2024 (official LSAC PDF)"
                  value={trainingNotes}
                  onChange={(e) => setTrainingNotes(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="flex flex-col border-border/80 shadow-sm">
              <CardHeader className="flex-row items-center gap-2 space-y-0">
                <Icon as={FileText} size="sm" className="text-muted-foreground" />
                <CardTitle className="text-base">Raw extracted text</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="scroll-thin h-[70vh] rounded-md border bg-surface-1">
                  <RawTextPane rawText={rawText || '(no preview)'} highlightLines={rawHighlightLines} />
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="flex flex-col border-border/80 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Parsed structure (editable)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <ScrollArea className="h-[70vh] pr-3">
                  <div className="space-y-4">
                    <ImportNameField value={edited.name} onChange={(name) => setEdited({ ...edited, name })} />
                    <ImportStructureTree
                      edited={edited}
                      warnings={parsed?.warnings ?? []}
                      countMismatch={countMismatch}
                      onEdit={setEdited}
                    />
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageLayout>
    );

  return (
    <PageLayout
      title="Import a PrepTest"
      eyebrow="Library · Import"
      icon={FileUp}
      description="Upload a PDF you own (your purchased PrepTests) or one LSAC has publicly posted — we extract text and propose structure for your review, fully on-device."
      width="md"
    >
      <div className="space-y-4">
        <ImportStepper current="upload" />
        <ImportJobHistory onResume={(id) => void resumeJob(id)} />
        <Card className="border-border/80 shadow-sm">
          <CardContent className="pt-[var(--card-pad)]">
            <button
              type="button"
              onClick={() => void chooseFile()}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!parsingRef.current) setDragActive(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                event.preventDefault();
                setDragActive(false);
              }}
              onDrop={handleDrop}
              aria-busy={parsing}
              aria-label="Click to choose a PDF, or drop one here"
              className={`flex w-full flex-col items-center gap-3 rounded-card border-2 border-dashed p-12 text-center transition-colors ${
                dragActive ? 'border-primary bg-primary/10' : 'bg-surface-1/40 hover:bg-surface-2'
              }`}
            >
              {parsing ? (
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              ) : (
                <FileUp className="h-8 w-8 text-muted-foreground" />
              )}
              <span className="text-sm font-medium">
                {parsing ? 'Parsing…' : dragActive ? 'Drop to parse this file' : 'Choose or drop a PDF'}
              </span>
              <span className="text-xs text-muted-foreground">
                PDFs you own or that LSAC publicly posted. Drop a PDF here or choose one from disk; we extract text,
                then an offline on-device AI pass proposes the question/passage layout for your review — nothing
                leaves your machine.
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void handleFile(f);
              }}
            />
            {error && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
                <p>{error}</p>
                {selectedFileRef.current && (
                  <Button type="button" size="sm" variant="outline" onClick={retryParse} disabled={parsing}>
                    {parsing ? 'Retrying…' : 'Retry parse'}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="flex justify-center pt-2 opacity-80">
        <IllustrationImport />
      </div>
    </PageLayout>
  );
}
