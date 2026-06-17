// LSAT-6 — optional backend sync for the Notebook knowledge base.
//
// Annotations (highlights + margin notes) and the new user-authored explanations
// + tags are written to localStorage first (the offline-always path in
// annotationPrefs.ts / prefs.ts / annotationsHub.ts). This module adds an
// OPTIONAL, best-effort mirror to the LSAT backend so the same data is:
//   - searchable (FTS5 over note text + explanations + tags),
//   - cross-linkable (backlinks), and
//   - surfaced beside AI explanations.
//
// Everything here degrades silently when the backend is offline: a failed
// fetch/sync is swallowed and the localStorage path keeps working unchanged. No
// call in this module ever throws to its caller.

import { api } from "./api";
import type { AnnotationExplanation, AnnotationSearchHit, Backlink } from "./types";

/** True once we've pulled the backlog for a question this session (so we don't
 * refetch on every render). Keyed by `${scope}:${refId}`. */
const hydrated = new Set<string>();

function key(scope: "question" | "attempt", refId: number): string {
  return `${scope}:${refId}`;
}

/**
 * Fetch the backend-stored user explanation + tags for a question's annotation
 * once per session (first load), returning null when unavailable/offline. The
 * caller decides whether to merge into the local view; this never writes.
 */
export async function fetchBacklogOnce(
  scope: "question" | "attempt",
  refId: number,
): Promise<Backlink[] | null> {
  const k = key(scope, refId);
  if (hydrated.has(k)) return null;
  hydrated.add(k);
  try {
    return await api.getAnnotationBacklinks(`${scope}:${refId}`);
  } catch {
    // Offline / backend down — the localStorage path is authoritative.
    return null;
  }
}

/** Reset the per-session hydration cache (used by tests / a manual refresh). */
export function resetBacklogCache(): void {
  hydrated.clear();
}

/**
 * Best-effort backend search over annotation text. Returns [] on any failure so
 * the UI can render an empty result rather than crash when offline.
 */
export async function searchKb(q: string, limit = 20): Promise<AnnotationSearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  try {
    const res = await api.searchAnnotations(term, limit);
    return res.hits ?? [];
  } catch {
    return [];
  }
}

/**
 * Read the user-authored explanation for an annotation id, or null when there is
 * none / the backend is offline.
 */
export async function fetchExplanation(
  annotationId: number,
): Promise<AnnotationExplanation | null> {
  try {
    return await api.getAnnotationExplanation(annotationId);
  } catch {
    return null;
  }
}

/**
 * Persist a user-authored explanation on write. Best-effort: resolves to true
 * when the backend stored it, false when offline (the caller keeps the local
 * copy regardless). Never throws.
 */
export async function syncExplanation(
  annotationId: number,
  userExplanation: string,
): Promise<boolean> {
  try {
    await api.saveAnnotationExplanation(annotationId, userExplanation);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a tag list on write. Best-effort, mirrors {@link syncExplanation}.
 */
export async function syncTags(
  annotationId: number,
  tags: string[],
): Promise<boolean> {
  try {
    await api.saveAnnotationTags(annotationId, tags);
    return true;
  } catch {
    return false;
  }
}
