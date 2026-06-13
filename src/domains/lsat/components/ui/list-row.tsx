import { cn } from "@/lib/utils";

/**
 * R9 (docs/19 F4 / secondary surfaces) — one shared dense data-row for the
 * queues that each hand-rolled their own layout (SessionHistory, Playlists,
 * BucketQueue, SRS inline): leading slot (icon/badge) · title + meta · trailing
 * actions. Min-height is driven by the `--row-h` density token so "compact"
 * actually retunes row height. Renders as a button when `onClick` is given.
 */
export function ListRow({
  leading,
  title,
  meta,
  trailing,
  onClick,
  interactive,
  className,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  /** Show hover/press affordance even without onClick (e.g. wraps a Link). */
  interactive?: boolean;
  className?: string;
}) {
  const isInteractive = interactive ?? Boolean(onClick);
  const base = cn(
    "flex w-full items-center gap-3 rounded-card border bg-card px-4 text-left",
    "min-h-[calc(var(--row-h)*1.6)] py-2",
    isInteractive &&
      "transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    className,
  );

  const body = (
    <>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block truncate font-medium leading-snug">{title}</span>
        {meta && (
          <span className="block truncate text-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </span>
      {trailing && (
        <span className="flex shrink-0 items-center gap-2">{trailing}</span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={base}>
        {body}
      </button>
    );
  }
  return <div className={base}>{body}</div>;
}
