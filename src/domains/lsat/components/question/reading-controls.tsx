import { useEffect, useId, useRef, useState } from "react";
import { Minus, Plus, Type } from "lucide-react";
import { cn } from "@lsat/lib/utils";
import { Icon } from "@lsat/components/ui/icon";
import { Switch } from "@lsat/components/ui/switch";
import { Slider } from "@lsat/components/ui/slider";
import {
  READING_PRESETS,
  READING_SIZES,
  type ChoiceSize,
  type ChoiceSpacing,
  type ReadingPrefs,
  type ReadingSize,
} from "@lsat/lib/prefs";

const SIZE_LABEL: Record<ReadingSize, string> = { sm: "S", md: "M", lg: "L" };
const SIZE_PX: Record<ReadingSize, string> = { sm: "16px", md: "19px", lg: "22px" };

// A short, neutral specimen — long enough to show the measure (line width) wrap
// and the serif/size change, never any question content.
const SPECIMEN =
  "The argument concludes that the new policy will reduce delays. It assumes, without stating so, that the delays stem from the very process the policy changes.";

/**
 * R9 (docs/19 "reading controls as a premium reader panel").
 *
 * A wider, sectioned reader panel (was a cramped `w-56` stack of controls). It
 * leads with a LIVE TYPE SPECIMEN that re-renders as the user tunes size / serif
 * / measure, so the effect of each control is visible before committing — the
 * specimen mirrors the `.reading` substrate (size class + serif family + a local
 * `max-width: <measure>ch`) without touching the global `--measure` var (the
 * parent's `useReadingPrefs` owns the real apply). Stateless: the parent owns the
 * persisted ReadingPrefs.
 */
export function ReadingControls({
  prefs,
  onChange,
}: {
  prefs: ReadingPrefs;
  onChange: (patch: Partial<ReadingPrefs>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const triggerId = useId();
  const [panelTop, setPanelTop] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const updatePanelPosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel || window.innerWidth > 640) return;

      const triggerRect = trigger.getBoundingClientRect();
      const panelHeight = panel.getBoundingClientRect().height;
      const gutter = 12;
      const preferredTop = triggerRect.bottom + 6;
      const maxTop = Math.max(gutter, window.innerHeight - panelHeight - gutter);
      setPanelTop(Math.min(preferredTop, maxTop));
    };

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open]);

  const measureCh = prefs.measureCh ?? 66;

  return (
    <div ref={ref} className="relative" data-reading-controls>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        onClick={() => setOpen((o) => !o)}
        title="Reading display"
        aria-label="Reading display options"
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-sm hover:bg-accent"
      >
        <Type className="h-4 w-4" />
        <span className="font-mono">{SIZE_LABEL[prefs.size]}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-labelledby={triggerId}
          style={panelTop == null ? undefined : ({ "--reading-panel-top": `${panelTop}px` } as React.CSSProperties)}
          className="lsat-reading-popover absolute right-0 top-full z-30 mt-1.5 w-80 overflow-hidden rounded-card border bg-popover text-sm shadow-e3"
        >
          {/* Live type specimen — re-renders as the controls change. */}
          <div className="border-b bg-surface-1 p-4">
            <p className="type-overline mb-2 text-muted-foreground">Preview</p>
            <p
              className={cn(
                "leading-relaxed text-foreground",
                prefs.serif && "reading-serif",
              )}
              style={{
                fontSize: SIZE_PX[prefs.size],
                lineHeight: 1.65,
                maxWidth: `${measureCh}ch`,
              }}
            >
              {SPECIMEN}
            </p>
          </div>

          <div tabIndex={0} className="max-h-[60vh] space-y-4 overflow-y-auto p-4">
            {/* Size — stepper + segmented. */}
            <Section title="Text size">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Decrease text size"
                  onClick={() => onChange({ size: stepSize(prefs.size, -1) })}
                  disabled={prefs.size === "sm"}
                  className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                >
                  <Icon as={Minus} size="sm" />
                </button>
                <div className="flex flex-1 overflow-hidden rounded-md border">
                  {READING_SIZES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onChange({ size: s })}
                      aria-pressed={prefs.size === s}
                      className={cn(
                        "flex-1 py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        prefs.size === s
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent",
                      )}
                    >
                      {SIZE_LABEL[s]}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Increase text size"
                  onClick={() => onChange({ size: stepSize(prefs.size, 1) })}
                  disabled={prefs.size === "lg"}
                  className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
                >
                  <Icon as={Plus} size="sm" />
                </button>
              </div>
            </Section>

            {/* Typeface + paper. */}
            <Section title="Typeface">
              <ToggleRow
                label="Serif reading font"
                checked={prefs.serif}
                onChange={(v) => onChange({ serif: v })}
              />
              <ToggleRow
                label="Warm focus paper"
                checked={prefs.focusTheme}
                onChange={(v) => onChange({ focusTheme: v })}
              />
            </Section>

            {/* Measure (line width). */}
            <Section title="Line width" aside={<span className="type-numeric">{measureCh}ch</span>}>
              <Slider
                value={[measureCh]}
                min={58}
                max={75}
                step={1}
                onValueChange={([v]) => onChange({ measureCh: v })}
                aria-label="Reading line width"
                className="py-1"
              />
            </Section>

            {/* Choice layout. */}
            <Section title="Answer choices">
              <div className="space-y-2">
                <SegmentedRow
                  label="Letter size"
                  options={["sm", "md", "lg"] as ChoiceSize[]}
                  value={prefs.choiceSize}
                  format={(s) => s.toUpperCase()}
                  onChange={(s) => onChange({ choiceSize: s })}
                />
                <SegmentedRow
                  label="Spacing"
                  options={["tight", "normal", "relaxed"] as ChoiceSpacing[]}
                  value={prefs.choiceSpacing}
                  format={(s) => s}
                  onChange={(s) => onChange({ choiceSpacing: s })}
                />
              </div>
            </Section>

            {/* Presets. */}
            <Section title="Presets">
              <div className="flex flex-wrap gap-1.5">
                {READING_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onChange(p.prefs)}
                    className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

function stepSize(size: ReadingSize, dir: 1 | -1): ReadingSize {
  const i = READING_SIZES.indexOf(size);
  return READING_SIZES[Math.max(0, Math.min(READING_SIZES.length - 1, i + dir))];
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="type-overline text-muted-foreground">{title}</div>
        {aside && <div className="text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </div>
  );
}

function SegmentedRow<T extends string>({
  label,
  options,
  value,
  format,
  onChange,
}: {
  label: string;
  options: T[];
  value: T;
  format: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex overflow-hidden rounded-md border">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            aria-pressed={value === o}
            className={cn(
              "px-2.5 py-1 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              value === o ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {format(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between">
      <span>{label}</span>
      {/* R11 4.4 — the shared Switch primitive (token focus ring + e1 thumb),
          replacing the hand-rolled toggle that diverged from it. */}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
