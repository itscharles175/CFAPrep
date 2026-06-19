/*
 * UX-4 — cross-domain navigation history store.
 *
 * StudyVault is two routers in one window: the CFA/Quant/Excel host
 * (`react-router` at `/`) and the vendored LSAT domain (`react-router` under
 * `basename="/lsat"`). Neither router can see the other's history — the host's
 * `useNavigate(-1)` can't hop back into `/lsat`, and vice versa — so a single
 * "Back" affordance in the shared shell needs a history record that BOTH planes
 * can write to and read from.
 *
 * This module is that record. It is intentionally framework-agnostic (no React
 * imports beyond the optional hook below) so it can be driven from the host's
 * `domainNav.navigateDomain`, the host App's route effect, and the LSAT shell's
 * router context alike.
 *
 * Entries are serialized as {path, domain, label} tuples — NOT raw URLs — so a
 * consumer (the breadcrumb, the back button's aria-label) can render a friendly
 * destination name without re-deriving it, and so the domain is explicit rather
 * than re-parsed from the path on every read.
 *
 * Persistence is sessionStorage (per-tab, cleared on tab close) so a full
 * reload mid-session keeps the trail, plus a `study-vault:nav-history` window
 * event so the host shell and the LSAT shell — which never mount at the same
 * time — both re-render their chrome the instant the trail changes.
 */

import { useSyncExternalStore } from 'react';
import { domainForPath, type Domain } from './domainNav';

export const NAV_HISTORY_EVENT = 'study-vault:nav-history';
const STORAGE_KEY = 'study-vault:nav-history';
/** Cap the trail so sessionStorage can't grow unbounded on a long session. */
const MAX_ENTRIES = 50;

/** One visited location, attributed to its domain with a render-ready label. */
export interface NavHistoryEntry {
  /** Full app path including the `/lsat` prefix for the LSAT plane. */
  path: string;
  domain: Domain;
  /** Friendly destination name for breadcrumbs / "Back to <label>". */
  label: string;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function readRaw(): NavHistoryEntry[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: only keep well-formed tuples (a malformed entry from an older
    // build or a hand-edited store must not crash the chrome).
    return parsed.filter(
      (e): e is NavHistoryEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as NavHistoryEntry).path === 'string' &&
        typeof (e as NavHistoryEntry).label === 'string' &&
        ((e as NavHistoryEntry).domain === 'host' || (e as NavHistoryEntry).domain === 'lsat'),
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: NavHistoryEntry[]): void {
  if (!hasWindow()) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // sessionStorage can throw (private mode / quota). The in-memory event still
    // fires below, so the chrome stays correct for the live session.
  }
  window.dispatchEvent(new Event(NAV_HISTORY_EVENT));
}

/** The full trail, oldest first. */
export function getHistory(): NavHistoryEntry[] {
  return readRaw();
}

/** The most recent entry (the location currently shown), or null. */
export function peek(): NavHistoryEntry | null {
  const entries = readRaw();
  return entries.length ? entries[entries.length - 1] : null;
}

/**
 * The entry immediately before the current one — the destination a single
 * "Back" press should land on. Null when there is nowhere to go back to.
 */
export function peekPrevious(): NavHistoryEntry | null {
  const entries = readRaw();
  return entries.length >= 2 ? entries[entries.length - 2] : null;
}

/**
 * Record a visit. De-duplicates a repeat of the current path (so a re-render or
 * a redundant nav event doesn't pile identical entries), and back-fills the
 * domain from the path when a caller doesn't pass one.
 */
export function pushHistory(entry: {
  path: string;
  label: string;
  domain?: Domain;
}): void {
  const next: NavHistoryEntry = {
    path: entry.path,
    label: entry.label,
    domain: entry.domain ?? domainForPath(entry.path),
  };
  const entries = readRaw();
  const last = entries[entries.length - 1];
  if (last && last.path === next.path) {
    // Same location revisited — refresh the label (it may have resolved to a
    // friendlier name now) but don't grow the trail.
    if (last.label !== next.label) {
      entries[entries.length - 1] = next;
      writeRaw(entries);
    }
    return;
  }
  entries.push(next);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  writeRaw(entries);
}

/**
 * Pop the current entry off the trail (used right before a back-navigation so
 * the trail head tracks the location we're returning TO). Returns the entry we
 * popped, or null when the trail was empty.
 */
export function popHistory(): NavHistoryEntry | null {
  const entries = readRaw();
  const popped = entries.pop() ?? null;
  if (popped) writeRaw(entries);
  return popped;
}

/** Clear the trail (test helper / hard reset). */
export function clearHistory(): void {
  if (!hasWindow()) return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(NAV_HISTORY_EVENT));
}

// ──────────────────────────────────────────────────────────────────────────
// React binding
//
// A `useSyncExternalStore` subscription so the shell chrome (breadcrumb + back
// button) re-renders the moment the trail changes — whether the change came
// from this plane (a route effect) or the other plane (its route effect fires
// the same `NAV_HISTORY_EVENT`). The snapshot is cached so React's
// referential-equality check stays cheap and stable between unrelated renders.

let cachedSnapshot: NavHistoryEntry[] = readRaw();
let cachedRaw = hasWindow() ? window.sessionStorage.getItem(STORAGE_KEY) : null;

function subscribe(onChange: () => void): () => void {
  if (!hasWindow()) return () => {};
  // `storage` covers a reload / another tab; the custom event covers same-tab
  // pushes (storage events don't fire in the writing document).
  window.addEventListener(NAV_HISTORY_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(NAV_HISTORY_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getSnapshot(): NavHistoryEntry[] {
  if (!hasWindow()) return cachedSnapshot;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  // Only re-parse + hand React a new array reference when the serialized store
  // actually changed — otherwise return the cached reference to avoid an
  // infinite render loop (getSnapshot must be referentially stable when equal).
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSnapshot = readRaw();
  }
  return cachedSnapshot;
}

/** Live view of the navigation trail, oldest first. Re-renders on every push. */
export function useNavigationHistory(): NavHistoryEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => cachedSnapshot);
}
