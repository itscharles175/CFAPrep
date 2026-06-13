import { useEffect, useRef, useState } from "react";

/**
 * Visually-hidden ARIA live regions for the timed/blind-review loop (5.6).
 *
 * Screen readers announce text that *changes* inside a live region. We keep the
 * regions in the DOM permanently (mounting a region together with its text can
 * be missed by some readers) and only swap their text content.
 *
 * Politeness:
 *  - polite     → queued, non-interrupting (question changes, pace status)
 *  - assertive  → interrupts (timer thresholds, reveal outcome)
 */

/** A persistent `.sr-only` live region that announces whatever `message` is. */
export function LiveRegion({
  message,
  assertive = false,
  role,
}: {
  message: string;
  assertive?: boolean;
  /** Optional ARIA role, e.g. "timer" or "status". */
  role?: string;
}) {
  return (
    <div
      className="sr-only"
      role={role}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {message}
    </div>
  );
}

/**
 * Announce `message` whenever the caller sets it, INCLUDING when it is the same
 * text as last time (e.g. re-crossing the same pacing threshold). Returns the
 * string to render inside a {@link LiveRegion}. Used to throttle the timer so it
 * does not speak every second — callers pass a message only at the chosen
 * thresholds.
 *
 * Screen readers only announce text that *changes* in the DOM, so re-setting the
 * identical string would be silently dropped. We therefore append an invisible,
 * incrementing zero-width-space marker that flips the rendered text each time the
 * caller sets a message — the reader hears the same words again, but a sighted
 * user sees nothing. Rapid duplicate *renders* (the same `message` value on
 * consecutive renders) don't re-fire the effect (primitive dep), so this never
 * spams: it re-announces only when the caller actually sets the message again.
 */
// Zero-width space (U+200B): invisible to a sighted user, but appending a
// varying number of these flips the node's textContent so a screen reader
// re-announces even when the words are identical. Built from a char code so the
// source carries no invisible characters.
const ZWSP = String.fromCharCode(0x200b);

export function useThrottledAnnouncement(message: string | null): string {
  const [text, setText] = useState("");
  // Cycles 0..2 trailing zero-width spaces so the rendered text differs from the
  // previous announcement (forcing a re-read) while staying visually unchanged.
  const nonce = useRef(0);
  useEffect(() => {
    if (message == null) return;
    nonce.current = (nonce.current + 1) % 3;
    setText(message + ZWSP.repeat(nonce.current));
  }, [message]);
  return text;
}
