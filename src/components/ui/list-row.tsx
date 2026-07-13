/**
 * K4-4 — host-styled `ListRow` at the LSAT primitive's module name + prop
 * surface.
 *
 * Drop-in for `@lsat/components/ui/list-row`: the SAME named export `ListRow`
 * and the SAME prop surface — `leading` · `title` · `meta` · `trailing` ·
 * `onClick` · `interactive` · `className` — and the same behaviour: it renders
 * a real `<button>` when `onClick` is given (so it is keyboard-operable), and a
 * static `<div>` otherwise, with `interactive` forcing the hover/focus
 * affordance (e.g. when it wraps a Link). Only the emitted class names move to
 * the HOST `.qv-list-row*` vocabulary (`src/index.css`), built on the host
 * `--bg-card` / `--bg-hover` / `--ring` / `--row-h` density tokens, instead of
 * the LSAT Tailwind utilities.
 *
 * NET-NEW: nothing imports this yet — it is the target vocabulary a later
 * reskin swaps in over the LSAT list-row.
 */
import * as React from "react";
import { cn } from "./cn";

export interface ListRowProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  /** Show hover/press affordance even without onClick (e.g. wraps a Link). */
  interactive?: boolean;
  className?: string;
}

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  onClick,
  interactive,
  className,
}: ListRowProps) {
  const isInteractive = interactive ?? Boolean(onClick);
  const base = cn(
    "qv-list-row",
    isInteractive && "qv-list-row-interactive",
    className,
  );

  const body = (
    <>
      {leading && <span className="qv-list-row-leading">{leading}</span>}
      <span className="qv-list-row-main">
        <span className="qv-list-row-title">{title}</span>
        {meta && <span className="qv-list-row-meta">{meta}</span>}
      </span>
      {trailing && <span className="qv-list-row-trailing">{trailing}</span>}
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

export default ListRow;
