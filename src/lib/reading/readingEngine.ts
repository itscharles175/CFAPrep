/**
 * A11Y-1 / UI-2 — inclusive-reading + density DOM controller.
 *
 * Translates a `ReadingPrefs` value (see readingPrefs.ts) into document state:
 *
 *   - `[data-density]`        on <html>  → density token deltas (UI-2, tokens.css)
 *   - `[data-reading-font]`   on <html>  → dyslexia-friendly font stack (index.css)
 *   - `[data-text-spacing]`   on <html>  → WCAG 1.4.12 spacing tokens (index.css)
 *   - `[data-bionic]`         on <html>  → bionic emphasis styling hook (index.css)
 *   - `[data-line-focus]`     on <html>  → enables the pointer-tracking ruler
 *
 * Everything is attribute/CSS-variable driven so a single class of CSS rules in
 * index.css does the visual work and React never has to re-render the page for a
 * preference change. The ONE piece that needs JS is the line-focus ruler (it
 * follows the pointer) and the bionic text pass (it rewrites text nodes), both
 * scoped, idempotent, and fully reversible.
 *
 * Strict-offline + degrades gracefully: every entry point guards `document`, so
 * importing this in SSR/tests is safe and applying with no DOM is a no-op.
 */

import { toBionicRuns } from './bionic';
import type { ReadingPrefs } from './readingPrefs';
import { DEFAULT_READING_PREFS } from './readingPrefs';

const ROOT_ATTRS = {
  density: 'data-density',
  font: 'data-reading-font',
  spacing: 'data-text-spacing',
  bionic: 'data-bionic',
  lineFocus: 'data-line-focus',
} as const;

/** Marks a node already processed by the bionic pass so we don't double-wrap. */
const BIONIC_MARK = 'data-qv-bionic';
/** The ruler element id (singleton). */
const RULER_ID = 'qv-line-focus-ruler';

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/** Apply (or clear) every <html> attribute from a prefs value. Idempotent. */
export function applyReadingPrefs(prefs: ReadingPrefs): void {
  const el = root();
  if (!el) return;

  // Density: comfortable is the default token set, so only the compact axis is
  // stamped — keeping the attribute absent in the default case so existing CSS
  // (and the prefers-reduced-motion media query) is undisturbed.
  if (prefs.density === 'compact') el.setAttribute(ROOT_ATTRS.density, 'compact');
  else el.removeAttribute(ROOT_ATTRS.density);

  toggleAttr(el, ROOT_ATTRS.font, prefs.dyslexiaFont, 'dyslexic');
  toggleAttr(el, ROOT_ATTRS.spacing, prefs.textSpacing, 'on');
  toggleAttr(el, ROOT_ATTRS.bionic, prefs.bionicReading, 'on');
  toggleAttr(el, ROOT_ATTRS.lineFocus, prefs.lineFocus, 'on');

  // The two JS-driven features are wired/torn-down to match the attribute state.
  if (prefs.lineFocus) enableLineFocus();
  else disableLineFocus();
}

function toggleAttr(el: HTMLElement, attr: string, on: boolean, value: string): void {
  if (on) el.setAttribute(attr, value);
  else el.removeAttribute(attr);
}

/** Reset the document to the neutral (no-op) reading state. */
export function clearReadingPrefs(): void {
  applyReadingPrefs(DEFAULT_READING_PREFS);
}

/* ─────────────────────────────────────────────────────────────
 * Line-focus ruler (A11Y-1) — a thin horizontal band that follows the pointer
 * to anchor the current reading line. Pure overlay (pointer-events:none) so it
 * never intercepts clicks. Honours reduced-motion implicitly (no transition).
 * ───────────────────────────────────────────────────────────── */

let rulerEl: HTMLElement | null = null;
let onPointerMove: ((event: PointerEvent) => void) | null = null;

function enableLineFocus(): void {
  if (typeof document === 'undefined' || onPointerMove) return; // already on
  const ruler = document.getElementById(RULER_ID) ?? document.createElement('div');
  ruler.id = RULER_ID;
  ruler.setAttribute('aria-hidden', 'true');
  if (!ruler.isConnected) document.body?.appendChild(ruler);
  rulerEl = ruler;

  onPointerMove = (event: PointerEvent) => {
    if (!rulerEl) return;
    // Position the band centred on the pointer's Y; X-span is full-width via CSS.
    rulerEl.style.setProperty('--qv-ruler-y', `${event.clientY}px`);
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });
}

function disableLineFocus(): void {
  if (onPointerMove) {
    window.removeEventListener('pointermove', onPointerMove);
    onPointerMove = null;
  }
  if (rulerEl?.isConnected) rulerEl.remove();
  rulerEl = null;
}

/* ─────────────────────────────────────────────────────────────
 * Bionic-reading text pass (A11Y-1). Walks the text nodes inside a container and
 * wraps each word's fixation prefix in a <b data-qv-bionic>. Reversible via
 * `unapplyBionic`. Skips code / formula / editable / script regions so we never
 * corrupt verbatim or interactive content.
 *
 * NOTE: most of the bionic *appearance* is CSS-only via [data-bionic] (it can
 * style existing <strong>/<b>). This DOM pass is the OPTIONAL deeper mode for
 * long-form prose containers that opt in by calling `applyBionic(node)` — it is
 * NOT run globally, so the default cost is zero.
 * ───────────────────────────────────────────────────────────── */

const SKIP_TAGS = new Set([
  'CODE', 'PRE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT',
  // KaTeX output + math should never be re-tokenised.
  'MATH', 'ANNOTATION',
]);

function shouldSkip(node: Node): boolean {
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.classList.contains('katex')) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Apply the bionic transform to every eligible text node under `container`.
 * Idempotent — already-processed regions (marked nodes) are skipped. Builds
 * elements with `document.createElement` / text nodes only (never innerHTML), so
 * the source text cannot inject markup.
 */
export function applyBionic(container: HTMLElement): void {
  if (typeof document === 'undefined' || !container) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
      // Skip text already produced by a previous pass — both the bold fixation
      // (inside a marked <b>) and its plain tail (inside the marked word wrapper).
      const parent = node.parentElement as HTMLElement | null;
      if (parent?.hasAttribute(BIONIC_MARK) || parent?.closest(`[${BIONIC_MARK}]`)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    targets.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of targets) {
    const runs = toBionicRuns(textNode.textContent ?? '');
    if (runs.length === 0) continue;
    const frag = document.createDocumentFragment();
    for (const run of runs) {
      if (run.bold) {
        // Each fixation lives in a <b data-qv-bionic>; the marker also fences the
        // run from re-processing on a repeat pass (idempotency).
        const b = document.createElement('b');
        b.setAttribute(BIONIC_MARK, '');
        b.textContent = run.text;
        frag.appendChild(b);
      } else {
        // Wrap the plain tail in a marked span too, so a second pass treats the
        // whole word region as already-processed (the tail's parent now matches
        // the BIONIC_MARK guard above) instead of re-splitting it.
        const tail = document.createElement('span');
        tail.setAttribute(BIONIC_MARK, '');
        tail.textContent = run.text;
        frag.appendChild(tail);
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

/**
 * Reverse `applyBionic` on a container — unwraps every bionic node (the <b>
 * fixations AND the marked tail <span>s) back into plain text in place.
 */
export function unapplyBionic(container: HTMLElement): void {
  if (typeof document === 'undefined' || !container) return;
  const wrapped = container.querySelectorAll<HTMLElement>(`[${BIONIC_MARK}]`);
  for (const node of Array.from(wrapped)) {
    const parent = node.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(node.textContent ?? ''), node);
  }
  container.normalize(); // re-merge the split text nodes back into one
}
