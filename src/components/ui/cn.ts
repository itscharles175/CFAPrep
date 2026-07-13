/**
 * K4-2 — class-name joiner for the host-styled primitive barrel.
 *
 * The host design system is plain CSS (the `.btn` / `.qv-*` / `.surface`
 * vocabulary in `src/index.css`), NOT Tailwind utilities — the host Tailwind
 * config only scans `src/domains/lsat/**`, so utility classes written in this
 * directory would never be generated. These wrappers therefore compose host CSS
 * class names, and this `cn` just filters falsy values and joins (clsx-style)
 * with no `tailwind-merge` conflict resolution (which is meaningless for the
 * host's semantic class names).
 *
 * It deliberately mirrors the SIGNATURE of `@lsat/lib/utils`'s `cn` (rest of
 * `ClassValue`-ish args) so call sites read identically to the LSAT primitives,
 * easing the eventual reskin swap.
 */
export type ClassInput =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, boolean | null | undefined>
  | ClassInput[];

function collect(input: ClassInput, out: string[]): void {
  if (!input && input !== 0) return;
  if (typeof input === "string" || typeof input === "number") {
    const s = String(input).trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collect(item, out);
    return;
  }
  if (typeof input === "object") {
    for (const key of Object.keys(input)) {
      if (input[key]) out.push(key);
    }
  }
}

export function cn(...inputs: ClassInput[]): string {
  const out: string[] = [];
  for (const input of inputs) collect(input, out);
  return out.join(" ");
}
