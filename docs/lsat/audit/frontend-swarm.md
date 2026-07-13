# LSATLab Frontend / Cross-stack / Deploy Audit (swarm)

Read-only multi-agent audit, adversarially verified. Totals: 50 findings — 3 P0, 15 P1, 31 P2 (1 ruled false-positive).

## frontend-correctness

> The frontend's core study/exam/review infrastructure is generally robust: queries use a consistent withFallback envelope with disciplined offline-vs-error handling, loading/error/empty states are present across pages, the offline write queue is idempotent (client_attempt_id) and de-duped, crash-safe section drafts and resume work, and TanStack Query keys/invalidations are coherent (prefix-matching makes the ['dashboard'] invalidation hit ['dashboard', days]). The highest-impact correctness problems are misleading actions that silently do nothing or the wrong thing for daily use: (1) the PrepTests 'Start full timed exam' button routes to a single section instead of the full exam; (2) three separate 'add to SRS' affordances (Similar Questions, Explanation error-log, Blind Review reveal) never actually create SRS cards — they write to a dead localStorage list or only log an error-journal entry, so missed questions never resurface despite success toasts; and (3) the command palette captures its action list once at mount, so theme/mode toggles and the Recent list go stale. Remaining issues are lower-severity polish (final-question timing undercount, a buckets→explanation link dropping the session param, spurious /sessions/0/results calls, a mislabeled NotFound button). No broken routes were found (all navigate/Link targets exist in App.tsx), and no outright runtime crashes from undefined data were found in the pages reviewed thanks to consistent null-guarding and zod validation at the API boundary.

### [P1] PrepTests "Start full timed exam" button only starts section 1 (wrong route) (verified: real)
- file: C:/Users/charl/LSATLab/frontend/src/pages/PrepTests.tsx:171-173
- evidence: onClick={() => navigate(`/take/${detail?.sections[0]?.id ?? test.id}`)} under a button labeled "Start full timed exam" (line 175, PlayCircle).
- why: The owner clicking the primary full-exam CTA on a PrepTest card lands in a single-section run (/take/:sectionId), never the multi-section timed exam (/exam/:preptestId) with breaks and a combined scaled score. The full-exam flow (Exam.tsx, the whole point of a PrepTest) is unreachable from this card. PrepTestAnalytics.tsx:254 and Practice.tsx:124 correctly use /exam/:id, proving the inconsistency.
- fix: Change the full-exam button to navigate(`/exam/${test.id}`) (and prefetchPrepTest, not prefetchSection). Also fix the fallback: when detail is undefined it passes test.id into /take/:sectionId, which is a preptest id, not a section id.
- verifier: Confirmed by reading the cited code and the routing layer.

1) PrepTests.tsx:171-173 — the primary "Start full timed exam" button (PlayCircle, line 175) has onClick={() => navigate(`/take/${detail?.sections[0]?.id ?? test.id}`)}. It navigates to the FIRST SECTION's id, not the preptest exam.

2) Route semantics (App.tsx): line 653 path="/take/:sectionId" -> TakeSection (TakeSection.tsx:39-40 reads

### [P1] "Add all to SRS" in Similar Questions writes to a dead, never-read localStorage list (verified: real)
- file: C:/Users/charl/LSATLab/frontend/src/components/explanation/similar-questions.tsx:44-52
- evidence: addAllToSrs() calls addToSrsQueue(items.map(it=>it.id)) then toast.success(`Queued N questions for SRS`). srsQueue.ts:getSrsQueue is never imported/called anywhere (grep: only similar-questions.tsx calls addToSrsQueue; nothing reads it), and nothing flushes it to api.srsCardsBulk.
- why: For a study app this is a trust/data-integrity failure: the user is told N questions were queued for spaced repetition, but they never appear in /srs or /review and are never persisted to the backend. The comment 'until add API exists (R4-D9)' is stale — api.srsCardsBulk + useBulkSrsCards already exist.
- fix: Replace addToSrsQueue with the real mutation: useBulkSrsCards().mutate(items.map(it=>it.id)) (api.srsCardsBulk), and surface res.created in the toast. Delete the orphaned srsQueue.ts module.
- verifier: Read all cited code and confirmed every claim.

1. similar-questions.tsx:44-52: addAllToSrs() calls addToSrsQueue(items.map(it=>it.id)) and toasts "Queued N question(s) for SRS" — verbatim as described (with an additional n===0 "Already in your SRS queue" branch, an immaterial paraphrase).

2. srsQueue.ts: addToSrsQueue only writes to localStorage (STORAGE_KEYS.srsQueue). getSrsQueue (the read sid

### [P1] Explanation "Add to SRS" checkbox is cosmetic — never creates an SRS card (verified: real)
- file: C:/Users/charl/LSATLab/frontend/src/pages/Explanation.tsx:188-194
- evidence: submitErrorLog() only calls addErrorLog.mutate({attemptId,reason,note}). The addSrs state (line 90) is read solely for the success label `Logged{addSrs ? " and added to SRS" : ""}` (line 448). No srsCardsBulk/useBulkSrsCards call exists in the file (grep confirmed).
- why: After logging an error the user sees 'Logged and added to SRS', but the question is never added to the spaced-repetition queue. The most natural close-the-loop action in the review flow silently does nothing for SRS, so missed questions never resurface as the user expects.
- fix: In submitErrorLog, when addSrs is true also call the bulk-SRS mutation for q.id (api.srsCardsBulk([q.id])), gated on success; only then show the 'added to SRS' copy.
- verifier: Confirmed by reading the cited code and tracing the full chain end to end.

1. Explanation.tsx:188-194 — submitErrorLog() calls only addErrorLog.mutate({attemptId, reason, note}, {onSuccess: () => setLogged(true)}). There is no SRS call.

2. addSrs state (line 90) is bound to the checkbox (lines 471-476) and read functionally ONLY at line 448: `Logged{addSrs ? " and added to SRS" : ""}`. It influe

### [P1] Command palette theme/mode toggles and recents freeze at first render (stale initialActions) (verified: real)
- file: C:/Users/charl/LSATLab/frontend/src/components/command-palette.tsx:50
- evidence: useState<CommandAction[][]>([initialActions]) — initialActions is only consumed by the initial useState. App.tsx:454-548 recomputes `actions` (nav routes, Recent list, 'Switch to dark/light theme', 'Switch to Study/Test Mode') via useMemo and passes it as initialActions, but the provider mounts once in GlobalChrome and never syncs subsequent values.
- why: The palette's 'Switch to dark theme' label/behavior captures the initial `resolved`; after the first toggle it's stale (toggles based on the original theme). The mode toggle and the Recent-routes group likewise never update, and route visibility doesn't follow Study/Test mode. Daily palette use gives wrong labels and can no-op the theme switch.
- fix: Sync the first registry slot when initialActions changes: e.g. useEffect(()=>setRegistries(r=>[initialActions,...r.slice(1)]),[initialActions]); or have GlobalChrome register via the returned register() effect instead of passing initialActions.
- verifier: Verified against the cited code; the finding is accurate.

EVIDENCE TRACE:
- command-palette.tsx:50 — `const [registries, setRegistries] = useState<CommandAction[][]>([initialActions]);`. The `initialActions` prop is consumed ONLY by the useState initializer, which React runs on first mount and ignores on all subsequent renders. There is NO useEffect (or key reset) that re-syncs `initialActions` i

### [P2] Final-question elapsed time is undercounted when finishing a section
- file: C:/Users/charl/LSATLab/frontend/src/components/question/section-runner.tsx:301-311
- evidence: The per-question accumulator writes timeMs only in the effect cleanup (on index change / unmount). TakeSection.persistSession (TakeSection.tsx:106-120) and Exam.persistSection read states synchronously while SectionRunner is still mounted (the Finish dialog renders alongside it), so the currently-open question's last viewing segment is not yet added.
- why: Timing analytics (avg time per question, pace, focus-quality) systematically under-report time on the last question viewed before finishing. Not app-breaking, but it skews the diagnostic timing the owner relies on.
- fix: Flush the current question's elapsed time before persisting — e.g. on finish, commit (Date.now()-questionOpenedAt.current) into states[index].timeMs (a small 'flushCurrentTime' callback the parent calls before reading states), or expose a ref the parent reads.

### [P2] Blind Review "Add to SRS" logs an error-journal entry instead of an SRS card
- file: C:/Users/charl/LSATLab/frontend/src/pages/BlindReview.tsx:172-179
- evidence: addToSrs() sets srsAdded[globalIndex]=true and calls addErrorLog.mutate({attemptId, reason:'concept', note:'Added from Blind Review'}). The RevealedBlock surfaces this as onAddSrs/srsAdded (line 308-310), implying an SRS add.
- why: The reveal panel's 'add to SRS' affordance writes only an error-log row; the question is not scheduled in SRS. Consistent with the other two SRS dead-ends — the user thinks the miss will resurface for review but it won't.
- fix: Call the real SRS path (api.srsCardsBulk([q.id]) / useBulkSrsCards) on add; keep the error-log write only if intended as a separate action, and make the labels match what actually happens.

### [P2] Review buckets "Open" loses the timed/BR answer comparison on the explanation page
- file: C:/Users/charl/LSATLab/frontend/src/components/review/bucket-queue.tsx:201-205
- evidence: navigate(`/explanation/${it.question.id}?attempt=${it.attempt.attempt_id}`) — no &session=. Explanation.tsx:60 does useSessionResults(sessionId||0) and looks up attemptItem from those results (lines 102-111); without a session it can't resolve chosen/br_answer.
- why: Opening a bucketed miss shows '—' for the timed answer and no blind-review answer in the TimedBrAnswers header, weakening the review-loop context the page is meant to provide. (The error-log form still works since attemptId comes from the URL.)
- fix: Include the session id in the link: `/explanation/${it.question.id}?attempt=${it.attempt.attempt_id}&session=${it.sessionId}` (AggregatedItem already carries sessionId).

### [P2] Spurious /api/sessions/0/results requests when there is no recent/selected session
- file: C:/Users/charl/LSATLab/frontend/src/lib/hooks.ts:327-336
- evidence: useSessionResults has no `enabled` guard. Callers pass 0 when absent: Review.tsx:190 useSessionResults(recent?.id ?? 0); Explanation.tsx:60 useSessionResults(sessionId || 0).
- why: Fires a guaranteed-failing GET /api/sessions/0/results on those screens (404 from a reachable backend, or a connectivity fallback). Harmless to render (callers null-check) but adds noise/latency and a console error on every visit — undesirable for a packaged single-user app.
- fix: Add `enabled: sessionId > 0` to useSessionResults (mirroring useQuestion/usePlaylist) so the query is skipped for id 0.

### [P2] NotFound 'Go to Dashboard' button navigates to Notebook OS, not the dashboard
- file: C:/Users/charl/LSATLab/frontend/src/pages/NotFound.tsx:18
- evidence: <Button onClick={() => navigate("/")}>Go to Dashboard</Button>, but route '/' renders Notebook (App.tsx:158-167; routeManifest labels '/' as 'Notebook OS'; '/dashboard' is the real dashboard).
- why: Minor label/destination mismatch: hitting a bad URL and clicking 'Go to Dashboard' drops the user on the Notebook home instead of the analytics dashboard.
- fix: Either navigate('/dashboard') or relabel the button to 'Go to Home'.

### [P2] Blind Review outcome buckets depend on correct_answer being present in session results (not enforced by the validated schema)
- file: C:/Users/charl/LSATLab/frontend/src/pages/BlindReview.tsx:146-153
- evidence: computeOutcome() compares brAnswer===q.correct_answer and RevealedBlock uses q.correct_answer (line 306). sessionResultsSchema uses questionSchema (apiSchemas.ts:43-55, 108) which does NOT include correct_answer in the validated object (.passthrough only allows it). If the backend omits it for blind-review integrity, every BR answer is scored wrong.
- why: If the backend ever withholds correct_answer in /sessions/{id}/results (a plausible blind-review-integrity choice), the BR loop silently misclassifies all answers as concept_gap/lucky and reveals nothing correct — corrupting the core review experience. Currently relies on an unguaranteed backend behavior.
- fix: Confirm the backend always includes correct_answer in session results (add it to questionSchema as required if so), or have the reveal flow fetch the revealed question (api.question(id, reveal=true)) to obtain correct_answer rather than trusting the BR results payload.

## frontend-a11y-ux

> The LSATLab frontend has an unusually strong accessibility foundation for a personal app: a skip link, a global :focus-visible ring safety net, an app-wide prefers-reduced-motion CSS net (plus per-component motion-reduce: variants), a true high-contrast theme, ARIA live regions for the exam loop (question changes, pace, timer thresholds), a single correct role="timer", and almost all interactive primitives are Radix-based (Dialog/Select/DropdownMenu/Tabs/Tooltip/RadioGroup/Checkbox/Toggle/Slider) so focus trapping, roving focus, and Escape handling come for free. The command palette (cmdk) and dialogs manage focus correctly; TooltipProvider is mounted. The real, concrete gaps: (1) a WIDESPREAD color-contrast failure where the amber --warning token (38 92% 50%, approx #f5a623) is used as TEXT (text-warning) on white/light card surfaces in ~33 files - including the exam timer urgent numerals and the streak counter - at roughly 2:1, far below WCAG AA 4.5:1; (2) every Sheet (Radix Dialog) is rendered without a DialogTitle/aria-labelledby, so the dialog has no programmatic accessible name and Radix logs a console warning; (3) a recurring form-label-association gap where visible Label/h2 text is not tied to its control via htmlFor/id (the Drills Field wrapper, TimerSettingsForm, AnalyticsFilters selects); (4) the answer ChoiceList radio's aria-label="Choice A" overrides the actual choice text, so screen-reader users never hear the answer content, and the eliminate button is labeled only via title; (5) a few icon-only buttons (saved-views) use only title with no aria-label. None are app-breaking, but #1 and #4 directly degrade daily usability/legibility, and #1 affects the most time-critical readout (the exam clock).

### [P1] Amber --warning used as TEXT color fails WCAG AA contrast across ~33 files (incl. exam timer urgent state + streak) (verified: real)
- file: frontend/src/index.css:38
- evidence: --warning: 38 92% 50%; (light) consumed as text-warning in ExamTimer urgent numerals, PaceBar, and the app-shell streak; comment asserts 'we lean on the warning token (AA-contrast...)'
- why: --warning: 38 92% 50% (approx #f5a623) is used as a foreground TEXT color via text-warning in 33 files. Amber at 50% lightness on the white/graphite-50 card and background surfaces is ~2.0-2.4:1, below the 4.5:1 AA threshold for normal text. The most damaging instance is the exam clock: when <=2:00 remain, ExamTimer switches the numerals to text-warning (exam-chrome.tsx:80) - the single most time-critical readout becomes the hardest to read, especially on the warm focus-paper theme. Other daily-visible instances: the streak counter in the header (app-shell.tsx:387), 'X behind pace' (exam-chrome.tsx:176), and warning copy across many analytics/import cards. The token comment claims it is 'AA-contrast' (exam-chrome.tsx:48), which is false for it as text in light mode. Dark and high-contrast themes lift the lightness, so this is specifically a light/default-theme defect - the likely daily theme.
- fix: Add a darker 'warning-on-surface' text token (~30-35% lightness, matching what high-contrast already uses: 38 100% 30%) and map text-warning to it in light mode, OR replace text-warning text usages with a darker amber/foreground+icon pattern. Keep bg-warning (with the near-black --warning-foreground) unchanged. Re-verify the exam timer urgent numerals and streak.
- verifier: VERIFIED REAL. I read the actual files (note: the cited path is missing the `question/` subdir — the real file is frontend/src/components/question/exam-chrome.tsx — but every cited LINE NUMBER is exact: L80 `urgent ? "text-warning" : "text-foreground"`, L176 `behind ? "text-warning"`, L48 the "AA-contrast" comment; app-shell.tsx:387 streak `text-warning`; index.css:38 `--warning: 38 92% 50%`).

CO

### [P1] Every Sheet lacks a DialogTitle/aria-labelledby - no accessible name + Radix console warning (verified: real)
- file: frontend/src/components/ui/sheet.tsx:16
- evidence: SheetContent renders {children} + a close button but no Title/Description; AnalyticsFilters uses <h2 className="text-lg font-semibold">Analytics filters</h2> with no aria-labelledby wiring.
- why: Sheet wraps @radix-ui/react-dialog Content but never exposes/forces a Dialog.Title. Consumers (AnalyticsFilters.tsx:45 'Analytics filters', question-browser.tsx:312 'Question preview', and the Playlists sheets) render a plain <h2> heading, which Radix does NOT associate as the dialog's accessible name. Result: screen readers announce an unnamed dialog and Radix logs a runtime 'DialogContent requires a DialogTitle' warning. Unlike Dialog consumers (which all use DialogTitle), the Sheet path has no such structure.
- fix: Export SheetTitle/SheetDescription (aliasing Radix Dialog.Title/Description) and use them in every Sheet, or have SheetContent set aria-labelledby. At minimum give each SheetContent an aria-label. Also pass aria-describedby={undefined} when there is no description to silence the Radix warning.
- verifier: Verified against actual source. (1) frontend/src/components/ui/sheet.tsx:10-35: SheetContent wraps @radix-ui/react-dialog Content, renders {children}+close button, never a Dialog.Title. No SheetTitle/SheetDescription is exported or defined anywhere (grep: zero matches). (2) Both Sheet consumers use a plain heading with no id/aria wiring: AnalyticsFilters.tsx:45 (<h2>Analytics filters</h2>) and ban

### [P1] Answer-choice radio aria-label='Choice A' hides the choice text from screen readers (verified: real)
- file: frontend/src/components/question/choice-list.tsx:85
- evidence: aria-label={`Choice ${c.label}${isElim ? ', eliminated' : ''}`} on the button that wraps {c.text}
- why: Each answer choice button is role=radio with aria-label='Choice {label}[, eliminated]'. An explicit aria-label OVERRIDES the visible inner text ({c.text}), so a screen-reader user navigating answers hears only 'Choice A, radio' / 'Choice B, radio' and never the actual answer content. This makes the core exam interaction (reading and selecting LSAT answer choices) unusable non-visually - a real daily-usability blocker for an owner using TTS/zoom on long sections.
- fix: Drop the overriding aria-label and expose the letter + text as the accessible name (include the letter chip text and let {c.text} contribute), or use aria-labelledby pointing at both the letter and text spans. Keep the 'eliminated' state on the separate eliminate control, not by masking the choice text.
- verifier: Verified the cited code in C:/Users/charl/LSATLab/frontend/src/components/question/choice-list.tsx. Line 85 places aria-label={`Choice ${c.label}${isElim ? ", eliminated" : ""}`} on the <button role="radio" aria-checked={isSelected}> (lines 81-91). That same button wraps the answer prose {c.text} at line 134 (inside the flex-1 span at line 132; the button closes at line 168) plus the letter chip {

### [P2] bg-warning text-white on flagged navigator cells is a hard contrast failure
- file: frontend/src/components/question/navigator-strip.tsx:148
- evidence: it.flagged ? "bg-warning text-white" : ... with the number {i + 1} rendered inside this button
- why: Flagged questions in the navigator strip render bg-warning text-white - white text on amber #f5a623 is ~1.9:1, failing AA for the question-number glyph shown throughout every timed section. The Badge warning variant is correct (uses near-black --warning-foreground), so the fix is to align this one call site.
- fix: Use text-warning-foreground (near-black graphite) instead of text-white for the flagged cell, matching the Badge warning variant.

### [P2] Icon-only eliminate button has no aria-label (relies on title only)
- file: frontend/src/components/question/choice-list.tsx:170
- evidence: <button type="button" title="Eliminate (E)" aria-pressed={isElim} ...> with only an <X/> icon child
- why: The per-choice 'eliminate' button is icon-only (<X/>), with title='Eliminate (E)' and aria-pressed but no aria-label. title is not reliably surfaced as the accessible name, so this announces as 'toggle button, pressed/not pressed' with no name. There are 5 of these per question.
- fix: Add aria-label={`Eliminate choice ${c.label}`} to the eliminate button.

### [P2] Form labels not associated with controls (Drills Field, TimerSettingsForm, AnalyticsFilters)
- file: frontend/src/pages/Drills.tsx:313
- evidence: Drills Field: <Label>{label}</Label> then {children} with no id linkage; TimerSettingsForm: <Label>LR section (minutes)</Label> + <Input type="number" {...register('lrMin')} /> (no id/htmlFor).
- why: The Field helper renders <Label>{label}</Label> with no htmlFor, and its child Input/Select has no id, so 'Section', 'Question type', and the free-text intent field are visually labeled but programmatically unlabeled. Same pattern in TimerSettingsForm (<Label>LR section (minutes)</Label> + bare <Input> at lines 39-43) and AnalyticsFilters ('Question source'/'Time range' <Label> with no htmlFor over a SelectTrigger with no id). Screen readers fall back to the placeholder or announce an unnamed field. Good counter-examples exist (goal-settings-form, accommodations-settings, Playlists dialogs all use htmlFor/id), so this is an inconsistency to close.
- fix: Thread an id through Field (via useId) and set htmlFor; for Radix Select give the SelectTrigger an id and the Label a matching htmlFor (or add aria-label to the trigger). Add id/htmlFor to the two TimerSettingsForm inputs and the two AnalyticsFilters selects.

### [P2] Saved-views icon buttons labeled by title only
- file: frontend/src/components/analytics/saved-views.tsx:117
- evidence: Two <Button variant="ghost" size="icon" ... title="Copy shareable link">/title="Delete view" with only <Link2/>/<Trash2/> children and no aria-label.
- why: The 'Copy shareable link' (Link2) and 'Delete view' (Trash2) icon-only buttons use only title= with no aria-label, so they have no reliable accessible name. question-browser.tsx:295 correctly pairs aria-label + title on its delete button - this is a missed-label inconsistency, and Delete is destructive so an unnamed control is worse here.
- fix: Add aria-label="Copy shareable link" and aria-label="Delete saved view" to these two buttons.

### [P2] Scratch-pad disclosure + custom tabs lack ARIA state/roles
- file: frontend/src/components/exam/scratch-pad.tsx:128
- evidence: <button onClick={() => setOpen((o) => !o)}>...Scratch pad...</button> with no aria-expanded; Notes/Draw are plain <button>s; <canvas .../> has no aria-label/role.
- why: The scratch-pad collapse button (named via visible 'Scratch pad' text) is a disclosure trigger but lacks aria-expanded, so non-visual users don't know the panel's open/closed state. The Notes/Draw switch (lines 144-164) is a custom two-button toggle with no role=tab/tablist/aria-selected, and the drawing <canvas> has no aria-label. Minor (auxiliary surface, and it uses a real <Textarea> so the SectionRunner INPUT/TEXTAREA keyboard guard still prevents A-E hotkeys firing while typing - no keyboard trap), but aria-expanded is a quick win.
- fix: Add aria-expanded={open} (and aria-controls) to the disclosure button; add aria-pressed/aria-selected to the Notes/Draw buttons (or use Radix Tabs); add aria-label='Scratch drawing canvas' to the canvas.

### [P2] Radix Progress exposes no value text / accessible name
- file: frontend/src/components/ui/progress.tsx:10
- evidence: Progress.Root with only className/value/indicatorClassName forwarded; no aria-label or getValueLabel/aria-valuetext.
- why: The Progress wrapper renders Radix Progress.Root (role=progressbar + aria-valuenow) but never sets aria-label/aria-labelledby or aria-valuetext, so screen-reader users hear a percentage with no indication of WHAT is progressing. Impact is low because most progress bars sit next to visible text, but several consumers use it as the sole indicator.
- fix: Allow callers to pass aria-label/aria-valuetext (or getValueLabel) through Progress and supply them at data-bearing call sites (e.g. 'Section progress, 60%').

### [P2] Dialogs without a DialogDescription trigger Radix aria-describedby warnings
- file: frontend/src/components/ui/dialog.tsx:32
- evidence: DialogContent forwards {...props} but does not default aria-describedby; 'Rename set' dialog renders <DialogTitle> with no <DialogDescription>.
- why: DialogContent never sets aria-describedby={undefined}. Radix Dialog warns at runtime ('Missing Description or aria-describedby...') for any Content lacking a DialogDescription - e.g. Playlists 'Rename set' (Playlists.tsx:239 has a Title but no Description) and StudyCalendar's dialog. Only a console warning (not app-breaking, and not a screen-reader failure since the Title is present), but it's noise that signals an a11y gap and is trivially silenced.
- fix: In DialogContent, default aria-describedby to undefined when no description is provided (or add a DialogDescription to the dialogs that omit one).

## deploy-readiness

> LSATLab's packaging is unusually mature for a personal app: the FastAPI backend is correctly frozen via PyInstaller (backend/lsatlab.spec, build-sidecar.ps1) and wired as a Tauri sidecar (tauri.conf.json bundle.externalBin + capability-scoped shell:allow-execute), the Rust shell (lib.rs) health-checks the loopback port before revealing the window, no secrets/DB/venv are committed, lockfiles and all referenced icons/modules exist, and the PyInstaller spec bundles no live .db (so a build can't leak the owner's personal data or official content). A clean `release-local.ps1` run will, on a machine with the full toolchain (uv + Node + Rust + PyInstaller injected by build-sidecar.ps1), build the sidecar and a working installer. HOWEVER, several things will bite the owner on a fresh install: (1) the packaged app boots with an EMPTY database — startup runs init_db() but never seed(), so there is no first-run content; (2) the backend's data directory (%APPDATA%/LSATLab) and Tauri's app_data_dir (%APPDATA%/com.lsatlab.desktop, used for saved reports, window-state, and the "export logs/open data folder" diagnostics) are two different folders because the sidecar is launched with no LSATLAB_DATA_DIR; (3) the version number is inconsistent across the stack (0.1.0 in tauri.conf/Cargo/package.json vs 1.0.0 in the backend, and the UI footer literally renders "vdev" because nothing sets VITE_APP_VERSION at build). None of these block producing an installer, but they undermine depending on it daily. The updater is intentionally inactive and the signing/notarization wiring is config-only (unverifiable without certs), which is fine for a single-user side-load.

### [P1] Packaged app boots with an empty database — seed() is never called at startup (verified: real)
- file: backend/app/main.py:145
- evidence: lifespan: `init_db()` ... `jobs.ensure_default_schedules(s)` with no seed() call; seed.py only seeds under `if __name__ == "__main__": pid = seed()`
- why: The lifespan handler runs init_db() (schema only) and ensure_default_schedules(), but never calls app.seed.seed(). seed() only runs via the `python -m app.seed` __main__ block (seed.py:473), which start-dev.ps1 invokes in dev but the frozen sidecar (sidecar_main.py → uvicorn.run(app)) never does. A fresh desktop install therefore opens to zero questions/content until the owner manually imports a PrepTest PDF. For a 'depend on it daily' app this is a confusing empty first-run with no onboarding telling the user to import.
- fix: Decide the intended first-run content story. Either (a) call a guarded seed-if-empty in lifespan (e.g. if question count == 0 and a LSATLAB_SEED_ON_EMPTY flag is set, run seed(reset=False)), or (b) ship a pre-seeded starter DB as a bundled data file the backend copies into the data dir on first launch, or (c) add an explicit first-run 'Import your first PrepTest' onboarding screen. At minimum document that a packaged install starts empty.
- verifier: Read all cited code; the finding's structural claims are accurate.

CONFIRMED:
- backend/app/main.py:122-166 (lifespan) calls init_db(), startup backup, settings_store.apply_saved_settings(s), jobs.ensure_default_schedules(s), jobs.reconcile_orphans(), and starts the worker — but never calls seed(). Grep for "seed" in main.py returns zero matches.
- backend/app/db.py:124-133 init_db() = SQLModel.m

### [P1] Sidecar and Tauri write to two different data directories (no LSATLAB_DATA_DIR passed) (verified: real)
- file: frontend/src-tauri/src/lib.rs:223
- evidence: `cmd.args(["--host", BACKEND_HOST, "--port", &BACKEND_PORT.to_string()])` — no .env(); config.py frozen branch returns `Path(base) / "LSATLab"` while lib.rs uses `app.path().app_data_dir()`
- why: spawn_sidecar() launches the frozen backend with only `--host 127.0.0.1 --port 8000` and no environment. The frozen backend (config.py:36) self-selects %APPDATA%/LSATLab for the DB/logs/backups/exports. But Tauri commands save_report (lib.rs:611) and app_log_dir/export_backend_logs (lib.rs:445/537) use app.path().app_data_dir()/app_log_dir(), which for identifier com.lsatlab.desktop resolve to %APPDATA%/com.lsatlab.desktop and the matching log dir. So the SQLite DB, backups and exports live in one folder while saved reports, window-state, and the Diagnostics 'export logs' button point at a different folder. The owner's backups and the app's idea of 'your data folder' diverge — confusing for restore, and the in-app log export won't show the backend's own logs.
- fix: In spawn_sidecar(), resolve app.path().app_data_dir() and pass it through: `cmd.env("LSATLAB_DATA_DIR", data_dir)` (and optionally LSATLAB_LOG_DIR) so the backend DB/logs/backups land under the same com.lsatlab.desktop dir the Tauri side uses. Do the same for the DevVenv spawn for consistency. Re-point Diagnostics' 'open data folder' at the unified location.
- verifier: All load-bearing claims verified against real code.

1) spawn_sidecar (frontend/src-tauri/src/lib.rs:223-235): exactly `cmd.args(["--host", BACKEND_HOST, "--port", &BACKEND_PORT.to_string()])`, no `.env()`. spawn_dev_backend (189-201) also passes no env. The sidecar's stdout channel `_rx` (line 237) is discarded.

2) config.py _default_data_dir (lines 33-44): with no LSATLAB_DATA_DIR and sys.froze

### [P1] Version is inconsistent across the stack; installer says 0.1.0, backend says 1.0.0, UI footer shows 'vdev' (verified: false_positive)
- file: frontend/src-tauri/tauri.conf.json:4
- evidence: tauri.conf `"version": "0.1.0"`; config.py `APP_VERSION = _env("LSATLAB_APP_VERSION", "1.0.0")`; main.py `FastAPI(..., version="1.0.0")`; app-shell.tsx:48 `const APP_VERSION = \`v${import.meta.env.VITE_APP_VERSION ?? "dev"}\``
- why: tauri.conf.json version=0.1.0, Cargo.toml version=0.1.0, package.json version=0.1.0, but backend config.APP_VERSION defaults to 1.0.0 and FastAPI(title=..., version="1.0.0"). The installer/OS 'installed version' and the Tauri updater's version comparison use 0.1.0, while the backend (and any /trust or about surface reading APP_VERSION) reports 1.0.0. Worse, the UI footer computes `v${import.meta.env.VITE_APP_VERSION ?? "dev"}` and nothing in the build sets VITE_APP_VERSION, so a real build shows literally 'vdev'. When the owner relies on this daily, they can't tell which version they're running, and a future auto-update could mis-compare versions.
- fix: Pick one source of truth. Set tauri.conf/Cargo/package.json/config.APP_VERSION/FastAPI version to the same number, and inject VITE_APP_VERSION at build (e.g. in beforeBuildCommand or vite.config define) from package.json#version so the footer matches the installer. Consider a tiny pre-build script that stamps all four.
- verifier: I read all cited files plus vite.config.ts. The finding is partially true but its load-bearing claim is false.

TRUE parts: Version strings do differ. frontend/src-tauri/tauri.conf.json:4 = "0.1.0", frontend/src-tauri/Cargo.toml:3 = "0.1.0", frontend/package.json:4 = "0.1.0" (all three packaging files agree), but backend/app/config.py:18 defaults APP_VERSION to "1.0.0" and backend/app/main.py:169 

### [P2] Updater pubkey in tauri.conf is empty string, not the documented PLACEHOLDER sentinel the CI guard checks
- file: frontend/src-tauri/tauri.conf.json:82
- evidence: tauri.conf updater block: `"pubkey": ""`; release.yml guard only checks `current.startswith("PLACEHOLDER") or current == "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY"`
- why: docs/14-packaging.md and the release.yml guard both assume tauri.conf ships `pubkey: "PLACEHOLDER_TAURI_UPDATER_PUBKEY"` (or REPLACE_WITH_...), and the CI step fails a tag release if the value still startswith('PLACEHOLDER'). The actual committed value is `"pubkey": ""` (empty). An empty string does NOT match the placeholder guard, so if the updater were ever activated and TAURI_UPDATER_PUBKEY secret were unset, the CI safety net would pass an unsigned/unverifiable release through instead of failing. Today updater.active=false so this is latent, but it's a real gap between the documented safeguard and the file.
- fix: Either set the committed pubkey back to the documented PLACEHOLDER_TAURI_UPDATER_PUBKEY sentinel so the guard fires, or broaden the release.yml guard to also reject an empty/short pubkey (e.g. `if not current or current.startswith('PLACEHOLDER') or len(current) < 40`).

### [P2] Fresh clone has no sidecar binary; building the installer requires running build-sidecar.ps1 first (and full toolchain)
- file: frontend/src-tauri/binaries/.gitkeep:1
- evidence: .gitignore:25 `frontend/src-tauri/binaries/lsatlab-backend-*`; git ls-files shows only `frontend/src-tauri/binaries/.gitkeep`; the 74MB lsatlab-backend-x86_64-pc-windows-msvc.exe exists only in the working tree
- why: binaries/lsatlab-backend-* is gitignored (correct — it's a 74MB build artifact), so only .gitkeep is committed. `npm run tauri:build` alone will fail to bundle the externalBin unless build-sidecar.ps1 has staged lsatlab-backend-<triple>.exe first. release-local.ps1 → release_local.py handles this (it runs the sidecar build before tauri build by default), and CI does too, but a human who just runs `tauri build` will get a broken/missing-sidecar bundle. This is a documented-but-easy-to-miss footgun for the owner doing a manual local build.
- fix: Add a beforeBuildCommand guard or a npm 'tauri:build' wrapper that runs build-sidecar.ps1 (or checks the staged binary exists and errors with a clear message) before invoking tauri build, so a bare `npm run tauri:build` can't silently produce a sidecar-less installer.

### [P2] .env.example advertises LSATLAB_API_HOST / LSATLAB_API_PORT that no code reads
- file: backend/.env.example:34
- evidence: `grep LSATLAB_API_HOST|LSATLAB_API_PORT backend/app/*.py` → no matches; sidecar_main.py uses `os.environ.get("LSATLAB_HOST"...)` and `LSATLAB_PORT`
- why: The backend env template lists `LSATLAB_API_HOST=127.0.0.1` and `LSATLAB_API_PORT=8000`, but no backend module reads those names (grep found zero references). The frozen sidecar entry point reads LSATLAB_HOST/LSATLAB_PORT (sidecar_main.py), and host/port actually come from the --host/--port CLI args the Tauri capability hard-codes. An owner who tries to relocate the port by setting LSATLAB_API_PORT will be silently ignored, then confused when the Tauri health-check (hard-coded to 8000) can't find it anyway.
- fix: Remove LSATLAB_API_HOST/LSATLAB_API_PORT from .env.example (or rename the code to honor them). Also note in docs that the port is effectively fixed at 8000 because the Tauri capability args and the Rust BACKEND_PORT constant are hard-coded; changing it requires editing capabilities/default.json + lib.rs together.

### [P2] DB integrity failure on startup logs an error but does NOT halt — backend serves on a possibly-corrupt DB
- file: backend/app/main.py:137
- evidence: `if integrity != "ok": log.error(...restore the latest snapshot...)` immediately followed by `init_db()` with no return/raise
- why: On startup, if the DB exists and integrity_check() != 'ok', the code log.error()s a restore hint but then falls through to init_db() and starts serving anyway. For a single-user local app with no cloud fallback, continuing to run migrations/writes against a flagged-corrupt SQLite file risks compounding the corruption before the owner sees the log line (which, per the data-dir split finding, may also be in a folder the in-app log export doesn't surface). The comment says it should 'surface loudly with a restore hint rather than crash mid-migration', but it neither crashes nor blocks writes.
- fix: On integrity != 'ok', either refuse to start the worker / enter a read-only degraded mode and emit a backend-degraded signal the UI already listens for (events::BACKEND_DEGRADED), or auto-restore the latest snapshot from BACKUP_DIR before init_db(). At minimum, surface the corruption to the frontend (it already has degraded-UI plumbing) rather than only writing a log line.

### [P2] NSIS installMode perMachine forces UAC elevation on every install and passive auto-update
- file: frontend/src-tauri/tauri.conf.json:58
- evidence: `"nsis": { "installMode": "perMachine" }` combined with updater `"windows": { "installMode": "passive" }`
- why: bundle.windows.nsis.installMode is 'perMachine', which installs into Program Files and triggers a UAC admin prompt on first install and on each updater-driven update (updater windows.installMode is 'passive'). For a single-user app whose data already lives per-user in %APPDATA%, perMachine adds friction (admin rights required to update) with no benefit. If the owner isn't an admin or dislikes UAC on every silent update, updates may stall.
- fix: Switch nsis.installMode to 'currentUser' (or 'both' to offer a choice). currentUser installs to %LOCALAPPDATA%, needs no elevation, and pairs cleanly with the passive auto-updater for a single-user side-load.

### [P2] Frozen-build data-dir detection relies solely on sys.frozen and can't be overridden cleanly when sidecar passes no env
- file: backend/app/config.py:36
- evidence: config.py `if getattr(sys, "frozen", False): ... return Path(base) / "LSATLab"`; lib.rs find_dev_python candidates `["../../backend", "../backend", "backend", "../../../backend"]`
- why: The frozen branch keys entirely off getattr(sys,'frozen',False) to pick %APPDATA%/LSATLab. Combined with the fact that the Tauri shell passes no LSATLAB_DATA_DIR (see the data-dir-split finding), there is no path by which the desktop app and backend agree on a single data root without a code change. It also means any non-frozen launch that happens to find a stray backend/.venv (lib.rs find_dev_python walks ../../backend, ../backend, backend, ../../../backend relative to cwd) would write the DB under the repo's backend/ instead — a packaged install run from an unexpected cwd near a dev checkout could split data a third way.
- fix: Make LSATLAB_DATA_DIR the single authority (already supported at config.py:33) and always set it from the Rust side (ties into the data-dir finding). Optionally tighten find_dev_python to only treat a .venv as 'dev' when an explicit LSATLAB_DEV marker/env is present, so a packaged binary never accidentally adopts a nearby dev venv + repo DB.

## lmstudio-e2e


### [P0] No model-role pickers; LMStudio keeps non-existent Ollama tags (verified: real)
- file: frontend/src/components/settings/model-routing-card.tsx:160-174
- why: explain/gen/diagnose/embed stay on Ollama tags (phi4:14b etc) after switching; card shows read-only Badges with no Select, so owner cannot assign loaded LMStudio models and all AI silently fails
- fix: Add explain/gen/diagnose/embed pickers from health.models wired to useSaveSettings; backend SettingsPatch+_OVERRIDABLE already accept the keys
- verifier: Both halves of the finding are confirmed by the cited code.

UI claim (model-routing-card.tsx:160-174): explain/gen models render as read-only <Badge> elements and "Available models" (h?.models) renders as read-only outline Badges. The file's imports (lines 1-17) include no Select/picker component, and the only LMStudio-related write the card exposes is local_provider (ToggleGroup, line 91) and lm

### [P0] Frontend never surfaces backend missing_models (verified: real)
- file: frontend/src/lib/types.ts:141-151
- why: ai.health computes missing_models (ai.py:440-451, passes route response_model dict) but AiHealth omits the field and nothing renders it, so LMStudio reachable-but-wrong-models shows green while AI fails
- fix: Add missing_models?:string[] to AiHealth and render a warning naming the ids; optionally fold into AiPrereqBanner
- verifier: Verified both halves of the claim against the real code (the cited path was wrong — actual file is backend/app/ai.py, not backend/app/routers/ai.py — but line numbers and behavior match exactly, so it's a citation typo, not a substantive error).

BACKEND: backend/app/ai.py:424-453 health() computes `missing` by checking each configured model id (explain_model/gen_model/diagnose_model/embed_model) 

### [P0] Embed role unusable + silent dedup/RAG corruption on embed-model switch (verified: real)
- file: backend/app/embeddings.py:268-276
- why: default nomic-embed-text unresolved on LMStudio unless loaded+assigned; different-dim model without bumping EMBED_MODEL_VERSION makes cosine return 0.0 on len mismatch, silently breaking dedup/similarity/RAG; sqlite-vec path lacks per-dim guard
- fix: Expose embed role; force re-embed on embed_model/local_provider change (version-key to model id or purge dim-mismatched vectors); surface stored dim
- verifier: Read embeddings.py, settings_store.py, settings_routes.py, llm/lmstudio.py, llm/__init__.py, config.py, models.py, generation.py, ai.py, doctor.py, dataset_routes.py. The finding is REAL on all three sub-claims, though the headline "Embed role unusable" overstates one part.

CLAIM 2 (the core, most severe claim) — CONFIRMED end-to-end. `embed_model` AND `local_provider` are runtime-overridable set

### [P1] No set_keep_alive parity for LMStudio (VRAM pin/unload Ollama-only) (verified: real)
- file: backend/app/llm/lmstudio.py:181-188
- why: OllamaProvider.set_keep_alive (ollama.py:122) manages VRAM so two ~9GB models don't thrash a 12GB GPU; LMStudioProvider has none so surfaces aren't truly compatible; never called in prod today (tests only) but real gap and future warm/unload would AttributeError
- fix: Add best-effort set_keep_alive on LMStudioProvider (load/unload REST or no-op returning True), never raising; route call sites via llm.local_provider()
- verifier: Verified by reading both providers in full. OllamaProvider.set_keep_alive exists at backend/app/llm/ollama.py:122-141 (bodyless /api/generate with keep_alive, best-effort, never raises, explicitly for pinning the explain model / unloading the gen model so two ~9GB models don't thrash a 12GB GPU). I read all 188 lines of backend/app/llm/lmstudio.py: its methods are chat_stream, chat, generate, embe

### [P1] Critic/solver roles not overridable; generation can't be made LMStudio-valid (verified: real)
- file: backend/app/settings_store.py:27-41
- why: GEN_CRITIC_MODEL (llama3.1:8b) and GEN_SOLVER_MODELS (qwen3:14b,llama3.1:8b,gemma4) absent from _OVERRIDABLE/SettingsPatch, so generation keeps invoking Ollama tags under LMStudio and fails 2-of-3 gate; health missing_models omits them too (ai.py:442)
- fix: Add gen_critic_model (+gen_solver_models CSV) to _OVERRIDABLE+SettingsPatch+UI, include critic in health missing scan, allow one-model solvers for single-GPU
- verifier: Verified against real code; the finding holds.

1) Not overridable via app: `_OVERRIDABLE` (backend/app/settings_store.py:27-41) and `SettingsPatch` (backend/app/routers/settings_routes.py:22-31) both contain only explain_model/gen_model/diagnose_model/embed_model/gen_provider/cloud_gen_model/local_provider/lmstudio_url/desired_retention. Neither `gen_critic_model` nor `gen_solver_models` is prese

### [P1] resolve_explain_model uses configured model verbatim on LMStudio (verified: real)
- file: backend/app/ai.py:57-81
- why: for non-Ollama providers it returns config.EXPLAIN_MODEL with no probe (if LOCAL_PROVIDER!=ollama return preferred), so fresh LMStudio switch returns phi4:14b which LMStudio rejects, no fallback, first explain fails
- fix: Mitigated by the picker; defense-in-depth validate against health.models when LOCAL_PROVIDER!=ollama and fall back to a loaded chat model or surface error
- verifier: Verified against the actual code. The mechanism is exactly as claimed:

1. backend/app/ai.py:69-71 — resolve_explain_model(): `if config.LOCAL_PROVIDER != "ollama": _EXPLAIN_MODEL_RESOLVED = preferred; return ...`. For LMStudio it returns config.EXPLAIN_MODEL verbatim, no probe, no fallback. The Ollama-only phi4->qwen3 fallback (lines 72-80) is skipped entirely. This is intentional and pinned by t

### [P2] Onboarding wizard never maps LMStudio models to roles
- file: frontend/src/components/onboarding-wizard.tsx:386-405
- why: LMStudio branch only says install/load/start and suppresses model hints for LMStudio (!isLmStudio && !hasExplain), so user sees green reachable but default Ollama role models don't exist
- fix: Add a step pointing to the new role pickers and base readiness on health.missing_models being empty

### [P2] No dedicated list-models endpoint; discovery tied to 30s-stale /ai/health
- file: backend/app/ai.py:424-453
- why: models only available via /ai/health (STALE 30s); a picker wants a fresh on-demand list after loading a model in LMStudio; usable via health.models so polish not a blocker; routers show only /ai/health and /health
- fix: Optionally add GET /api/ai/models -> local_provider().list_models() (5s), or a Refresh button invalidating ai-health

## cross-stack-contract

> I audited the full frontend↔backend API contract: the committed frontend/openapi.json is byte-for-byte in sync with the live backend at the path+method+schema-name level (both expose exactly 174 routes, 75 schemas; zero stale/missing paths). Every zod-validated hot-path schema in apiSchemas.ts (section, question, sessionResults, finish, dashboard, forecast, the entire Notebook-OS cluster — artifacts/citations/sources/notes/chat/transformations/podcasts/activity/context-presets/inbox/backlinks, RC dashboard+passage map, content sources/validator-runs/versions, scheduled-tasks, tutor conversations/turns, why-loop, concept-cards, rationale) was checked field-by-field against the actual backend handler return statements and ALL align (the schemas are correctly permissive with .passthrough()/.nullable()). Request bodies (attempts, drills, import parse/reconcile/commit, settings, srs, notebook) match their pydantic models. The contract is in remarkably good shape. However, two bare-cast (non-zod) long-tail endpoints have real, user-facing drift that breaks core pages, plus a cluster of dead client methods and a couple of minor type lies. The two P1s are the headline: the Explanation/review screen always 403s its question fetch, and the Playlists page crashes on render.

### [P1] Explanation/review page always 403s its question fetch (reveal context not forwarded) (verified: real)
- file: frontend/src/lib/api.ts:260
- evidence: api.ts:261 `request<Question>(\`/api/questions/${id}?reveal=${reveal}\`...)`; Explanation.tsx:66 `const questionQuery = useQuestion(id, true);` with attemptId/sessionId read but unused; content.py:273-274 `if reveal: _require_question_review_context(...)` -> 403
- why: This is the core review surface used every day. api.question(id, reveal=false) calls GET /api/questions/{id}?reveal={reveal} but never sends attempt_id/session_id. Since commit 5fcb295 the backend get_question() requires review context for reveal=true (content.py:265-276 -> _require_question_review_context raises HTTPException 403 when both attempt_id and session_id are None). Explanation.tsx:66 calls useQuestion(id, true) (reveal) while it HAS attemptId/sessionId from the URL (Explanation.tsx:58-59) but does not pass them. The 403 ApiError is not an ApiValidationError, so QueryClient throwOnError is false (main.tsx:62) and withFallback re-throws non-connectivity errors (hooks.ts:104-112) -> the query sits in isError, question=null. The page can never show the real question, answer key, or per-choice breakdown for a reveal — it fails for the normal case of reviewing a question you just attempted.
- fix: Add optional attempt_id/session_id params to api.question (e.g. question(id, reveal=false, opts?:{attemptId?,sessionId?}) appending &attempt_id=&session_id=), thread them through useQuestion(id, includeExplanation, attemptId?, sessionId?), and pass attemptId/sessionId from Explanation.tsx:66. Verify against content.py:229-262.
- verifier: Verified every link in the cited causal chain against the real files.

1. api.ts:260-263 — `question(id, reveal=false)` requests `/api/questions/${id}?reveal=${reveal}` and never appends attempt_id/session_id. Confirmed.
2. content.py:265-276 — `get_question(..., reveal=True)` calls `_require_question_review_context`, which at lines 259-262 raises `HTTPException(403, "Review reveal requires an att

### [P1] Playlists page crashes: GET /api/playlists returns a wrapper object, frontend expects an array (verified: real)
- file: frontend/src/lib/api.ts:844
- evidence: playlist_routes.py:97 `return {"playlists": playlists.list_all(session), "criteria_keys": list(playlists.CRITERIA_KEYS)}`; Playlists.tsx:165 `{playlists.map((p) => (`; hooks.ts:1011 `withFallback(api.playlists, [] as ...PlaylistSummary[])`
- why: api.playlists() is typed request<PlaylistSummary[]>("/api/playlists") (an array), but the backend returns an OBJECT {playlists:[...], criteria_keys:[...]} (playlist_routes.py:96-101). There is no zod validation on this endpoint (bare cast) and the response is HTTP 200, so withFallback passes the object straight through. Playlists.tsx:54 sets `const playlists = data?.data ?? []` (now the wrapper object), then :146 reads playlists.length (undefined, so empty-state is skipped) and :165 calls playlists.map(...) -> TypeError: playlists.map is not a function -> ErrorBoundary. The entire Smart Sets/Playlists feature has been unusable since R7 (the wrapper was added in 6480d08). create/update/detail return the bare dict so those paths work — only the list is wrapped.
- fix: Either unwrap in api.playlists (return (resp as {playlists:PlaylistSummary[]}).playlists) or change the client to request<{playlists:PlaylistSummary[];criteria_keys:string[]}> and read .playlists in usePlaylists (hooks.ts:1008). Confirm against playlist_routes.py:95-101 and playlists.list_all (playlists.py:101-112).
- verifier: VERIFIED REAL — every link in the contract-mismatch chain holds against the actual code (note: backend path is backend/app/routers/playlist_routes.py, not backend/app/playlist_routes.py as cited, but content matches).

1. Backend: backend/app/routers/playlist_routes.py:95-101, list_playlists() returns the wrapper object {"playlists": playlists.list_all(session), "criteria_keys": list(playlists.CRI

### [P2] Bank browser reveal preview silently 403s (same missing reveal-context issue, no attempt exists)
- file: frontend/src/components/bank/question-browser.tsx:243
- evidence: question-browser.tsx:243 `void api.question(item.id, true).then((full) => {...})` (no .catch); content.py:265-276 reveal path requires attempt_id/session_id
- why: On clicking a bank row the browser calls api.question(item.id, true) to enrich the preview with the answer key, but there is no attempt/session context when browsing the bank, so the backend always returns 403 (content.py:259). The call has no .catch, so the 403 is swallowed and the preview never enriches (answer key/explanation never appear). Lower severity than the Explanation page because it is a degraded preview, not a broken core flow, and there is no legitimate attempt context to pass — it needs a product decision (allow owner bank-reveal without an attempt, or drop the reveal call).
- fix: Either relax the backend guard for the single-user owner bank-browse case, or stop requesting reveal here and show test-mode preview only. If keeping reveal, add a .catch so a failed enrich is explicit rather than silent.

### [P2] GenJob type and genCreateJob/genJob client methods do not match backend response (id vs job_id, wrong type)
- file: frontend/src/lib/api.ts:889
- evidence: generation_routes.py:46 `return {"job_id": jid, "status": GenStatus.queued.value}`; types.ts:1165 `id: string;` in GenJob; usage grep shows only api.genJobs and api.genQuarantine consumed
- why: genCreateJob is typed request<GenJob> but POST /api/gen/jobs returns only {job_id, status} (generation_routes.py:46) — there is no `id` field, while GenJob.id is required (types.ts:1165) and typed string (backend ids are ints). genJob is typed request<GenJob> but GET /api/gen/jobs/{id} returns id as an int plus a subset of fields (generation_routes.py:88-101). These are latent because genCreateJob/genJob/genRetryJob are dead (never referenced outside api.ts; only genJobs and genQuarantine are consumed via hooks). Worth fixing to prevent a future caller from trusting a wrong shape.
- fix: If keeping these methods, type genCreateJob as request<{job_id:number; status:string}> and genJob to match the real dict (id:number plus the progress fields); change GenJob.id to number. Otherwise delete the dead methods.

### [P2] ~24 dead API client methods defined but never referenced
- file: frontend/src/lib/api.ts:466
- evidence: comm of defined (170) vs referenced (146) api members yields the dead list; e.g. api.ts:466 notebookPages used but notebookPage(:470), createNotebookPage(:471), updateNotebookPage(:473), notebookStudySheet(:481) are not
- why: Methods including notebookPage, createNotebookPage, updateNotebookPage, notebookStudySheet, createNotebookSource, workspaces, createWorkspace, evidenceArtifacts, updateEvidenceArtifact, captureEvidence, resolveCitation, createContextPreset, upsertContentSource, adaptivityNext, hint, similar, report, explanationQuality, observabilityDiagnostics, deleteAnnotations, listImportJobs, genCreateJob, genJob, genRetryJob, genRetryQueuedJob are defined but never called anywhere in the app. They are dead surface area that can silently rot out of sync with the backend (e.g. the GenJob shape above). Not harmful at runtime, but it inflates the contract and hides real drift.
- fix: Delete the unused methods, or add a lint/test that flags exported api.* members with zero references. Keep only what pages/hooks consume.

### [P2] coachRefresh response omits the required `available` field of CoachSnapshot (currently harmless)
- file: frontend/src/lib/api.ts:1085
- evidence: ai_routes.py:336 `return {"text": snap.text, "recommendation": snap.recommendation_json, "created_at": ...}` (no available); types.ts:1185 `available: boolean;`
- why: coachRefresh is typed request<CoachSnapshot> (available: boolean is required, types.ts:1185) but POST /api/ai/coach/refresh returns only {text, recommendation, created_at} with no `available` (ai_routes.py:336-340). It does not break today because the only consumer (useRefreshCoach, mutations.ts:151) ignores the result and just invalidates the coach query. It is a type lie that would bite a future caller that reads .available.
- fix: Either add available:true to the backend coach/refresh response for parity with GET /api/ai/coach, or type coachRefresh as Omit<CoachSnapshot,'available'>. Low priority since unused.

## backend-integrity-firewall

> The export firewall, secrets handling, SQLite two-writer config, migrations, and the cloud budget gate are all genuinely well-built and well-tested — this is a mature, defense-in-depth codebase. The /api/bank/export firewall (bank_export.py) cannot emit official content: it strips at the PrepTest level (is_official), per-question (source==official), passages-by-reference, and even derived artifacts (embeddings/annotations/attempts/SRS/feedback) via an exportable_qids set; the HTTP endpoint hardcodes include_official=False; three tests (including a sentinel-string scan of the serialized payload) confirm no leak. The second export vector (notebook_os.export_bundle) independently redacts official content via a stored official_firewall flag that is computed from refs+question/passage/attempt provenance and cannot be turned off by the caller. Secrets: the Anthropic key lives only in env vars (config.CLOUD_API_KEY), is never written to the Setting table (model explicitly documents this), never returned by settings routes, and never logged (request middleware logs path-only at INFO; httpx errors don't expose x-api-key). SQLite config is correct: WAL + busy_timeout=5000 + synchronous=NORMAL + foreign_keys=ON applied on every connection for the two writers (request threads + job worker). Migrations are ordered, recorded, idempotent (IF NOT EXISTS / duplicate-column tolerance), checksum-tracked, and safe on existing DBs. Backups use the online-backup API (WAL-safe), are integrity+FK checked, and restore takes a pre-restore safety snapshot and rejects traversal/corrupt snapshots. The cloud monthly-budget gate fails CLOSED: a strict spend read that raises refuses the paid call (falls back to local), and the local path is never budget-limited — both tested. Findings below are refinements, not breaks in the core guarantees.

### [P1] Restore of an older-schema backup leaves the running app in a broken state until manual restart (no post-restore migration / no schema-compat check) (verified: real)
- file: backend/app/backup.py:960-992; backend/app/routers/backup_routes.py:52-58
- evidence: restore_backup() validates integrity_check and foreign_key_check on the snapshot, disposes the engine, then _copy_db(snap, target) overwrites the live DB. It never reads the snapshot's manifest schema_version, never compares it to the current expected version, and run_migrations is NOT called afterward. The route returns {'restored':..., 'restart_recommended': True} but nothing enforces the restart.
- why: If the owner restores a snapshot taken on an older schema (e.g. before a migration that added a column/table the running ORM now expects), the still-running FastAPI process and job worker will issue queries against missing columns and start throwing 500s mid-study until the app is manually restarted (only then does lifespan->init_db->run_migrations heal it). For a daily-driver local app a restore is exactly the moment you most need it to just work.
- fix: After _copy_db in restore_backup, re-run schema heal in-process: from .db import init_db; init_db() (which runs create_all + additive migrations + run_migrations) before returning, OR read backup.read_backup_manifest(snap) and reject with a clear error when manifest schema_version > current latest_expected_version (newer snapshot into older app = unsafe). At minimum surface restart_recommended as a hard 409 unless an explicit force flag is passed.
- verifier: Verified every load-bearing claim against the actual code.

restore_backup() (backend/app/backup.py:960-992): confirmed it validates integrity_check + foreign_key_check on the snapshot, takes a "prerestore" safety snapshot (line 983), calls engine.dispose() (985-989), then _copy_db(snap, target) (990). It never calls read_backup_manifest, never reads/compares manifest schema_version, and never cal

### [P2] Cloud budget gate is pre-call only: it admits a call while spend < budget, so a single call can push month-to-date spend past the cap
- file: backend/app/llm/__init__.py:108-123,159-164
- evidence: _cloud_within_budget() returns `spend < budget` using month-to-date spend BEFORE this call's cost; offline_generate then makes the full cloud call. There is no pre-estimate of the call's cost and no reservation, so the gate allows the call that crosses the threshold.
- why: CLOUD_MONTHLY_BUDGET_USD is sold as a 'hard ceiling on opt-in cloud spend' (config.py:288). In practice the ceiling can be exceeded by up to one call's cost (with CLOUD_MAX_TOKENS=2048 and Opus output pricing that is a small but non-zero overage). Minor for a single user, but the doc/intent says 'hard'.
- fix: Tighten to a worst-case pre-charge: estimate max cost = (len(prompt)/4 input + CLOUD_MAX_TOKENS output) priced via observability.cloud_cost_usd, and require spend + estimate <= budget before admitting. Or document that the cap is enforced 'to within one call'.

### [P2] Restore runs over a live DB while request threads and the job worker can reopen connections, racing the overwrite
- file: backend/app/backup.py:984-991
- evidence: restore_backup calls engine.dispose() then _copy_db(snap, target) while the server is still serving. The background job worker (config.JOBS_WORKER_ENABLED) and other request threads can open a NEW connection to `target` during/after dispose and before/while the backup write-transaction runs. WAL+busy_timeout reduce hard failures but a concurrent writer can still error or observe a half-restored state.
- why: A restore is initiated over HTTP on the running app; the worker may be mid-generation. The online-backup .backup() into an open connection is WAL-correct, but there is no quiescing of the worker first, so an in-flight write can collide and the restored DB can be immediately mutated by a stale-context writer.
- fix: Pause the worker before restore (jobs.get_worker().stop() / a restore lock) and/or set the app to a read-only 'maintenance' state for the duration; resume or require restart afterward. The existing 'restart_recommended' should ideally be a real stop-the-world.

### [P2] import-backup and bank import accept arbitrary source values including 'official', so a hand-crafted payload can inject score-affecting 'official' rows
- file: backend/app/bank_export.py:529; backend/app/routers/dataset_routes.py:400-433
- evidence: _commit_question builds Question(source=QuestionSource(payload.get('source','sample')), ...). The /api/bank/import-backup endpoint passes the caller-supplied body.payload straight to import_bank with no source allow-listing. QuestionSource('official') is a valid enum value, and 'official' rows are the only ones that feed score prediction.
- why: Score prediction trusts source=='official' as ground truth. A user importing a third-party 'portable export' (or a corrupted/edited bundle) could silently seed non-official questions tagged as official, contaminating score forecasts. The DB insert trigger (m012) only rejects NULL/unknown source, not a deliberately-set 'official'. Low likelihood for a strictly single-user local tool, but it is a provenance-integrity hole in the one direction the firewall cares about.
- fix: In import_bank/_commit_question, clamp imported source to the non-official set for the over-the-wire import-backup path (e.g. map 'official' -> 'sample' on import, or reject with a clear error), reserving 'official' creation for the in-process PDF import flow that has a real answer key + reconcile step.

### [P2] verify_restore only probes one orphan relationship (answer choices) and a settings-presence check — it under-reports a partially-failed restore
- file: backend/app/bank_export.py:977-1015
- evidence: verify_restore's referential-integrity probe checks only AnswerChoice.question_id orphans (the 'dangling' dict has a single key) and exact settings presence. backup.orphan_report (backup.py:198-324) already enumerates ~30 relationships (attempt->question/session, srscard->question, errorlogentry->attempt, embeddingvector, annotation, reflection->session, etc.).
- why: import-backup returns counts['verify'] as the user-facing post-restore guard rail. A restore that produced dangling attempts/SRS cards/error-log rows (e.g. exported_id remap gaps) would still report ok=True, giving false confidence in the integrity of a restored study history.
- fix: Have verify_restore call backup.orphan_report(config.DB_PATH) (or reuse its SELECTs against the live session) and fold total>0 into issues, rather than checking only answer choices.

### [P2] Notebook artifact free-text body bypasses the official firewall when official text is pasted without a ref/question/passage link
- file: backend/app/notebook_os.py:988-1016,1743-1757
- evidence: capture_artifact computes official = decision(refs) OR forced OR direct(question_id/passage_id/attempt_id). If a user creates a note/artifact by pasting official passage text into body with NO refs and no question/passage/attempt id, official stays False, so export_eligible=True and _export_artifact emits artifact.body verbatim (no redaction).
- why: The firewall can only detect official provenance via structured references; copyrighted text pasted as free text into a notebook artifact would be included in a notebook-export bundle. This is largely inherent to free text (the system can't know arbitrary prose is copyrighted) and the user would be exporting their own paste, but it is the one realistic path by which official wording could leave via the notebook export.
- fix: Document the limitation in the export UI, and/or add an optional heuristic that flags an artifact for manual firewall review when its body has high similarity (existing embeddings/cosine layer) to any official question/passage before allowing export.

### [P2] Bank list endpoint builds two redundant fields and counts via full materialization, but more notably constructs `like` it never uses
- file: backend/app/routers/dataset_routes.py:87-92
- evidence: In list_questions: `like = f"%{q}%"` is computed but the filter uses Question.stem.contains(q)/prompt.contains(q) (contains already wraps with %), so `like` is dead. Separately `total = len(session.exec(stmt).all())` materializes all matching rows just to count before re-querying with offset/limit.
- why: Not a correctness/security issue, but on a 12k-item bank the browse endpoint loads the entire filtered result set into memory on every paged request purely to compute total. Minor daily-use latency/memory waste; the dead `like` is a small code-smell that suggests the intended SQL count was never wired.
- fix: Use select(func.count()).select_from(stmt.subquery()) for total, and delete the unused `like` line.
