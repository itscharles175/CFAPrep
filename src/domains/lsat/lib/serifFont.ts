/**
 * F22 — Lazy-load the Newsreader variable font only when serif reading mode is
 * enabled. The font is ~35 KB (woff2) and only relevant for a subset of users;
 * keeping it off the critical path saves an unconditional round-trip for the
 * majority who use the default sans-serif mode.
 *
 * Call `ensureSerifFont()` whenever `reading.serif` becomes true. It's a no-op
 * after the first call so it's safe to call in a render-phase effect.
 */

let serifLoaded = false;

export function ensureSerifFont(): void {
  if (serifLoaded) return;
  serifLoaded = true;
  // Vite handles the dynamic CSS import by injecting a <link> into <head>.
  void import("@fontsource-variable/newsreader/index.css");
}
