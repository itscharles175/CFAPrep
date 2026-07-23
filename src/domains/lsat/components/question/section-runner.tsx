import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Flag, LayoutGrid, Minimize2, Maximize2 } from 'lucide-react';
import { Logo } from '@lsat/components/logo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import HandsFreeController from '@/components/a11y/HandsFreeController';
import { ChoiceList } from '@lsat/components/question/choice-list';
import { LineReferenceChips, PassageScrollPane, usePassageScroll } from '@lsat/components/question/line-reference';
import { NavigatorStrip, ProgressDots, type NavItem } from '@lsat/components/question/navigator-strip';
import { QuestionOverview } from '@lsat/components/question/question-overview';
import { HighlighterToolbar } from '@lsat/components/question/highlighter-toolbar';
import { AnnotatedText } from '@lsat/components/question/annotated-text';
import { ReadingControls } from '@lsat/components/question/reading-controls';
import { ExamTimer, PaceBar, ResizableSplit } from '@lsat/components/question/exam-chrome';
import { ClockStore, useClockTime } from '@lsat/components/question/section-clock';
import { LiveRegion } from '@lsat/components/question/live-region';
import type { AnnotationStyle, Highlight } from '@lsat/components/question/highlightable-text';
import { TypeBadge } from '@lsat/components/viz';
import { answerLabelFromAction, getKeyboardMap, resolveExamKey } from '@lsat/lib/keyboardMap';
// K4-cmd — the runner no longer depends on the LSAT palette's
// `useCommandPalette`; it registers its exam affordances through a neutral seam
// (`useExamCommands`) its own domain owns, so the palette can be deleted (K4-13)
// without breaking the runner. The runner's exam timing / focus / keyboard
// behavior is unchanged — it is driven by the local keydown handler, not the
// palette.
import { useExamCommands } from '@lsat/lib/examCommands';
import { cn } from '@lsat/lib/utils';
import {
  adjustedTimeLimitSec,
  getAccommodations,
  getNotes,
  setNotes,
  useReadingPrefs,
  useRcSplit,
  readingClasses,
  nextReadingSize,
  prevReadingSize,
  type MarginNote,
} from '@lsat/lib/prefs';
import { api } from '@lsat/lib/api';
import { getQuestionAnnotations, setQuestionAnnotations } from '@lsat/lib/annotationPrefs';
import { ScratchPad } from '@lsat/components/exam/scratch-pad';
import { RcLineRuler } from '@lsat/components/question/rc-line-ruler';
import { getDrillTimeCapMin } from '@lsat/lib/drillPrefs';
import { setResume } from '@lsat/lib/resume';
import { blankState, type ChoiceEventRecord, type QState } from '@lsat/components/question/section-state';
import { draftKeyForSection, loadSessionDraft, saveSessionDraft } from '@lsat/lib/sessionDraft';
import { openPassagePopout } from '@lsat/lib/electron';
import type { SectionDetail } from '@lsat/lib/types';

export { blankState };
export type { ChoiceEventRecord, QState };

export function buildSectionHandsFreeQuestion({
  isRc,
  passageText,
  stem,
  prompt,
}: {
  isRc: boolean;
  passageText?: string | null;
  stem?: string | null;
  prompt: string;
}): string {
  const parts: string[] = [];
  if (isRc && passageText) parts.push(`Passage. ${passageText}`);
  if (!isRc && stem) parts.push(`Stimulus. ${stem}`);
  parts.push(`Question. ${prompt}`);
  return parts.filter((part) => part.trim()).join('\n\n');
}

/**
 * The shared timed-section experience: calm chrome, real timer + pace bar,
 * reading controls, annotation, focus mode and the upgraded navigator. Used by
 * both the standalone TakeSection screen and the full-exam flow (Exam.tsx).
 *
 * It owns per-question UI state and the countdown, and reports finished state
 * via callbacks. It does NOT show any correctness feedback while running
 * (Test-Mode discipline, docs/06 §4.5).
 */
export function SectionRunner({
  section,
  states,
  setStates,
  headerLabel,
  sampleBadge,
  onFinish,
  finishLabel = 'Finish section',
  jumpToIndex,
  onJumpConsumed,
  resumePath,
  resumeLabel,
  attemptId = null,
  timed = true,
  timeCapMin,
  draftKey,
}: {
  section: SectionDetail;
  states: Record<number, QState>;
  setStates: React.Dispatch<React.SetStateAction<Record<number, QState>>>;
  headerLabel: string;
  sampleBadge?: boolean;
  /** Called when the user finishes / time expires. */
  onFinish: (timeExpired: boolean) => void;
  finishLabel?: string;
  jumpToIndex?: number | null;
  onJumpConsumed?: () => void;
  resumePath?: string;
  resumeLabel?: string;
  /** When set, sync highlights to server annotation endpoints when online. */
  attemptId?: number | null;
  /** When false, no auto-submit on timeout. */
  timed?: boolean;
  /** Optional client cap (minutes), e.g. drills. */
  timeCapMin?: number | null;
  /**
   * Stable scope for the crash-safe draft (1.5). When omitted, a draft scope is
   * derived from the section id so refresh-resume still works for ad-hoc runs.
   * Parents that own a session id should pass an explicit key so each
   * section/exam-section gets its own slot. Pass `null` to disable persistence.
   */
  draftKey?: string | null;
}) {
  const questions = useMemo(() => section.questions ?? [], [section]);
  const isRC = section.type === 'RC';
  const acc = getAccommodations();
  const capMin = timeCapMin ?? getDrillTimeCapMin();
  const baseLimit = adjustedTimeLimitSec(section.time_limit_sec, section.type);
  const limitSec = capMin != null ? capMin * 60 : timed ? baseLimit : baseLimit * 4;

  // 1.5 — crash-safe draft scope. `null` disables persistence; `undefined`
  // falls back to a section-derived scope so even ad-hoc runs survive a refresh.
  const draftScope = draftKey === null ? null : (draftKey ?? draftKeyForSection(section.id));
  // Read the persisted draft exactly once for the initial render so the
  // question index and remaining time restore in step with the answers.
  const initialDraft = useRef(draftScope ? loadSessionDraft(draftScope) : null).current;

  const [index, setIndex] = useState(initialDraft?.index ?? 0);
  // A2.1 — the 1-second countdown lives in an external store, NOT React state, so
  // a tick re-renders only the clock subscribers (numerals, pace bar, focus
  // hairline) instead of the whole question/passage/choice tree. Created once
  // (lazy ref init), seeded from the draft's remaining time when resuming.
  const clockRef = useRef<ClockStore | null>(null);
  if (clockRef.current === null) {
    clockRef.current = new ClockStore(initialDraft?.timeLeft != null ? initialDraft.timeLeft : limitSec, {
      deadlineMs: initialDraft?.deadlineMs ?? null,
    });
  }
  const clock = clockRef.current;
  const [timerHidden, setTimerHidden] = useState(acc.hideTimerDefault);
  const [activeColor, setActiveColor] = useState<AnnotationStyle | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  // R9 zen focus mode — chrome fades after a beat of no input; any pointer/key
  // activity wakes it. Starts awake; only consulted while focusMode is on.
  const [chromeAwake, setChromeAwake] = useState(true);
  // R9 — the summonable question overview map (progress-only panorama).
  const [overviewOpen, setOverviewOpen] = useState(false);

  const [reading, setReading] = useReadingPrefs();
  const [split, setSplit] = useRcSplit();
  const { ref: passageScrollRef, scrollToRange } = usePassageScroll();
  const passagePaneRef = useRef<HTMLDivElement>(null);

  // Push the rehydrated per-question state up to the parent on mount. The parent
  // owns `states`; we only seed it from the draft when it has nothing yet so we
  // never clobber in-memory progress (e.g. a remount while still working).
  const rehydratedRef = useRef(false);
  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    if (!initialDraft) return;
    setStates((prev) => (Object.keys(prev).length > 0 ? prev : initialDraft.states));
  }, [initialDraft, setStates]);

  useEffect(() => {
    if (jumpToIndex == null || jumpToIndex < 0 || jumpToIndex >= questions.length) return;
    setIndex(jumpToIndex);
    onJumpConsumed?.();
  }, [jumpToIndex, questions.length, onJumpConsumed]);

  useEffect(() => {
    if (!resumePath) return;
    setResume({
      kind: 'section',
      label: resumeLabel ?? headerLabel,
      path: resumePath,
      index,
      updatedAt: new Date().toISOString(),
    });
  }, [index, resumePath, resumeLabel, headerLabel]);

  const cur = states[index] ?? blankState();
  const q = questions[index];
  // Notes are keyed by question id (or passage-bearing question). Persisted.
  const noteKey = q?.id;
  const [notes, setNotesState] = useState<MarginNote[]>([]);
  useEffect(() => {
    setNotesState(noteKey != null ? getNotes(noteKey) : []);
  }, [noteKey]);
  const updateNotes = useCallback(
    (next: MarginNote[]) => {
      setNotesState(next);
      if (noteKey != null) setNotes(noteKey, next);
    },
    [noteKey],
  );

  useEffect(() => {
    if (noteKey == null) return;
    let cancelled = false;
    void (async () => {
      let highlights = getQuestionAnnotations(noteKey);
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        const remote = await api.listAnnotations(noteKey, attemptId ?? undefined);
        if (remote && remote.length > 0) {
          highlights = remote as Highlight[];
          setQuestionAnnotations(noteKey, highlights);
        }
      }
      if (cancelled || highlights.length === 0) return;
      setStates((prev) => {
        const st = prev[index] ?? blankState();
        if (st.highlights.length > 0) return prev;
        return { ...prev, [index]: { ...st, highlights } };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [noteKey, index, setStates, attemptId]);

  // 1.2 — wall-clock when the current question's timing started (reset on index
  // change AND on an explicit flush), so choice-event `time_ms` and the
  // per-question elapsed accumulator both measure from the right moment.
  const questionOpenedAt = useRef<number>(Date.now());
  const indexRef = useRef(index);
  indexRef.current = index;

  // Commit the time spent on the CURRENT question into its state and restart the
  // clock. Called on finish / auto-submit so the LAST question's elapsed time is
  // counted BEFORE the parent persists (the accumulator's unmount cleanup runs
  // too late). Resetting questionOpenedAt makes the later cleanup a near no-op,
  // so an explicit flush and the cleanup never double-count.
  const flushCurrentTime = useCallback(() => {
    const now = Date.now();
    const dt = now - questionOpenedAt.current;
    questionOpenedAt.current = now;
    if (dt <= 0) return;
    const i = indexRef.current;
    setStates((prev) => {
      const c = prev[i] ?? blankState();
      return { ...prev, [i]: { ...c, timeMs: c.timeMs + dt } };
    });
  }, [setStates]);

  // A2.1 — Countdown (skipped for untimed — no auto-submit). The interval lives
  // inside the ClockStore so a tick re-renders only the clock subscribers, not
  // the question tree. On reaching 0 the store stops itself and fires the expiry
  // callback once → flush the current question's time, then auto-submit.
  useEffect(() => {
    if (!timed) return;
    clock.start(() => {
      flushCurrentTime();
      onFinish(true);
    });
    return () => clock.stop();
    // onFinish/flushCurrentTime intentionally excluded so a changed callback
    // identity does not tear down / restart the interval mid-second; the effect
    // below keeps the expiry callback current instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timed, clock]);

  // Keep the expiry callback current without restarting the interval, so the
  // auto-submit always fires the latest `onFinish` even if the parent re-renders.
  useEffect(() => {
    clock.setOnExpire(() => {
      flushCurrentTime();
      onFinish(true);
    });
  }, [clock, onFinish, flushCurrentTime]);

  // Per-question elapsed accumulator: on index change / unmount, commit the time
  // spent on the question being LEFT. Uses questionOpenedAt.current (which
  // flushCurrentTime also resets), so an explicit flush + this cleanup never
  // double-count.
  useEffect(() => {
    questionOpenedAt.current = Date.now();
    const leavingIndex = index;
    return () => {
      const dt = Date.now() - questionOpenedAt.current;
      if (dt <= 0) return;
      setStates((prev) => {
        const c = prev[leavingIndex] ?? blankState();
        return { ...prev, [leavingIndex]: { ...c, timeMs: c.timeMs + dt } };
      });
    };
  }, [index, setStates]);

  // 1.5 — debounced crash-safe draft persistence. We mirror the latest values in
  // refs so an unmount / `beforeunload` flush captures the freshest state even
  // between debounce ticks. `timed`/`limitSec` are stable for a given run.
  //
  // A2.1 — `timeLeft` is no longer React state, so the latest remaining time is
  // read straight from the clock store (`clock.get()`) at save/flush time. The
  // draft is still re-saved roughly every second WITHOUT re-rendering the parent:
  // a clock subscription re-arms the same 500ms debounce as ticks land, so a
  // crash mid-question still leaves a fresh `timeLeft`, exactly as before.
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraft = useRef({ states, index });
  latestDraft.current = { states, index };
  const saveDraftNow = useCallback(() => {
    if (!draftScope) return;
    const d = latestDraft.current;
    saveSessionDraft(draftScope, {
      states: d.states,
      index: d.index,
      timeLeft: timed ? clock.get() : null,
      deadlineMs: timed ? clock.getDeadlineMs() : null,
    });
  }, [draftScope, timed, clock]);
  const scheduleDraftSave = useCallback(() => {
    if (!draftScope) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(saveDraftNow, 500);
  }, [draftScope, saveDraftNow]);

  // Re-arm the debounce when the answers / index change…
  useEffect(() => {
    scheduleDraftSave();
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  }, [states, index, scheduleDraftSave]);

  // …and once per second as the clock ticks (so idle time still persists), all
  // without re-rendering the question tree — the listener lives outside React.
  useEffect(() => {
    if (!draftScope || !timed) return;
    return clock.subscribe(scheduleDraftSave);
  }, [draftScope, timed, clock, scheduleDraftSave]);

  // Flush synchronously on unmount and when the tab is hidden/closed so a crash
  // mid-question still leaves a recoverable draft.
  useEffect(() => {
    if (!draftScope) return;
    const flush = saveDraftNow;
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [draftScope, saveDraftNow]);

  const setCur = useCallback(
    (patch: Partial<QState>) => {
      setStates((prev) => ({
        ...prev,
        [index]: { ...(prev[index] ?? blankState()), ...patch },
      }));
    },
    [index, setStates],
  );

  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setHighlights = useCallback(
    (highlights: Highlight[]) => {
      setCur({ highlights });
      if (noteKey == null) return;
      setQuestionAnnotations(noteKey, highlights);
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => {
        void api.saveAnnotations(noteKey, highlights, attemptId ?? undefined);
      }, 400);
    },
    [noteKey, setCur, attemptId],
  );

  // A2.2 — a stable line-reference jump handler. Inlined it captured
  // `cur.highlights` fresh on every render (a new closure each time), which would
  // defeat memoization of anything it is passed to. As a `useCallback` it only
  // changes when the highlights it must preserve actually change.
  const jumpToLineRange = useCallback(
    (start: number, end: number) => {
      scrollToRange(start, end);
      setHighlights([...cur.highlights.filter((h) => h.color !== 'yellow'), { start, end, color: 'yellow' as const }]);
    },
    [scrollToRange, setHighlights, cur.highlights],
  );

  // 1.2 — append a process-of-elimination event to the current question's
  // trace. `order_index` is the running length; `time_ms` is since open. Cheap:
  // one state update piggy-backed on the existing answer/eliminate write.
  const recordChoiceEvent = useCallback(
    (label: string, action: ChoiceEventRecord['action']) => {
      setStates((prev) => {
        const c = prev[index] ?? blankState();
        const event: ChoiceEventRecord = {
          label,
          action,
          order_index: c.choiceEvents.length,
          time_ms: Math.max(0, Math.round(Date.now() - questionOpenedAt.current)),
        };
        return {
          ...prev,
          [index]: { ...c, choiceEvents: [...c.choiceEvents, event] },
        };
      });
    },
    [index, setStates],
  );

  const select = useCallback(
    (label: string) => {
      setCur({ answer: label });
      recordChoiceEvent(label, 'select');
    },
    [setCur, recordChoiceEvent],
  );

  const toggleEliminate = useCallback(
    (label: string) => {
      const next = new Set(cur.eliminated);
      const removing = next.has(label);
      if (removing) next.delete(label);
      else next.add(label);
      setCur({ eliminated: next });
      recordChoiceEvent(label, removing ? 'restore' : 'eliminate');
    },
    [cur.eliminated, setCur, recordChoiceEvent],
  );

  const go = useCallback(
    (next: number) => {
      if (next < 0 || next >= questions.length) return;
      setIndex(next);
    },
    [questions.length],
  );

  // Keyboard: bindings from Settings (defaults A–E, F, arrows); 1–9 jump.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const qq = questions[index];
      if (!qq) return;

      // R9 — `o` summons the question overview panorama (progress-only map).
      if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOverviewOpen((v) => !v);
        return;
      }

      if (e.key >= '1' && e.key <= '9') {
        const target = Number(e.key) - 1;
        if (target < questions.length) {
          e.preventDefault();
          go(target);
        }
        return;
      }

      const map = getKeyboardMap();
      const resolved = resolveExamKey(e, map);
      if (!resolved) return;

      if (resolved === 'eliminate') {
        if (cur.answer) {
          e.preventDefault();
          toggleEliminate(cur.answer);
        }
        return;
      }
      if (resolved === 'flag') {
        e.preventDefault();
        setCur({ flagged: !cur.flagged });
        return;
      }
      if (resolved === 'prev') {
        e.preventDefault();
        go(index - 1);
        return;
      }
      if (resolved === 'next') {
        e.preventDefault();
        go(index + 1);
        return;
      }
      const label = answerLabelFromAction(resolved);
      if (label) {
        if (label === 'E' && !qq.choices.some((c) => c.label === 'E')) return;
        e.preventDefault();
        select(label);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, questions, cur.answer, cur.flagged, select, toggleEliminate, setCur, go]);

  // Command-palette actions (docs prompt §4.2 / §4.5 / §4.3). Registered via the
  // neutral `useExamCommands` seam (K4-cmd): identical commands, but no hard
  // dependency on the LSAT palette.
  const { register } = useExamCommands();
  useEffect(() => {
    return register([
      {
        id: 'exam-focus',
        group: 'Exam',
        label: 'Toggle focus mode',
        keywords: ['distraction', 'calm', 'zen', 'immersive'],
        perform: () => setFocusMode((f) => !f),
      },
      {
        id: 'exam-overview',
        group: 'Exam',
        label: 'Question overview map',
        keywords: ['panorama', 'all questions', 'grid', 'map', 'jump'],
        perform: () => setOverviewOpen(true),
      },
      {
        id: 'exam-reading-up',
        group: 'Exam',
        label: 'Increase reading size',
        perform: () => setReading({ size: nextReadingSize(reading.size) }),
      },
      {
        id: 'exam-reading-down',
        group: 'Exam',
        label: 'Decrease reading size',
        perform: () => setReading({ size: prevReadingSize(reading.size) }),
      },
      {
        id: 'exam-flag',
        group: 'Exam',
        label: 'Flag this question',
        keywords: ['mark'],
        perform: () => setCur({ flagged: !cur.flagged }),
      },
    ]);
  }, [register, reading.size, setReading, cur.flagged, setCur]);

  // R9 zen focus mode — idle detection. While focus mode is on, the chrome
  // (header, footer, the keys hint) fades after a short idle window and any
  // pointer move / key / scroll / touch wakes it. Disabled entirely outside
  // focus mode so the normal exam UI never auto-hides. Layout-only — it changes
  // visibility, never anything Test-Mode-sensitive.
  useEffect(() => {
    if (!focusMode) {
      setChromeAwake(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sleep = () => setChromeAwake(false);
    const wake = () => {
      setChromeAwake(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(sleep, 2600);
    };
    // Arm immediately so it dims even if the user never moves.
    wake();
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [focusMode]);

  // Whether chrome should currently be visible. Outside focus mode: always.
  // Inside focus mode: only while awake (or the overview is open).
  const chromeVisible = !focusMode || chromeAwake || overviewOpen;

  const answeredCount = useMemo(() => Object.values(states).filter((s) => s.answer).length, [states]);

  const navItems: NavItem[] = useMemo(
    () =>
      questions.map((qq, i) => {
        const s = states[i] ?? blankState();
        return {
          answered: !!s.answer,
          flagged: s.flagged,
          hasEliminations: s.eliminated.size > 0,
          timeMs: s.timeMs,
          qType: qq.q_type,
          previewText: (qq.stem || qq.prompt).slice(0, 80),
        };
      }),
    [questions, states],
  );

  const passage = q?.passage_id != null ? section.passages.find((p) => p.id === q.passage_id) : undefined;

  const rcls = readingClasses(reading);
  const handsFreeQuestion = q
    ? buildSectionHandsFreeQuestion({
        isRc: isRC,
        passageText: passage?.text,
        stem: q.stem,
        prompt: q.prompt,
      })
    : '';
  const handsFreeOptions = useMemo(
    () => (q ? q.choices.map((choice) => ({ letter: choice.label, text: choice.text })) : []),
    [q],
  );
  const handleHandsFreeSelect = useCallback(
    (choiceIndex: number) => {
      const label = questions[index]?.choices[choiceIndex]?.label;
      if (!label) return;
      select(label);
    },
    [index, questions, select],
  );

  const stimulusBlock = (
    <PassageScrollPane scrollRef={passageScrollRef}>
      <div ref={passagePaneRef} className="relative p-8">
        <div className="type-overline mb-2 flex items-center justify-between gap-2 text-muted-foreground">
          <span>{isRC ? `Passage${passage?.topic ? ` · ${passage.topic}` : ''}` : 'Stimulus'}</span>
          <div className="flex items-center gap-2">
            {isRC && passage && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 normal-case tracking-normal hover:bg-accent hover:text-foreground"
                title="Open passage in a separate window"
                onClick={() => void openPassagePopout({ topic: passage.topic, text: passage.text })}
              >
                <ExternalLink className="h-3.5 w-3.5" /> Pop out
              </button>
            )}
            {isRC && <RcLineRuler containerRef={passagePaneRef} />}
          </div>
        </div>
        {isRC && passage ? (
          <AnnotatedText
            text={passage.text}
            highlights={cur.highlights}
            onHighlightsChange={setHighlights}
            activeColor={activeColor}
            noteMode={noteMode}
            notes={notes}
            onNotesChange={updateNotes}
            className={rcls}
          />
        ) : (
          !isRC &&
          q?.stem && (
            <AnnotatedText
              text={q.stem}
              highlights={cur.highlights}
              onHighlightsChange={setHighlights}
              activeColor={activeColor}
              noteMode={noteMode}
              notes={notes}
              onNotesChange={updateNotes}
              className={rcls}
            />
          )
        )}
      </div>
    </PassageScrollPane>
  );

  const questionBlock = (
    <div className={cn('p-8', isRC && 'sticky top-0')}>
      <div className="mx-auto max-w-2xl space-y-5">
        {q && (
          <>
            <div className="flex items-center gap-2">
              <TypeBadge qType={q.q_type} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* C5 — wrap long unbroken tokens in the prompt (offset-safe). */}
              <p className="flex-1 break-words font-medium leading-relaxed">{q.prompt}</p>
              {isRC && passage && (
                <LineReferenceChips prompt={q.prompt} passageText={passage.text} onHighlightRange={jumpToLineRange} />
              )}
            </div>
            <HandsFreeController
              question={handsFreeQuestion}
              options={handsFreeOptions}
              onSelect={handleHandsFreeSelect}
              testMode={timed}
              preface={`Question ${index + 1} of ${questions.length}.`}
              className="flex flex-wrap items-center gap-2 rounded-md border bg-surface-1 p-3"
              buttonClassName="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
              primaryButtonClassName="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              secondarySmallButtonClassName="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              statusClassName="w-full text-xs text-muted-foreground"
              confirmRowClassName="flex flex-wrap items-center gap-2"
              mutedTextClassName="text-muted-foreground"
              errorClassName="text-destructive"
              spinnerClassName="animate-spin"
              style={{}}
              statusStyle={{}}
              confirmRowStyle={{}}
            />
            <ChoiceList
              choices={q.choices}
              selected={cur.answer}
              eliminated={cur.eliminated}
              onSelect={select}
              onToggleEliminate={toggleEliminate}
              choiceSize={reading.choiceSize}
              choiceSpacing={reading.choiceSpacing}
            />
            {!focusMode && (
              <p className="text-xs text-muted-foreground">
                Keys: A–E select · F flag · Shift+E eliminate · ←/→ navigate · O overview
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className={cn('flex h-screen flex-col bg-background', reading.focusTheme && 'theme-focus')}>
      {/* 5.6 — polite announcement of the current question for screen readers. */}
      <LiveRegion message={`Question ${index + 1} of ${questions.length}`} />
      {/* Calm Test-Mode header: NO correctness/analytics while the clock runs.
          R9 zen mode — in focus mode the whole header fades out on idle and lifts
          off the layout (pointer-events-none) so the single question owns the
          screen; any input wakes it. The reduced-motion net flattens the fade. */}
      <header
        className={cn(
          'flex h-14 items-center justify-between border-b px-6 transition-opacity duration-500',
          focusMode && !chromeVisible && 'pointer-events-none opacity-0',
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Logo className="h-5 w-5" />
          <span>
            {headerLabel} · Q {index + 1} of {questions.length}
          </span>
          {sampleBadge && (
            <Badge variant="outline" className="ml-2 text-xs">
              sample
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!focusMode && (
            <ClockPaceBar clock={clock} total={questions.length} answered={answeredCount} totalSec={limitSec} />
          )}
          <HighlighterToolbar
            active={activeColor}
            onChange={(c) => {
              setActiveColor(c);
              setNoteMode(false);
            }}
            noteMode={noteMode}
            onToggleNote={() => setNoteMode((n) => !n)}
          />
          <ReadingControls prefs={reading} onChange={setReading} />
          {timed ? (
            <ClockExamTimer
              clock={clock}
              totalSec={limitSec}
              hidden={timerHidden}
              onToggleHidden={() => setTimerHidden((h) => !h)}
              announce
            />
          ) : (
            <span className="text-xs text-muted-foreground">Untimed</span>
          )}
          <Button
            variant={cur.flagged ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCur({ flagged: !cur.flagged })}
          >
            <Flag className="h-4 w-4" />
            {cur.flagged ? 'Flagged' : 'Flag'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Question overview map"
            aria-label="Open question overview map"
            onClick={() => setOverviewOpen(true)}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={focusMode ? 'Exit focus mode' : 'Focus mode'}
            aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'}
            onClick={() => setFocusMode((f) => !f)}
          >
            {focusMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      {/* R9 zen mode — the persistent ambient layer. When the chrome is dimmed
          away, this is the ONLY thing left on screen besides the question: a
          fixed, depleting hairline pinned to the very top edge, plus a small
          always-reachable exit affordance. The hairline carries no numerals;
          the role="timer" label + threshold callouts (below) keep the time
          accessible. Test-Mode safe: nothing here reveals correctness. */}
      {focusMode && (
        <>
          {timed && <FocusHairline clock={clock} limitSec={limitSec} />}
          {/* A small clock the user can summon back by moving the mouse, so the
              time is reachable without leaving focus mode. It is `aria-hidden`:
              the header's ExamTimer (still in the a11y tree though visually
              dimmed) remains the single `role="timer"` + the sole threshold
              announcer, so screen readers get exactly one timer, not two. */}
          {timed && (
            <div
              aria-hidden
              className={cn(
                'fixed right-4 top-3 z-40 transition-opacity duration-500',
                chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              <div className="rounded-full bg-surface-1/80 px-2 py-0.5 shadow-e1 backdrop-blur">
                <ClockExamTimer
                  clock={clock}
                  totalSec={limitSec}
                  hidden={timerHidden}
                  onToggleHidden={() => setTimerHidden((h) => !h)}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Body. RC = resizable split with sticky question; LR = single pane.
          R9 zen mode (LR) — the single question is generously centered with
          breathing vertical whitespace so it owns the screen. */}
      {isRC ? (
        <ResizableSplit fraction={split} onChange={setSplit} left={stimulusBlock} right={questionBlock} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div
            className={cn(
              'mx-auto',
              focusMode ? 'flex min-h-full max-w-2xl flex-col justify-center py-[10vh]' : 'max-w-3xl',
            )}
          >
            {q?.stem && stimulusBlock}
            {questionBlock}
          </div>
        </div>
      )}

      {/* R9 zen mode — the scratch pad is hidden in focus mode (one less surface
          competing with the question); it returns the moment focus mode is off. */}
      {!focusMode && <ScratchPad sectionId={section.id} />}

      {/* Footer: navigator + finish. R9 zen mode — the full numbered strip
          collapses to a thin progress dot-row and the whole footer fades on idle
          (waking with the rest of the chrome), so nothing persistent crowds the
          page except the question and the ambient hairline. */}
      <footer
        className={cn(
          'flex items-center gap-4 border-t px-6 py-3 transition-opacity duration-500',
          focusMode && !chromeVisible && 'pointer-events-none opacity-0',
        )}
      >
        <Button variant="outline" size="sm" onClick={() => go(index - 1)} disabled={index === 0}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <div className="flex-1 overflow-x-auto">
          {focusMode ? (
            <ProgressDots count={questions.length} current={index} items={navItems} onJump={go} />
          ) : (
            <NavigatorStrip count={questions.length} current={index} items={navItems} onJump={go} />
          )}
        </div>
        {index === questions.length - 1 ? (
          <Button
            size="sm"
            onClick={() => {
              flushCurrentTime();
              onFinish(false);
            }}
          >
            {finishLabel}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => go(index + 1)}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </footer>

      {/* R9 — the summonable question overview panorama. Progress-only (answered
          / flagged / eliminated / time): it NEVER renders correctness, so it is
          safe to summon during the timed section. Jumping closes it. */}
      <ClockQuestionOverview
        clock={clock}
        open={overviewOpen}
        onClose={() => setOverviewOpen(false)}
        current={index}
        items={navItems}
        limitSec={limitSec}
        timed={timed}
        onJump={(i) => {
          setOverviewOpen(false);
          go(i);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * A2.1 — clock subscribers. These are the ONLY components that re-render each
 * second. Each reads the live remaining time from the external ClockStore via
 * `useClockTime`; the surrounding question/passage/choice tree never sees the
 * tick. They wrap the pure, prop-only chrome components so those keep their
 * stable APIs (and existing tests) unchanged.
 * ------------------------------------------------------------------------- */

/** The header / focus-mode timer. Subscribes to the tick; renders the numerals,
 * the depleting hairline and (when `announce`) the threshold callouts. Keeping
 * this as the sole `announce` instance preserves the single `role="timer"` +
 * the 5:00/2:00/1:00 assertive announcements. */
function ClockExamTimer({
  clock,
  totalSec,
  hidden,
  onToggleHidden,
  announce = false,
}: {
  clock: ClockStore;
  totalSec?: number;
  hidden: boolean;
  onToggleHidden: () => void;
  announce?: boolean;
}) {
  const timeLeft = useClockTime(clock);
  return (
    <ExamTimer
      timeLeft={timeLeft}
      totalSec={totalSec}
      hidden={hidden}
      onToggleHidden={onToggleHidden}
      announce={announce}
    />
  );
}

/** The header pace bar. `elapsedSec` is derived from the live clock so the
 * marker still advances every second; the surrounding tree does not. */
function ClockPaceBar({
  clock,
  total,
  answered,
  totalSec,
}: {
  clock: ClockStore;
  total: number;
  answered: number;
  totalSec: number;
}) {
  const timeLeft = useClockTime(clock);
  return <PaceBar total={total} answered={answered} elapsedSec={totalSec - timeLeft} totalSec={totalSec} />;
}

/** The focus-mode ambient hairline pinned to the top edge. Decorative
 * (`aria-hidden`); warms toward amber as time runs low, identical thresholds. */
function FocusHairline({ clock, limitSec }: { clock: ClockStore; limitSec: number }) {
  const timeLeft = useClockTime(clock);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-40 h-0.5 bg-transparent">
      <div
        className={cn(
          'h-full transition-[width,background-color] duration-500',
          timeLeft <= 120 ? 'bg-warning' : timeLeft <= 300 ? 'bg-warning/55' : 'bg-primary/45',
        )}
        style={{
          width: `${limitSec > 0 ? Math.max(0, Math.min(1, timeLeft / limitSec)) * 100 : 100}%`,
        }}
      />
    </div>
  );
}

/** The summonable overview panorama. Subscribes so its "time left" readout
 * stays live while open. The grid only mounts while `open`, so the per-second
 * re-render is cheap and never touches the question tree. */
function ClockQuestionOverview({
  clock,
  open,
  onClose,
  current,
  items,
  limitSec,
  timed,
  onJump,
}: {
  clock: ClockStore;
  open: boolean;
  onClose: () => void;
  current: number;
  items: NavItem[];
  limitSec: number;
  timed: boolean;
  onJump: (index: number) => void;
}) {
  const timeLeft = useClockTime(clock);
  return (
    <QuestionOverview
      open={open}
      onClose={onClose}
      current={current}
      items={items}
      elapsedSec={limitSec - timeLeft}
      totalSec={limitSec}
      timed={timed}
      onJump={onJump}
    />
  );
}
