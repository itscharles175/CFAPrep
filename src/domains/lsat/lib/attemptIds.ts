/**
 * 5.2 — stable client-generated idempotency tokens for attempts.
 *
 * Each attempt a section submits carries a `client_attempt_id`. The backend has
 * a unique-when-present index on it, so replaying the same write (an offline
 * retry, or a finish-section double-fire) collapses to a single row instead of
 * inserting a duplicate. For that to work the SAME id must be reused across
 * replays — a fresh `crypto.randomUUID()` per submit would defeat the purpose.
 *
 * We persist a `questionId → uuid` map per draft scope (the same stable scope
 * the crash-safe draft uses, e.g. `section:42` / `exam:42`). `attemptIdFor`
 * mints an id the first time a question is seen and returns the existing one
 * thereafter — so the in-progress draft, the initial batch POST, and any later
 * queue replay all agree on the id.
 *
 * Lifecycle: ids live until the section is submitted and its draft cleared
 * (`clearAttemptIds`). The enqueued batch payload independently carries the ids,
 * so a replay after the map is gone still uses the persisted-in-queue id.
 */

const PREFIX = "lsatlab.attemptIds.";

function storageKey(scope: string): string {
  return `${PREFIX}${scope}`;
}

function read(scope: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function write(scope: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(map));
  } catch {
    /* best-effort — quota / private mode */
  }
}

/** Generate a UUID, with a fallback for environments lacking `crypto`. */
function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // RFC4122-ish fallback (sufficient as an idempotency token, not a security id).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Return the stable `client_attempt_id` for `(scope, questionId)`, minting and
 * persisting a new one on first call.
 */
export function attemptIdFor(scope: string | null | undefined, questionId: number): string {
  if (!scope) return uuid(); // no durable scope (ad-hoc run) — still idempotent within the call
  const map = read(scope);
  const key = String(questionId);
  const existing = map[key];
  if (existing) return existing;
  const id = uuid();
  map[key] = id;
  write(scope, map);
  return id;
}

/** Drop the id map for a scope once its section has been submitted. */
export function clearAttemptIds(scope: string | null | undefined): void {
  if (!scope) return;
  try {
    localStorage.removeItem(storageKey(scope));
  } catch {
    /* ignore */
  }
}
