import { lazy, Suspense, useEffect, useMemo } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  getCommandRecents,
  pushCommandRecent,
  routeCommandLabel,
} from "@lsat/lib/commandRecents";
import { AnimatePresence } from "motion/react";
import {
  Keyboard,
  ListMusic,
  Moon,
  Palette,
  PlayCircle,
  RotateCcw,
  Sun,
  SwatchBook,
} from "lucide-react";
import { toast, Toaster } from "sonner";
import { AppShell } from "@lsat/components/app-shell";
import { PageTransition } from "@lsat/components/page-transition";
import { KeyboardHelp, KEYBOARD_HELP_EVENT } from "@lsat/components/keyboard-help";
import {
  CommandPaletteProvider,
  type CommandAction,
} from "@lsat/components/command-palette";
import { useTheme } from "@lsat/components/theme-provider";
import { useMode } from "@lsat/components/mode-provider";
import { OnboardingWizard } from "@lsat/components/onboarding-wizard";
import {
  LoadingState,
  SkeletonDetailPage,
  SkeletonExam,
  SkeletonListPage,
} from "@lsat/components/states";
import { getResume } from "@lsat/lib/resume";
import {
  listenBackendDegraded,
  listenBackendReady,
  listenFirewallBlocked,
  listenJobProgress,
  listenOpenFile,
  listenQuickCaptureNote,
  listenTrayNavigate,
  listenTrayOpen,
} from "@lsat/lib/tauri";
import {
  GlobalLoadingBar,
  SuspenseSignal,
} from "@lsat/components/global-loading-bar";
import { OfflineBanner } from "@lsat/components/offline-banner";
import { AiPrereqBanner } from "@lsat/components/ai-prereq-banner";
import { Button } from "@lsat/components/ui/button";
import { IllustrationError } from "@lsat/components/illustrations";
import { ErrorBoundary } from "@lsat/components/error-boundary";
import {
  canonicalRoutePath,
  primaryRouteManifest,
  routeIsVisible,
  routeManifest,
} from "@lsat/lib/routeManifest";
// S4: cross-domain jumps into the StudyVault host (the `@` alias → /src).
import { navigateDomain } from "@/lib/domainNav";

// Code-split heavy routes (R4-H1) + non-critical shelled routes (R5-J1).
// P5 — the full-bleed exam screens are large and never the first paint (the
// landing route is Dashboard), so they are lazy-loaded too to shrink the entry
// chunk.
const TakeSection = lazy(() => import("@lsat/pages/TakeSection"));
const BlindReview = lazy(() => import("@lsat/pages/BlindReview"));
const Exam = lazy(() => import("@lsat/pages/Exam"));
const PrepTests = lazy(() => import("@lsat/pages/PrepTests"));
const Drills = lazy(() => import("@lsat/pages/Drills"));
const Playlists = lazy(() => import("@lsat/pages/Playlists"));
const Practice = lazy(() => import("@lsat/pages/Practice"));
const Dashboard = lazy(() => import("@lsat/pages/Dashboard"));
const Review = lazy(() => import("@lsat/pages/Review"));
const Srs = lazy(() => import("@lsat/pages/Srs"));
const SettingsPage = lazy(() => import("@lsat/pages/Settings"));
const Analytics = lazy(() => import("@lsat/pages/Analytics"));
const Tutor = lazy(() => import("@lsat/pages/Tutor"));
const Notebook = lazy(() => import("@lsat/pages/Notebook"));
const RcLab = lazy(() => import("@lsat/pages/RcLab"));
const ContentOps = lazy(() => import("@lsat/pages/ContentOps"));
const Styleguide = lazy(() => import("@lsat/pages/Styleguide"));
const Import = lazy(() => import("@lsat/pages/Import"));
const Bank = lazy(() => import("@lsat/pages/Bank"));
const BankTagReview = lazy(() => import("@lsat/pages/BankTagReview"));
const PassagePopout = lazy(() => import("@lsat/pages/PassagePopout"));
const Quarantine = lazy(() => import("@lsat/pages/Quarantine"));
const Explanation = lazy(() => import("@lsat/pages/Explanation"));
const SessionHistory = lazy(() => import("@lsat/pages/SessionHistory"));
const TypeAnalytics = lazy(() => import("@lsat/pages/TypeAnalytics"));
const PrepTestAnalytics = lazy(() => import("@lsat/pages/PrepTestAnalytics"));
const NotFound = lazy(() => import("@lsat/pages/NotFound"));

/**
 * R9 (docs/19 F2.2 + F7) — a Suspense boundary whose fallback is a route-shaped
 * skeleton (not the centered spinner) AND which drives the global loading bar via
 * `<SuspenseSignal/>`. Every lazy route used to flash `<LoadingState/>`, ignoring
 * the page it was becoming; now each route declares the silhouette it settles
 * into. `fallback` defaults to a generic list-page skeleton.
 */
function LazyPage({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <>
          <SuspenseSignal />
          {fallback ?? <SkeletonListPage />}
        </>
      }
    >
      {children}
    </Suspense>
  );
}

/** Shorthand fallbacks so each route can pick the silhouette it becomes. */
const listFallback = (width?: "md" | "lg" | "xl" | "2xl" | "full") => (
  <>
    <SuspenseSignal />
    <SkeletonListPage width={width} />
  </>
);
const detailFallback = (width?: "md" | "lg" | "xl" | "2xl" | "full") => (
  <>
    <SuspenseSignal />
    <SkeletonDetailPage width={width} />
  </>
);
const examFallback = (
  <>
    <SuspenseSignal />
    <SkeletonExam />
  </>
);

/** Routes that live inside the app shell, animated by route transition.
 *
 * R9 (docs/19 F2.2): each lazy route now carries its OWN in-shell Suspense
 * boundary (via `<LazyPage>`) with a route-shaped skeleton, so a chunk loading
 * keeps the sidebar/header painted and only the content column settles in.
 * Previously the eager-imported pages relied on a single outer fallback that
 * blanked the whole shell to a centered spinner. The outer boundary remains only
 * as a safety net (it should not normally trigger, since every route resolves
 * its own). */
function ShelledRoutes() {
  const location = useLocation();
  return (
    <Suspense fallback={listFallback("xl")}>
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route element={<AppShell />}>
          <Route
            path="/"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <Notebook />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/dashboard"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <Dashboard />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/practice"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback("xl")}>
                  <Practice />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/preptests"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback("xl")}>
                  <PrepTests />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/drills"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback("xl")}>
                  <Drills />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/playlists"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback()}>
                  <Playlists />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/review"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback()}>
                  <Review />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/srs"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback()}>
                  <Srs />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/analytics"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <Analytics />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/tutor"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <Tutor />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/notebook"
            element={<Navigate to="/" replace />}
          />
          <Route
            path="/rc-lab"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <RcLab />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/content-ops"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <ContentOps />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/import"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback()}>
                  <Import />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/bank"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback("xl")}>
                  <Bank />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/bank/tag-review"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("xl")}>
                  <BankTagReview />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/quarantine"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback("xl")}>
                  <Quarantine />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/review/history"
            element={
              <PageTransition>
                <LazyPage fallback={listFallback("xl")}>
                  <SessionHistory />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/analytics/type/:qType"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <TypeAnalytics />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/analytics/pt/:ptId"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback("2xl")}>
                  <PrepTestAnalytics />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="/settings"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback()}>
                  <SettingsPage />
                </LazyPage>
              </PageTransition>
            }
          />
          {import.meta.env.DEV && (
            <Route
              path="/dev/styleguide"
              element={
                <PageTransition>
                  <LazyPage fallback={detailFallback("2xl")}>
                    <Styleguide />
                  </LazyPage>
                </PageTransition>
              }
            />
          )}
          <Route
            path="/explanation/:questionId"
            element={
              <PageTransition>
                <LazyPage fallback={detailFallback()}>
                  <Explanation />
                </LazyPage>
              </PageTransition>
            }
          />
          <Route
            path="*"
            element={
              <PageTransition>
                <LazyPage fallback={<LoadingState />}>
                  <NotFound />
                </LazyPage>
              </PageTransition>
            }
          />
        </Route>
      </Routes>
    </AnimatePresence>
    </Suspense>
  );
}

function GlobalChrome({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { resolved, setTheme } = useTheme();
  const { mode, setMode } = useMode();

  useEffect(() => {
    pushCommandRecent(location.pathname);
  }, [location.pathname]);

  // Native shell → frontend wiring (W8). All no-op in the browser.
  useEffect(() => {
    // Tray "Open"/"Resume", a second launch, and the global shortcut → resume.
    const offOpen = listenTrayOpen(() => {
      const ptr = getResume();
      if (ptr?.path) navigate(ptr.path);
    });
    // Tray "Today's SRS" / "Quick drill" → navigate to the emitted route.
    const offNav = listenTrayNavigate((path) => navigate(path));
    // 4.3 — "Open with LSAT Lab" on a .pdf → import wizard, pre-loaded.
    const offFile = listenOpenFile((openFile) =>
      navigate("/import", { state: { openFile } }),
    );
    const offReady = listenBackendReady(() => {
      toast.success("Backend ready");
    });
    const offDegraded = listenBackendDegraded((status) => {
      toast.warning(status.message || "Backend degraded");
    });
    const offCapture = listenQuickCaptureNote((body) => {
      navigate("/", { state: { quickCapture: body } });
      toast.success(body ? "Quick capture opened" : "Notebook OS opened");
    });
    const offProgress = listenJobProgress((payload) => {
      if (payload.status === "open") {
        toast.info(`${payload.kind} ready`);
      }
    });
    const offFirewall = listenFirewallBlocked((payload) => {
      toast.warning(payload.reason || "Official-content firewall blocked this action");
    });
    return () => {
      offOpen();
      offNav();
      offFile();
      offReady();
      offDegraded();
      offCapture();
      offProgress();
      offFirewall();
    };
  }, [navigate]);

  const actions: CommandAction[] = useMemo(
    () => {
      const visibleRoutes = primaryRouteManifest(mode);
      const currentPath = canonicalRoutePath(location.pathname);
      const recents: CommandAction[] = getCommandRecents()
        .filter((p) => p !== currentPath)
        .filter((p) => {
          const manifestEntry = routeManifest.find((entry) => entry.path === p);
          return manifestEntry ? routeIsVisible(manifestEntry, mode) : true;
        })
        .slice(0, 5)
        .map((path) => ({
          id: `recent-${path}`,
          group: "Recent",
          label: routeCommandLabel(path),
          perform: () => navigate(path),
        }));
      const navActions: CommandAction[] = visibleRoutes
        .map((entry) => {
          const Icon = entry.icon;
          return {
            id: `nav-${entry.path === "/" ? "home" : entry.path.slice(1).replace(/\//g, "-")}`,
            group: "Navigate",
            label: entry.commandLabel,
            icon: <Icon className="h-4 w-4" />,
            keywords: entry.keywords,
            perform: () => navigate(entry.path),
          };
        });
      if (import.meta.env.DEV) {
        navActions.push({
          id: "nav-styleguide",
          group: "Navigate",
          label: "Open Design System (styleguide)",
          icon: <SwatchBook className="h-4 w-4" />,
          keywords: ["dev", "tokens", "colors"],
          perform: () => navigate("/dev/styleguide"),
        });
      }
      // S4: the LSAT ⌘K also reaches the StudyVault host domains — one palette
      // spans both apps. These soft-swap domains (no full reload).
      const hostActions: CommandAction[] = [
        { id: "host-home", group: "StudyVault", label: "StudyVault Home", keywords: ["host", "dashboard", "home"], perform: () => navigateDomain("/") },
        { id: "host-cfa", group: "StudyVault", label: "CFA Program", keywords: ["host", "cfa", "finance"], perform: () => navigateDomain("/cfa") },
        { id: "host-quant", group: "StudyVault", label: "Quant Finance", keywords: ["host", "quant"], perform: () => navigateDomain("/quant") },
        { id: "host-excel", group: "StudyVault", label: "Excel Training", keywords: ["host", "excel"], perform: () => navigateDomain("/excel") },
        { id: "host-today", group: "StudyVault", label: "Today (host)", keywords: ["host", "today", "plan"], perform: () => navigateDomain("/today") },
        { id: "host-review", group: "StudyVault", label: "Review Inbox (host)", keywords: ["host", "review", "due"], perform: () => navigateDomain("/review") },
      ];
      return [
      ...recents,
      ...navActions,
      ...hostActions,
      // ---- Actions ----
      {
        id: "act-start-drill",
        group: "Actions",
        label: "Start a drill",
        icon: <PlayCircle className="h-4 w-4" />,
        keywords: ["practice", "question type", "new"],
        perform: () => navigate("/drills"),
      },
      {
        id: "act-smart-set",
        group: "Actions",
        label: "Create a smart set",
        icon: <ListMusic className="h-4 w-4" />,
        keywords: ["playlist", "custom set", "problem set", "new set"],
        perform: () => navigate("/playlists"),
      },
      {
        id: "act-srs-today",
        group: "Actions",
        label: "Go to today's SRS review",
        icon: <RotateCcw className="h-4 w-4" />,
        keywords: ["due", "cards", "review today"],
        perform: () => navigate("/srs"),
      },
      {
        id: "act-keyboard-help",
        group: "Actions",
        label: "Open keyboard shortcuts",
        icon: <Keyboard className="h-4 w-4" />,
        keywords: ["help", "hotkeys", "?"],
        perform: () => window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT)),
      },
      {
        id: "toggle-theme",
        group: "Actions",
        label: resolved === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
        keywords: ["dark", "light", "theme", "appearance"],
        perform: () => setTheme(resolved === "dark" ? "light" : "dark"),
      },
      {
        id: "toggle-mode",
        group: "Actions",
        label: mode === "test" ? "Switch to Study Mode" : "Switch to Test Mode",
        icon: <Palette className="h-4 w-4" />,
        keywords: ["study", "test", "mode", "focus"],
        perform: () => setMode(mode === "test" ? "study" : "test"),
      },
    ];
    },
    [location.pathname, navigate, resolved, setTheme, mode, setMode],
  );

  return (
    <CommandPaletteProvider initialActions={actions}>
      {/* R9 (docs/19 F1.1): `data-app-root` lets the root go transparent under
          native Mica (`html.mica` rules in index.css); opaque `bg-background`
          everywhere else. R9 F7: the loading bar is now a provider wrapping the
          frame so `<SuspenseSignal/>` inside route boundaries can drive it. */}
      <GlobalLoadingBar>
        <div
          data-app-root
          className="flex h-screen w-full flex-col overflow-hidden bg-background"
        >
          {/* K4-13: the LSAT App is always mounted inside the host <SharedLayout>,
              whose TopBar is the single window chrome — so this app no longer
              renders its own <Titlebar/> (it was removed in the final cutover). */}
          <OfflineBanner />
          <AiPrereqBanner />
          <div className="min-h-0 flex-1">
            <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
          </div>
        </div>
      </GlobalLoadingBar>
      <KeyboardHelp />
      <OnboardingWizard />
      {/* R10 C2 — toasts speak the design-system token language (was sonner's
          stock richColors), and because the classes are token-driven they inherit
          the .high-contrast theme for free — fixing the prior HC contrast hole. */}
      <Toaster
        position="bottom-right"
        closeButton
        theme={resolved}
        toastOptions={{
          classNames: {
            toast:
              "rounded-card border bg-popover text-popover-foreground shadow-e2 font-sans",
            title: "font-medium",
            description: "text-muted-foreground",
            actionButton: "rounded-md bg-primary text-primary-foreground",
            cancelButton: "rounded-md bg-muted text-muted-foreground",
            closeButton: "border-border bg-popover text-muted-foreground",
            success: "[&_[data-icon]]:text-success",
            error: "[&_[data-icon]]:text-destructive",
            warning: "[&_[data-icon]]:text-warning",
            info: "[&_[data-icon]]:text-info",
          },
        }}
      />
    </CommandPaletteProvider>
  );
}

export default function App() {
  const location = useLocation();
  // Full-bleed exam screens manage their own chrome; render them outside the
  // shell + page-transition wrapper.
  const fullBleed =
    location.pathname.startsWith("/take/") ||
    location.pathname.startsWith("/exam/") ||
    location.pathname.startsWith("/blind-review/") ||
    location.pathname.startsWith("/popout/");

  return (
    <GlobalChrome>
      {fullBleed ? (
        // C6 — animate entry/exit on full-bleed exam screens (motion-safe via
        // MotionProvider) so starting/finishing a section isn't a hard cut.
        // R9 (docs/19 F2.2): the exam-shaped skeleton replaces the centered
        // spinner so a heavy exam chunk reads as the test frame settling in.
        <ErrorBoundary
          key={location.pathname}
          resetKey={location.pathname}
          fallback={(_err, reset) => {
            const resume = getResume();
            return (
              <div
                role="alert"
                className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
              >
                <IllustrationError />
                <div className="space-y-1">
                  <p className="text-base font-semibold">Something went wrong during this session</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    Your answers so far are saved. Retry this screen, resume where you
                    left off, or reload the app.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" onClick={reset}>
                    Retry
                  </Button>
                  {resume && (
                    <Button asChild variant="outline" size="sm">
                      <a href={resume.path}>Resume {resume.label}</a>
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
                    Reload page
                  </Button>
                </div>
              </div>
            );
          }}
        >
        <Suspense fallback={examFallback}>
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route
              path="/take/:sectionId"
              element={
                <PageTransition>
                  <TakeSection />
                </PageTransition>
              }
            />
            <Route
              path="/take/session/:sessionId"
              element={
                <PageTransition>
                  <TakeSection sessionMode />
                </PageTransition>
              }
            />
            <Route
              path="/exam/:preptestId"
              element={
                <PageTransition>
                  <Exam />
                </PageTransition>
              }
            />
            <Route
              path="/blind-review/:sessionId"
              element={
                <PageTransition>
                  <BlindReview />
                </PageTransition>
              }
            />
            <Route
              path="/popout/passage"
              element={
                <LazyPage fallback={<LoadingState />}>
                  <PassagePopout />
                </LazyPage>
              }
            />
            {/* AUDIT-4 — a malformed /lsat full-bleed URL (e.g. /lsat/exam with no
                id) matches the full-bleed prefix but no concrete route above; without
                this catch-all it rendered blank. Mirror the shelled branch's 404. */}
            <Route
              path="*"
              element={
                <PageTransition>
                  <LazyPage fallback={<LoadingState />}>
                    <NotFound />
                  </LazyPage>
                </PageTransition>
              }
            />
          </Routes>
        </AnimatePresence>
        </Suspense>
        </ErrorBoundary>
      ) : (
        <ShelledRoutes />
      )}
    </GlobalChrome>
  );
}
