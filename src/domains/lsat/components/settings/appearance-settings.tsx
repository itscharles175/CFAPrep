import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Label } from "@lsat/components/ui/label";
import { Switch } from "@lsat/components/ui/switch";
import { Icon } from "@lsat/components/ui/icon";
import { useTheme } from "@lsat/components/theme-provider";
import { cn } from "@lsat/lib/utils";
import { type Density } from "@lsat/lib/prefs";

type ThemeChoice = "light" | "dark" | "system";

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/**
 * R9 (docs/19 F4.3) — the appearance picker as a *visual* theme gallery. Each
 * theme is a clickable swatch card whose preview is a miniature live render of
 * that environment: surface ladder + a primary accent + text, drawn inside a
 * scoped `light` / `dark` (+ optional `high-contrast`) wrapper so the tokens it
 * shows are the real ones the app would apply. Theme + contrast + density are
 * unified into one surface. Wiring is unchanged (useTheme); selection is a
 * radio group for AA keyboard semantics.
 */

/**
 * The token sets each preview renders in. Sampled from index.css so the swatch
 * shows the real environment regardless of the *current* app theme (a `.light`
 * class wouldn't redefine tokens — light lives on :root — so we set the CSS vars
 * inline instead). Keep these in sync with index.css if the palette shifts.
 */
type Env = "light" | "dark" | "light-hc" | "dark-hc";

const ENV_TOKENS: Record<Env, Record<string, string>> = {
  light: {
    surface0: "228 24% 98%",
    surface1: "0 0% 100%",
    surface2: "226 22% 96%",
    foreground: "229 26% 11%",
    muted: "222 11% 49%",
    primary: "262 83% 60%",
    primaryFg: "0 0% 100%",
    border: "224 18% 91%",
  },
  dark: {
    surface0: "231 30% 7%",
    surface1: "229 26% 11%",
    surface2: "227 22% 17%",
    foreground: "226 22% 96%",
    muted: "222 12% 64%",
    primary: "258 92% 70%",
    primaryFg: "231 30% 7%",
    border: "227 22% 17%",
  },
  "light-hc": {
    surface0: "0 0% 100%",
    surface1: "0 0% 100%",
    surface2: "0 0% 96%",
    foreground: "0 0% 0%",
    muted: "0 0% 25%",
    primary: "262 100% 35%",
    primaryFg: "0 0% 100%",
    border: "0 0% 0%",
  },
  "dark-hc": {
    surface0: "0 0% 0%",
    surface1: "0 0% 8%",
    surface2: "0 0% 14%",
    foreground: "0 0% 100%",
    muted: "0 0% 80%",
    primary: "258 100% 82%",
    primaryFg: "0 0% 0%",
    border: "0 0% 100%",
  },
};

/** A miniature, real-token preview of an environment (mock window chrome). */
function ThemePreview({
  scope,
  highContrast,
}: {
  /** Which base environment to render the preview in. */
  scope: "light" | "dark";
  highContrast: boolean;
}) {
  const env: Env = highContrast ? (`${scope}-hc` as Env) : scope;
  const t = ENV_TOKENS[env];
  const h = (v: string) => `hsl(${v})`;

  return (
    <div
      aria-hidden
      className="pointer-events-none overflow-hidden rounded-md border"
      style={{ background: h(t.surface0), borderColor: h(t.border) }}
    >
      {/* mock title bar */}
      <div
        className="flex items-center gap-1 px-2 py-1.5"
        style={{ background: h(t.surface2) }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-destructive/70" />
        <span className="h-1.5 w-1.5 rounded-full bg-warning/70" />
        <span className="h-1.5 w-1.5 rounded-full bg-success/70" />
      </div>
      {/* mock content: a hero numeral chip + text lines */}
      <div className="space-y-1.5 p-2.5">
        <div className="flex items-center gap-1.5">
          <span
            className="grid h-4 w-4 place-items-center rounded-[3px] text-[8px] font-bold"
            style={{ background: h(t.primary), color: h(t.primaryFg) }}
          >
            A
          </span>
          <span
            className="h-1.5 w-10 rounded-full"
            style={{ background: h(t.foreground) }}
          />
        </div>
        <span
          className="block h-1.5 w-full rounded-full"
          style={{ background: `hsl(${t.muted} / 0.5)` }}
        />
        <span
          className="block h-1.5 w-2/3 rounded-full"
          style={{ background: `hsl(${t.muted} / 0.5)` }}
        />
        <span
          className="mt-1 block h-3 w-full rounded-[3px] border"
          style={{ background: h(t.surface1), borderColor: h(t.border) }}
        />
      </div>
    </div>
  );
}

export function AppearanceSettings({
  kiosk,
  onKioskChange,
}: {
  kiosk: boolean;
  onKioskChange: (v: boolean) => void;
}) {
  const { theme, setTheme, resolved, density, setDensity, highContrast, setHighContrast } =
    useTheme();

  // Which base environment each swatch should preview in. "system" follows the
  // currently-resolved base so the preview is honest about what you'd get now.
  const previewScope = (value: ThemeChoice): "light" | "dark" =>
    value === "system" ? resolved : value;

  return (
    <div className="space-y-6">
      {/* Theme gallery */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Theme</legend>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-3"
        >
          {THEMES.map(({ value, label, icon }) => {
            const selected = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(value)}
                className={cn(
                  "group relative space-y-2 rounded-card border bg-card p-2 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  selected
                    ? "border-primary ring-2 ring-primary"
                    : "hover:border-foreground/30",
                )}
              >
                <ThemePreview scope={previewScope(value)} highContrast={highContrast} />
                <span className="flex items-center justify-between px-0.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon as={icon} size="xs" className="text-muted-foreground" />
                    {label}
                  </span>
                  {selected && (
                    <span className="grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Use the header menu for quick theme toggles while studying.
        </p>
      </fieldset>

      {/* Density — segmented, with the same selectable language */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Density</legend>
        <div
          role="radiogroup"
          aria-label="Density"
          className="inline-flex rounded-card border p-0.5"
        >
          {(
            [
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ] as { value: Density; label: string }[]
          ).map(({ value, label }) => {
            const selected = density === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDensity(value)}
                className={cn(
                  "rounded-[5px] px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Compact tightens spacing and row heights on data-dense screens.
        </p>
      </fieldset>

      {/* High contrast + kiosk — paired toggles */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="high-contrast">High contrast</Label>
            <p className="text-xs text-muted-foreground">
              Stronger borders and foreground contrast; flattens the aurora glow.
            </p>
          </div>
          <Switch
            id="high-contrast"
            aria-label="Toggle high contrast"
            checked={highContrast}
            onCheckedChange={(v) => setHighContrast(v)}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="exam-kiosk">Fullscreen exams (kiosk)</Label>
            <p className="text-xs text-muted-foreground">
              Enter OS fullscreen when a timed exam starts (desktop app only).
            </p>
          </div>
          <Switch
            id="exam-kiosk"
            aria-label="Toggle fullscreen exams"
            checked={kiosk}
            onCheckedChange={onKioskChange}
          />
        </div>
      </div>
    </div>
  );
}
