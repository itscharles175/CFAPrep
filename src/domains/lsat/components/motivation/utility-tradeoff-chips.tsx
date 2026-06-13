interface UtilityTradeoffChipsProps {
  priority?: string | null;
  tradeoffs?: string[];
  title?: string | null;
}

export function UtilityTradeoffChips({
  priority,
  tradeoffs = [],
  title,
}: UtilityTradeoffChipsProps) {
  if (!priority && tradeoffs.length === 0) return null;

  return (
    <>
      {priority && (
        <span
          className="inline-flex max-w-full items-center rounded border border-primary/40 bg-primary/5 px-1.5 py-0.5 text-[11px] leading-none text-primary"
          title={title ?? undefined}
        >
          {priority}
        </span>
      )}
      {tradeoffs.map((tradeoff) => (
        <span
          key={tradeoff}
          className="inline-flex max-w-full items-center rounded border border-border/70 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground"
          title={title ?? undefined}
        >
          {tradeoff}
        </span>
      ))}
    </>
  );
}
