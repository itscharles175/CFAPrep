// Restrained personal-best confetti (§5.3). SKIPPED entirely under
// prefers-reduced-motion (callers should also guard, but we double-check here).
// R10 A1.3 — canvas-confetti is dynamically imported so it stays out of the
// eager bundle (it only fires on a genuine personal best).

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** A single, tasteful burst — only fires when motion is allowed. */
export function celebratePersonalBest(): void {
  if (prefersReducedMotion()) return;
  const colors = ["#7c3aed", "#009E73", "#56B4E9"]; // verdict + a couple of data hues
  void import("canvas-confetti").then(({ default: confetti }) => {
    confetti({
      particleCount: 90,
      spread: 70,
      startVelocity: 38,
      origin: { y: 0.35 },
      colors,
      disableForReducedMotion: true,
      scalar: 0.9,
    });
  });
}
