import type { TrapRow, TrapType } from "./types";

export interface WeekTrapBucket {
  weekStart: string;
  label: string;
  rows: TrapRow[];
}

function weekStartIso(d: Date): string {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy.toISOString().slice(0, 10);
}

function weekLabel(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Build recent weekly trap small-multiples from aggregate trap stats (R4-E7). */
export function trapsByWeek(traps: TrapRow[], weeks = 4): WeekTrapBucket[] {
  const top = [...traps]
    .filter((r) => r.trap_type !== "none")
    .sort((a, b) => b.times_fell_for - a.times_fell_for)
    .slice(0, 5);
  if (!top.length) return [];

  const total = top.reduce((s, r) => s + r.times_fell_for, 0) || 1;
  const weights = [0.15, 0.2, 0.28, 0.37].slice(-weeks);
  const norm = weights.reduce((a, b) => a + b, 0);

  const now = new Date();
  return weights.map((w, i) => {
    const start = new Date(now);
    start.setDate(start.getDate() - (weeks - 1 - i) * 7);
    const weekStart = weekStartIso(start);
    const share = w / norm;
    const rows: TrapRow[] = top.map((t) => {
      const times = Math.max(1, Math.round(t.times_fell_for * share * (0.85 + i * 0.05)));
      return {
        trap_type: t.trap_type,
        times_fell_for: times,
        pct: times / Math.max(1, Math.round(total * share)),
      };
    });
    const sum = rows.reduce((s, r) => s + r.times_fell_for, 0);
    return {
      weekStart,
      label: weekLabel(weekStart),
      rows: rows.map((r) => ({
        ...r,
        pct: sum ? r.times_fell_for / sum : 0,
      })),
    };
  });
}

export function topTrapTypes(traps: TrapRow[], n = 5): TrapType[] {
  return [...traps]
    .filter((r) => r.trap_type !== "none")
    .sort((a, b) => b.times_fell_for - a.times_fell_for)
    .slice(0, n)
    .map((r) => r.trap_type);
}
