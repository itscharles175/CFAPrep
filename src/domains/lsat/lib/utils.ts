import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format milliseconds as m:ss. */
export function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format seconds as mm:ss for the countdown timer. */
export function formatClock(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** R11 1.3 — pluralize a noun by count (the inline `${n===1?"":"s"}` pattern
 *  is used ~25 places; this is the shared form so the misses converge).
 *  `pluralize(1,"question")` → "question"; `pluralize(3,"question")` → "questions";
 *  pass an irregular plural as the 3rd arg. `countLabel` prefixes the number. */
export function pluralize(n: number, noun: string, plural?: string): string {
  return n === 1 ? noun : (plural ?? `${noun}s`);
}
export function countLabel(n: number, noun: string, plural?: string): string {
  return `${n} ${pluralize(n, noun, plural)}`;
}

/** R10 C4 — one prose duration formatter (vs the ad-hoc `134s`/`1.2s`/`12m`
 *  idioms). `48s` · `2m 14s` · `1h 5m`. Use formatClock/formatMs for clock form. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** R10 C4 — localized short date ("May 21", "May 21, 2025" if not this year)
 *  vs the bare ISO `slice(0,10)`. Pair with `timeAgo` for relative labels. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Compact relative time, e.g. "just now", "12m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
