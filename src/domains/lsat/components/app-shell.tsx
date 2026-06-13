import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { saveScroll, restoreScroll } from "@/lib/scrollRestore";
import { prefetchRoute } from "@/lib/routePrefetch";
import { m, useReducedMotion } from "motion/react";
import {
  Flame,
  type LucideIcon,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
} from "lucide-react";
import { cn, countLabel } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/keyboard-help";
import { RouteBreadcrumb } from "@/components/breadcrumb";
import { useCommandPalette } from "@/components/command-palette";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "@/components/theme-provider";
import { useMode } from "@/components/mode-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboard, useSrsDue } from "@/lib/hooks";
import { getRaw, setRaw } from "@/lib/storage";
import { manifestRoutesByGroup, type RouteManifestEntry } from "@/lib/routeManifest";

// R9 (docs/19 F4) — persisted rail-collapse pin. Not in STORAGE_KEYS (that
// registry is owned elsewhere); the storage module accepts an explicit key
// string, and this one is namespaced under `lsatlab.` like the rest.
const SIDEBAR_COLLAPSED_KEY = "lsatlab.sidebarCollapsed";
// The rail auto-collapses below this width unless the user has pinned it open.
const NARROW_QUERY = "(max-width: 1100px)";
const APP_VERSION = `v${import.meta.env.VITE_APP_VERSION ?? "dev"}`;

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: () => React.ReactNode;
  hideInTest?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

function NavRow({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const reduce = useReducedMotion();

  const link = (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      // Perceived speed: warm the destination's code-split chunk on hover/focus
      // so the click navigates instantly (intent-based; no speculative waste).
      onMouseEnter={() => prefetchRoute(item.to)}
      onFocus={() => prefetchRoute(item.to)}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
          // R9 (docs/19 F4): luminance hover/active on the depth ladder
          // (bg-surface-*, static) instead of accent washes.
          "transition-colors hover:bg-surface-2 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          // tasteful press feedback (§2.7), reduced-motion-safe via global MotionConfig + transition utility
          "active:scale-[0.98] motion-reduce:active:scale-100",
          isActive ? "text-foreground" : "text-muted-foreground",
          collapsed && "justify-center px-2",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Animated active-indicator bar (layoutId slides between rows; the
              reduced-motion branch swaps to a static bar). */}
          {isActive &&
            (reduce ? (
              <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
            ) : (
              <m.span
                layoutId="nav-active-bar"
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                transition={{ type: "spring", stiffness: 500, damping: 32 }}
              />
            ))}
          {/* Active fill — a raised surface step, not an opacity wash. */}
          <span
            className={cn(
              "absolute inset-0 rounded-md bg-surface-2 opacity-0 transition-opacity",
              isActive && "opacity-100",
            )}
            aria-hidden
          />
          <Icon
            as={item.icon}
            size="md"
            className={cn(
              "relative z-10 transition-colors",
              isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
            )}
          />
          {!collapsed && <span className="relative z-10">{item.label}</span>}
          {!collapsed && <span className="relative z-10 ml-auto">{item.badge?.()}</span>}
        </>
      )}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }
  return link;
}

/**
 * R9 (docs/19 F3) — a discoverable affordance for the (fully built but otherwise
 * invisible) ⌘K command palette. Expanded: a faux search field with a `Kbd`
 * hint. Collapsed: an icon button with a tooltip. Both open the real palette;
 * the bracketed press feedback is reduced-motion-safe.
 */
function CommandAffordance({ collapsed }: { collapsed: boolean }) {
  const { setOpen } = useCommandPalette();

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Search or jump to… (Command-K)"
            className="flex w-full items-center justify-center rounded-md border bg-surface-1 p-2 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:active:scale-100"
          >
            <Icon as={Search} size="sm" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Search or jump to… ⌘K</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Search or jump to… (Command-K)"
      className="group flex w-full items-center gap-2 rounded-md border bg-surface-1 px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] motion-reduce:active:scale-100"
    >
      <Icon as={Search} size="sm" className="text-muted-foreground" />
      <span className="flex-1 text-left">Search or jump to…</span>
      {/* The ⌘K chip mirrors the command palette's own keycap voice (the
          `Kbd` chip is shared from keyboard-help). */}
      <span className="flex shrink-0 items-center gap-0.5">
        <Kbd>⌘K</Kbd>
      </span>
    </button>
  );
}

function NavRail({ collapsed }: { collapsed: boolean }) {
  const { data: srs } = useSrsDue();
  const { mode } = useMode();
  const dueCount = srs?.data.due_count ?? 0;

  const srsBadge = () =>
    dueCount > 0 ? (
      <Badge
        variant="secondary"
        className="animate-pulse motion-reduce:animate-none"
        aria-label={`${countLabel(dueCount, "card")} due`}
      >
        {dueCount}
      </Badge>
    ) : null;

  const visibleSections: NavSection[] = manifestRoutesByGroup(mode).map((section) => ({
    label: section.group,
    items: section.items.map((entry: RouteManifestEntry) => ({
      to: entry.path,
      label: entry.label,
      icon: entry.icon,
      hideInTest: entry.hideInTest,
      badge: entry.path === "/srs" ? srsBadge : undefined,
    })),
  }));

  return (
    <nav className="flex flex-col gap-4 p-2" aria-label="Primary">
      {visibleSections.map((section, i) => (
        <div
          key={section.label}
          className={cn(
            "flex flex-col gap-1",
            // R9 (docs/19 F4): with section labels hidden in the collapsed rail,
            // a hairline divider keeps the groups legible as groups.
            collapsed && i > 0 && "border-t border-border/60 pt-3",
          )}
        >
          {!collapsed && (
            <div className="type-overline px-3 pb-0.5 pt-1 text-muted-foreground/70">
              {section.label}
            </div>
          )}
          {section.items.map((item) => (
            <NavRow key={item.to} item={item} collapsed={collapsed} />
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * Rail collapse state with two inputs and a clear precedence (docs/19 F4 + F6):
 *   - the user's *pin* (explicit toggle), persisted across launches, and
 *   - the viewport being narrow (< ~1100px), observed via matchMedia.
 * Effective rule: narrow viewports force-collapse; on wide viewports the user's
 * pin wins. A manual toggle while wide updates and persists the pin. Crossing
 * the breakpoint re-derives the effective state, so dragging the window narrow
 * tucks the rail away and widening it restores the user's choice.
 */
function useRailCollapsed(): [boolean, () => void] {
  const pinnedRef = useRef<boolean>(getRaw(SIDEBAR_COLLAPSED_KEY) === "1");
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(NARROW_QUERY).matches,
  );
  const [collapsed, setCollapsed] = useState(
    () => pinnedRef.current || narrow,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setNarrow(mql.matches);
      // Re-derive: narrow forces collapse; wide restores the user's pin.
      setCollapsed(mql.matches || pinnedRef.current);
    };
    // Safari < 14 only supports addListener.
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      // A manual toggle records the user's pin (only meaningful while wide;
      // when narrow the rail stays collapsed regardless, but we still honor the
      // intent once the viewport widens again).
      pinnedRef.current = narrow ? pinnedRef.current : next;
      setRaw(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }, [narrow]);

  return [collapsed, toggle];
}

export function AppShell() {
  const [collapsed, toggleCollapsed] = useRailCollapsed();
  const { resolved, setTheme } = useTheme();
  const { mode, setMode } = useMode();
  const { data: dash } = useDashboard();
  const location = useLocation();

  // In Test Mode the shell is intentionally calm and hides streak/score.
  const testMode = mode === "test";

  return (
    // R9 (docs/19 F1.1): `data-app-root` opts the shell into Mica transparency
    // (no-op without `html.mica`); `bg-background` keeps it opaque otherwise.
    <div
      data-app-root
      className="flex h-full w-full overflow-hidden bg-background"
    >
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-primary focus-visible:px-3 focus-visible:py-2 focus-visible:text-primary-foreground"
      >
        Skip to main content
      </a>
      {/* R9 (docs/19 F1.1): `.chrome-glass` — solid by default, frosts under
          native Mica; replaces the old opaque `bg-card`. */}
      <aside
        className={cn(
          "chrome-glass hidden flex-col border-r transition-all duration-200 sm:flex",
          collapsed ? "w-16" : "w-60",
          testMode && "opacity-95",
        )}
        aria-label="Sidebar"
      >
        {/* Brand lockup */}
        <div
          className={cn(
            "flex h-14 items-center gap-2 border-b px-4",
            collapsed && "justify-center px-2",
          )}
        >
          <Logo className="h-6 w-6" />
          {!collapsed && (
            <span className="text-lg font-bold tracking-tight">LSAT Lab</span>
          )}
        </div>
        {/* Command-palette affordance — surfaces the ⌘K palette. */}
        <div className={cn("px-2 pt-2", collapsed && "px-2")}>
          <CommandAffordance collapsed={collapsed} />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          <NavRail collapsed={collapsed} />
        </div>
        {/* Footer: collapse toggle + brand/version lockup. */}
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start active:scale-[0.98] motion-reduce:active:scale-100"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            <Icon as={collapsed ? PanelLeftOpen : PanelLeftClose} size="sm" />
            {!collapsed && <span className="ml-2">Collapse</span>}
          </Button>
          {!collapsed && (
            <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[0.65rem] text-muted-foreground/60">
              <Logo className="h-3 w-3 opacity-70" />
              <span className="tracking-tight">LSAT Lab</span>
              <span className="type-numeric ml-auto tabular-nums">
                {APP_VERSION}
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* R9 (docs/19 F5): the top header sheds its redundant window title (now
            centered in the titlebar) and carries only contextual controls:
            mode toggle (left) + streak + theme/mode menu (right). `.chrome-glass`
            unifies it with the titlebar under Mica. */}
        <header className="chrome-glass flex h-14 items-center justify-between border-b px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <ModeToggle mode={mode} onChange={setMode} />
            {/* R9 (docs/19 F5): router-driven breadcrumb wakes the dormant
                primitive and gives the (otherwise empty) header "where am I"
                context with a clickable trail. Renders nothing on the root. */}
            <RouteBreadcrumb className="hidden min-w-0 truncate md:block" />
          </div>
          <div className="flex items-center gap-4">
            {!testMode && dash && (
              <div
                className="hidden items-center gap-1.5 text-sm font-medium text-warning sm:flex"
                aria-label={`${dash.data.streak_days} day streak`}
              >
                <Icon as={Flame} size="sm" />
                <span>{dash.data.streak_days}-day streak</span>
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="App menu"
                  className="active:scale-95 motion-reduce:active:scale-100"
                >
                  <Icon as={resolved === "dark" ? Sun : Moon} size="md" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
                >
                  {resolved === "dark" ? "Light theme" : "Dark theme"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  System theme
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setMode(mode === "test" ? "study" : "test")}>
                  Switch to {mode === "test" ? "Study" : "Test"} Mode
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <MainScrollArea pathname={location.pathname}>
          <Outlet />
        </MainScrollArea>
      </div>
    </div>
  );
}

function MainScrollArea({
  pathname,
  children,
}: {
  pathname: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const prevPath = useRef(pathname);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prevPath.current !== pathname) {
      saveScroll(prevPath.current, el.scrollTop);
      prevPath.current = pathname;
      requestAnimationFrame(() => {
        el.scrollTop = restoreScroll(pathname);
      });
    }
  }, [pathname]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => saveScroll(pathname, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pathname]);

  return (
    <main
      ref={ref}
      id="main-content"
      className="scroll-thin flex-1 overflow-y-auto p-3 sm:p-6"
      tabIndex={-1}
    >
      {children}
    </main>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "study" | "test";
  onChange: (m: "study" | "test") => void;
}) {
  // A single-select ToggleGroup gives correct radio semantics + roving arrow-key
  // focus for free (vs. the old role="group" + aria-pressed buttons). The
  // segmented visual is preserved via the item `data-[state=on]` classes; the
  // `v &&` guard keeps clicking the active segment from clearing the mode.
  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(v) => v && onChange(v as "study" | "test")}
      aria-label="App mode"
      className="inline-flex gap-0 rounded-md border bg-muted p-0.5 text-xs font-medium"
    >
      {(["study", "test"] as const).map((m) => (
        <ToggleGroupItem
          key={m}
          value={m}
          className={cn(
            "h-auto rounded px-3 py-1 text-xs font-medium",
            "text-muted-foreground hover:bg-transparent hover:text-foreground",
            "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-e1",
          )}
        >
          {m === "study" ? "Study Mode" : "Test Mode"}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
