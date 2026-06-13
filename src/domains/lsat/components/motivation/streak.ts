// Streak + weekly-goal computations from activity days (§5.1, §5.4).
// Pure functions so they can be unit-reasoned and reused across cards.
import type { ActivityDay } from "@/lib/types";

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A day "counts" toward a streak if any work happened (questions or minutes). */
function active(day: ActivityDay | undefined): boolean {
  return !!day && (day.questions > 0 || day.minutes > 0);
}

export interface StreakInfo {
  current: number;
  longest: number;
  /** Whether today specifically has activity (drives the "studied today" copy). */
  todayActive: boolean;
}

/**
 * Current streak counts consecutive active days ending today (or, if today is
 * not yet active, ending yesterday — so the streak isn't "broken" before the
 * day is over). Longest scans the whole window.
 */
export function computeStreak(days: ActivityDay[]): StreakInfo {
  const map = new Map(days.map((d) => [d.date, d]));
  const today = new Date();
  const todayActive = active(map.get(dayKey(today)));

  // Walk backwards from the reference day counting active days.
  let current = 0;
  const cursor = new Date(today);
  if (!todayActive) cursor.setDate(cursor.getDate() - 1); // grace for the in-progress day
  for (;;) {
    if (!active(map.get(dayKey(cursor)))) break;
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // Longest run across the sorted window.
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of sorted) {
    if (!active(d)) {
      run = 0;
      prev = new Date(`${d.date}T00:00:00`);
      continue;
    }
    const cur = new Date(`${d.date}T00:00:00`);
    if (prev && Math.round((cur.getTime() - prev.getTime()) / 86_400_000) === 1) {
      run++;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = cur;
  }

  return { current, longest: Math.max(longest, current), todayActive };
}

/** Number of distinct active days in the current calendar week (Sun–today). */
export function daysStudiedThisWeek(days: ActivityDay[]): number {
  const map = new Map(days.map((d) => [d.date, d]));
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay()); // back to Sunday
  let n = 0;
  const cur = new Date(start);
  while (cur <= today) {
    if (active(map.get(dayKey(cur)))) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}
