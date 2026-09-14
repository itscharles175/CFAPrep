import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { CircleCheck, CircleX, Keyboard, Loader2, PlayCircle } from "lucide-react";
import { KEYBOARD_HELP_EVENT } from "@lsat/components/keyboard-help";
import { Logo } from "@lsat/components/logo";
import { Button } from "@lsat/components/ui/button";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import { Icon } from "@lsat/components/ui/icon";
import { ToggleGroup, ToggleGroupItem } from "@lsat/components/ui/toggle-group";
import { StatNumber } from "@lsat/components/viz";
import { useAiHealth } from "@lsat/lib/hooks";
import { useSaveSettings } from "@lsat/lib/mutations";
import { fadeUp } from "@lsat/lib/motion";
import { cn } from "@lsat/lib/utils";
import {
  daysUntil,
  getGoal,
  isOnboardingDone,
  setGoal,
  setOnboardingDone,
} from "@lsat/lib/prefs";
import {
  isUnifiedOnboardingDismissed,
  setUnifiedOnboardingDismissed,
} from "@/lib/unifiedResume";
import {
  clearStudyContextOrigin,
  readStudyContextOrigin,
  stageStudyContextHandoff,
  writeStudyContext,
} from "@/lib/studyContext";
import { navigateDomain } from "@/lib/domainNav";

/**
 * R9 F3.1 — "First Light" onboarding. A full-bleed dark stage with a breathing
 * aurora behind the brand mark; the goal score + exam date are captured as
 * engraved `StatNumber voice="numeric" aurora` that update live as the user
 * drags the slider / picks a date. The existing steps (goal → Ollama →
 * import/sample → baseline → keyboard) are staged as calm cross-fades on one
 * canvas. SAME data / flow / persistence as before — purely a visual reskin.
 */
export function onboardingAppliesToRoute(pathname: string) {
  return pathname === "/" || pathname === "/dashboard";
}

export function setFirstLightChromeState(active: boolean) {
  if (typeof document === "undefined") return;
  if (active) {
    document.documentElement.dataset.lsatFirstLight = "active";
  } else {
    delete document.documentElement.dataset.lsatFirstLight;
  }
}

export function examCountdownPresentation(days: number | null) {
  if (days == null) {
    return { label: "Exam date", value: null, status: "Not set" };
  }
  return {
    label: days < 0 ? "Exam date passed" : "Days to exam",
    value: Math.max(0, days),
    status: undefined,
  };
}

export function OnboardingWizard() {
  const navigate = useNavigate();
  const location = useLocation();
  const reduce = useReducedMotion();
  // UX-3: also suppress when onboarding was settled on ANOTHER plane (the host
  // wizard sets the shared cross-domain dismiss flag). This is the LSAT → host
  // half of the two-way sync: a user who dismissed setup on the host never gets
  // the "First Light" wizard the first time they hop into /lsat.
  const [dismissedForSession, setDismissedForSession] = useState(false);
  const open =
    onboardingAppliesToRoute(location.pathname) &&
    !dismissedForSession &&
    !isOnboardingDone() &&
    getGoal() == null &&
    !isUnifiedOnboardingDismissed();
  const [step, setStep] = useState(0);
  const [targetScore, setTargetScore] = useState(165);
  const [examDate, setExamDate] = useState("");
  const returnOrigin = readStudyContextOrigin();

  const finish = useCallback(
    (skipped = false) => {
      if (!skipped) {
        setGoal({
          targetScore,
          examDate,
          bandLow: targetScore - 2,
          bandHigh: targetScore + 2,
        });
      }
      setOnboardingDone();
      // UX-3: settling the LSAT wizard (finish OR skip) also settles onboarding
      // for the host, so the host wizard never auto-opens afterwards. Paired with
      // the suppression in the `open` gate above, this is the two-way dismiss sync.
      setUnifiedOnboardingDismissed();
      clearStudyContextOrigin();
      setDismissedForSession(true);
    },
    [targetScore, examDate],
  );

  // Esc skips out of the stage (parity with the old Dialog's dismiss).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish]);

  // Diagnostics can be useful once the workspace is visible, but a background
  // toast must not read as part of first-run setup or cover its primary action.
  // The stage's local style hides Sonner only while this modal owns the screen.
  useEffect(() => {
    setFirstLightChromeState(open);
    return () => setFirstLightChromeState(false);
  }, [open]);

  const returnToCurriculum = useCallback(() => {
    const origin = readStudyContextOrigin();
    if (!origin || origin.context.domain === "lsat") return;
    // Keep the selector's source context as the canonical destination state
    // before the cross-domain root changes route trees.
    stageStudyContextHandoff(origin.context);
    writeStudyContext(origin.context);
    clearStudyContextOrigin();
    setDismissedForSession(true);
    navigateDomain(origin.route);
  }, []);

  if (!open) return null;

  const days = daysUntil(examDate);
  const examCountdown = examCountdownPresentation(days);

  return (
    <FirstLightStage
      reduce={!!reduce}
      onSkip={() => finish(true)}
      onReturnToCurriculum={returnOrigin?.context.domain !== "lsat" ? returnToCurriculum : undefined}
      returnLabel={returnOrigin ? `Return to ${returnOrigin.context.domain === "cfa" ? "CFA" : returnOrigin.context.domain === "quant" ? "Quant" : "Excel"}` : undefined}
    >
      <AnimatePresence mode="wait" initial={false}>
        {step === 0 && (
          <Scene key="goal" reduce={!!reduce}>
            <SceneHeader
              eyebrow="First light"
              title="Welcome to LSAT Lab"
              description="Set a target score and exam date so your console and analytics can show whether you're on track. You can change these anytime."
            />

            {/* Engraved live numerals — the captured goal, breathing. */}
            <div className="grid grid-cols-2 gap-6">
              <StatNumber
                label="Target score"
                value={targetScore}
                size="stat-xl"
                voice="numeric"
                aurora
              />
              {examCountdown.value == null ? (
                <div className="flex flex-col gap-1">
                  <span className="type-overline text-muted-foreground">{examCountdown.label}</span>
                  <div className="aurora">
                    <span className="stat type-numeric text-stat-xl leading-none font-semibold tabular-nums">—</span>
                  </div>
                  <p className="type-counsel mt-1 max-w-prose text-sm text-muted-foreground">
                    {examCountdown.status}
                  </p>
                </div>
              ) : (
                <StatNumber
                  label={examCountdown.label}
                  value={examCountdown.value}
                  size="stat-xl"
                  voice="numeric"
                  aurora
                />
              )}
            </div>

            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="onboard-score" className="type-overline text-muted-foreground">
                  Target score — {targetScore}
                </Label>
                <input
                  id="onboard-score"
                  type="range"
                  min={120}
                  max={180}
                  value={targetScore}
                  onChange={(e) => setTargetScore(Number(e.target.value))}
                  className="w-full accent-[hsl(var(--primary))]"
                />
                <div className="flex justify-between text-2xs tabular-nums text-muted-foreground">
                  <span>120</span>
                  <span>180</span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="onboard-date" className="type-overline text-muted-foreground">
                  Exam date
                </Label>
                <Input
                  id="onboard-date"
                  type="date"
                  value={examDate}
                  onChange={(e) => setExamDate(e.target.value)}
                  className="bg-surface-2"
                />
              </div>
            </div>

            <StageActions
              onSkip={() => finish(true)}
              primary={<Button onClick={() => setStep(1)}>Next</Button>}
            />
          </Scene>
        )}

        {step === 1 && (
          <Scene key="ollama" reduce={!!reduce}>
            <OnboardingOllamaStep onNext={() => setStep(2)} onSkip={() => setStep(2)} />
          </Scene>
        )}

        {step === 2 && (
          <Scene key="import" reduce={!!reduce}>
            <SceneHeader
              eyebrow="Anchor your data"
              title="Import your first PrepTest"
              description="Official questions anchor your score trend and blind-review workflow. You can import anytime from Setup."
            />
            <div className="flex flex-col gap-2.5">
              <Button onClick={() => { finish(); navigate("/import"); }}>
                Go to Import
              </Button>
              {/* R7 6.4 — reach the core loop before importing anything. */}
              <Button
                variant="outline"
                onClick={() => {
                  finish();
                  navigate("/take/11");
                }}
              >
                <Icon as={PlayCircle} size="sm" />
                Try a sample section
              </Button>
              <Button variant="ghost" onClick={() => setStep(3)}>
                Skip — continue setup
              </Button>
            </div>
          </Scene>
        )}

        {step === 3 && (
          <Scene key="baseline" reduce={!!reduce}>
            <SceneHeader
              eyebrow="Calibrate"
              title="Baseline 5-question drill"
              description="A quick untimed drill calibrates your starting point before full sections. Takes about 10 minutes."
            />
            <div className="flex flex-col gap-2.5">
              <Button
                onClick={() => {
                  finish();
                  navigate("/drills?count=5&untimed=1");
                }}
              >
                Start baseline drill
              </Button>
              <Button variant="outline" onClick={() => setStep(4)}>
                Skip for now
              </Button>
            </div>
          </Scene>
        )}

        {step === 4 && (
          <Scene key="keyboard" reduce={!!reduce}>
            <SceneHeader
              eyebrow="Move faster"
              title="Keyboard shortcuts"
              description="Press ? anytime during practice for the full map. Try it now or finish setup."
            />
            <div className="flex flex-col gap-2.5">
              <Button
                variant="outline"
                onClick={() => {
                  finish();
                  window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT));
                }}
              >
                <Icon as={Keyboard} size="sm" />
                Open keyboard tour
              </Button>
              <Button variant="ghost" onClick={() => finish()}>
                Done for now
              </Button>
            </div>
          </Scene>
        )}
      </AnimatePresence>

      <StepDots count={5} current={step} />
    </FirstLightStage>
  );
}

// ---------------------------------------------------------------------------
// Stage scaffolding — the dark canvas, the breathing aurora behind the Logo,
// and a single column where the steps cross-fade.
// ---------------------------------------------------------------------------

function FirstLightStage({
  children,
  reduce,
  onSkip,
  onReturnToCurriculum,
  returnLabel,
}: {
  children: ReactNode;
  reduce: boolean;
  onSkip: () => void;
  onReturnToCurriculum?: () => void;
  returnLabel?: string;
}) {
  return (
    <m.div
      role="dialog"
      aria-modal="true"
      aria-label="StudyVault LSAT setup"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      // The whole stage is the dark "observatory" floor — token-driven so it
      // re-themes across light / dark / focus-paper / high-contrast.
      className="lsat-first-light-stage bg-surface-0 fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto p-6 print:hidden"
    >
      <style>{'html[data-lsat-first-light="active"] [data-sonner-toaster]{display:none!important}'}</style>
      <header className="absolute inset-x-0 top-0 flex items-center justify-between border-b border-border/70 bg-surface-0/90 px-5 py-3 backdrop-blur-sm sm:px-8">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo className="h-6 w-6 shrink-0" />
          <span className="type-overline truncate text-foreground">StudyVault</span>
          <span aria-hidden className="text-muted-foreground">/</span>
          <span className="truncate text-xs text-muted-foreground">LSAT setup</span>
        </div>
        <div className="flex items-center gap-1">
          {onReturnToCurriculum && returnLabel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReturnToCurriculum}
              title="Return to the curriculum you were studying"
            >
              {returnLabel}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip setup
          </Button>
        </div>
      </header>
      {/* Brand mark catching the breathing aurora. */}
      <div className="aurora mb-8 flex items-center justify-center">
        <Logo className="h-14 w-14" />
      </div>
      <div className="w-full max-w-md space-y-8">{children}</div>
    </m.div>
  );
}

function Scene({ children, reduce }: { children: ReactNode; reduce: boolean }) {
  return (
    <m.div
      variants={reduce ? undefined : fadeUp}
      initial={reduce ? false : "hidden"}
      animate="show"
      exit={reduce ? undefined : "exit"}
      className="space-y-7"
    >
      {children}
    </m.div>
  );
}

function SceneHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-2 text-center">
      <p className="type-overline text-muted-foreground">{eyebrow}</p>
      <h1 className="type-display text-3xl leading-tight">{title}</h1>
      <p className="type-counsel mx-auto max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
        {description}
      </p>
    </div>
  );
}

function StageActions({
  onSkip,
  primary,
}: {
  onSkip: () => void;
  primary: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Button variant="ghost" onClick={onSkip}>
        Skip
      </Button>
      {primary}
    </div>
  );
}

function StepDots({ count, current }: { count: number; current: number }) {
  return (
    <div className="mt-10 flex items-center gap-2" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-all duration-300",
            i === current
              ? "w-6 bg-primary"
              : i < current
                ? "w-1.5 bg-primary/50"
                : "w-1.5 bg-muted-foreground/30",
          )}
        />
      ))}
    </div>
  );
}

export function OnboardingOllamaStep({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}) {
  const health = useAiHealth();
  const h = health.data?.data;
  const saveProvider = useSaveSettings();
  // Provider-agnostic readiness: prefer the generic `ok` (active provider
  // reachable), falling back to the legacy `ollama` boolean on an older backend.
  const ready = Boolean(h?.ok ?? h?.ollama);
  // First-run users can CHOOSE their local provider here, not just see whichever
  // the backend defaults to (Ollama). Saving `local_provider` optimistically
  // flips the active provider in the ai-health cache (and refetches), so the copy
  // and status below follow the selection live. Reflect the in-flight choice now.
  const pendingProvider = saveProvider.variables?.local_provider;
  const selectedProvider =
    (saveProvider.isPending && typeof pendingProvider === "string"
      ? pendingProvider
      : null) ??
    h?.provider ??
    "ollama";
  const isLmStudio = selectedProvider === "lmstudio";
  const providerLabel = isLmStudio ? "LMStudio" : "Ollama";
  const models = h?.models ?? [];
  const hasExplain = models.some((m) => m.includes("qwen3:8b") || m.includes("qwen3"));
  const hasEmbed = models.some((m) => m.includes("nomic-embed"));

  return (
    <>
      <SceneHeader
        eyebrow="Local intelligence"
        title={`Local AI (${providerLabel})`}
        description={`Explanations, coaching, and tagging run on your machine via ${providerLabel}. Install ${providerLabel}, then load the recommended models before your first section.`}
      />
      <div className="space-y-3 text-sm">
        {/* Choose the local provider up-front — a fresh LM Studio user shouldn't
            be shown Ollama instructions for the whole wizard. */}
        <div className="flex items-center justify-center gap-2">
          <span className="text-muted-foreground">Provider</span>
          <ToggleGroup
            type="single"
            value={selectedProvider}
            onValueChange={(v) => v && saveProvider.mutate({ local_provider: v })}
            disabled={saveProvider.isPending}
            aria-label="Local AI provider"
            className="overflow-hidden rounded-md border"
          >
            {(["ollama", "lmstudio"] as const).map((p) => (
              <ToggleGroupItem
                key={p}
                value={p}
                className="h-auto rounded-none px-3 py-1 text-xs font-medium data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {p === "lmstudio" ? "LMStudio" : "Ollama"}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {health.isLoading ? (
          <p className="flex items-center justify-center gap-2 text-muted-foreground">
            <Icon as={Loader2} size="sm" className="animate-spin" />
            Checking {providerLabel}…
          </p>
        ) : ready ? (
          <p className="flex items-center justify-center gap-2 text-success">
            <Icon as={CircleCheck} size="sm" />
            {providerLabel} is reachable
          </p>
        ) : (
          <p className="flex items-center justify-center gap-2 text-warning">
            <Icon as={CircleX} size="sm" />
            {isLmStudio
              ? "LMStudio server not detected — start it and load a model"
              : "Ollama not detected on localhost:11434"}
          </p>
        )}
        <ul className="space-y-1.5 rounded-card bg-surface-1 p-4 text-muted-foreground">
          {isLmStudio ? (
            <>
              <li>
                Install:{" "}
                <a
                  href="https://lmstudio.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  lmstudio.ai
                </a>
              </li>
              <li>Load a chat model, then start the local server (the “Server” tab).</li>
              <li>
                It serves an OpenAI-compatible endpoint at{" "}
                <code className="rounded bg-surface-2 px-1">localhost:1234/v1</code>.
              </li>
            </>
          ) : (
            <>
              <li>
                Install:{" "}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  ollama.com/download
                </a>
              </li>
              <li>
                Then run:{" "}
                <code className="rounded bg-surface-2 px-1">ollama pull qwen3:8b</code>
              </li>
              <li>
                Embeddings:{" "}
                <code className="rounded bg-surface-2 px-1">
                  ollama pull nomic-embed-text
                </code>
              </li>
            </>
          )}
        </ul>
        {ready && (
          <p className="text-center text-xs text-muted-foreground">
            Models: {models.length ? models.join(", ") : "none listed"}
            {!isLmStudio && !hasExplain && " · pull qwen3:8b for explanations"}
            {!isLmStudio && !hasEmbed && " · pull nomic-embed-text for similarity"}
          </p>
        )}
        {isLmStudio && ready && (h?.missing_models?.length ?? 0) > 0 && (
          <p className="text-center text-xs text-warning">
            {h?.missing_models?.length} model role
            {(h?.missing_models?.length ?? 0) === 1 ? "" : "s"} not loaded — open
            Settings → AI &amp; system to assign a loaded model to each role.
          </p>
        )}
      </div>
      <StageActions
        onSkip={onSkip}
        primary={
          <Button onClick={onNext}>
            {ready && (isLmStudio || hasExplain) ? "Continue" : "Continue anyway"}
          </Button>
        }
      />
    </>
  );
}
