/**
 * DATA-6 — shared study-profile arbiter bridge (host side).
 *
 * The single reconciled study profile lives behind the LSAT backend sidecar
 * (`GET/PUT /api/study/profile`), which arbitrates the LSAT `StudyPlan` and the
 * host `StudyPlanSettings` into one shape by last-write-wins. The host can't
 * reach the LSAT React app, but it CAN reach the sidecar over HTTP — so this
 * bridge reads the reconciled profile and dual-writes a host edit to BOTH the
 * backend (single source of truth) AND the host's local Dexie store.
 *
 * Fully degrading (mirrors `lsatReviewBridge.ts` / `lsatBackend.ts`): any failure
 * (sidecar down, timeout, shape drift) NEVER throws. A failed read falls back to
 * the host's local Dexie profile; a failed remote write still persists locally so
 * the user's edit is never lost — the next successful sync reconciles it.
 *
 * DATA-1: the `/api/study/profile` route ships ahead of the next `api.gen.ts`
 * regeneration, so it's a string literal for now (same as LEARN-2's
 * `/api/study/due-unified` in `lsatReviewBridge.ts`). Swap to `keyof paths` once
 * the contract is regenerated with this path.
 */
import {
  DEFAULT_SHARED_STUDY_PROFILE,
  studyProfileFromRaw,
  studyProfilePatchToRaw,
  type RawSharedStudyProfile,
  type SharedStudyProfile,
  type StudyProfilePatch,
} from './types/StudyProfile';
import {
  getStudyPlanSettings,
  saveStudyPlanSettings,
  studyPlanSettingsToProfile,
  studyProfileToPlanSettingsPatch,
} from './progressStore';

const LSAT_API_BASE = 'http://127.0.0.1:8100';
// Not yet bound to `keyof paths` — the contract is regenerated a batch later.
const STUDY_PROFILE_PATH = '/api/study/profile';

/** Result of a profile read/write through the bridge. */
export interface StudyProfileResult {
  /** True when the backend arbiter answered a 2xx. */
  ok: boolean;
  /** True when the value came from the backend (vs the local Dexie fallback). */
  fromBackend: boolean;
  /** The reconciled profile (always populated — local fallback on failure). */
  profile: SharedStudyProfile;
  /** Present when the bridge could not reach / parse the sidecar. */
  error?: string;
}

async function fetchProfileJson(
  timeoutMs: number,
  init: { method?: string; body?: string } = {},
): Promise<{ ok: boolean; status: number; data: unknown } | { ok: false; status: 0; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${STUDY_PROFILE_PATH}`, {
      signal: controller.signal,
      method: init.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the local-Dexie fallback profile from the host's `StudyPlanSettings`. */
async function localProfileFallback(): Promise<SharedStudyProfile> {
  try {
    const settings = await getStudyPlanSettings();
    return studyPlanSettingsToProfile(settings);
  } catch {
    return { ...DEFAULT_SHARED_STUDY_PROFILE };
  }
}

/**
 * Read the reconciled shared study profile from the backend arbiter. Degrading:
 * any failure returns the host's local Dexie profile with `ok: false` so the
 * caller always has a usable value and the UI never hangs.
 */
export async function fetchStudyProfile(
  opts: { timeoutMs?: number } = {},
): Promise<StudyProfileResult> {
  const { timeoutMs = 2500 } = opts;
  const res = await fetchProfileJson(timeoutMs);
  if (!('ok' in res) || !res.ok || !res.data || typeof res.data !== 'object') {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return {
      ok: false,
      fromBackend: false,
      profile: await localProfileFallback(),
      error: `Study profile unavailable — ${reason}.`,
    };
  }
  return {
    ok: true,
    fromBackend: true,
    profile: studyProfileFromRaw(res.data as RawSharedStudyProfile),
  };
}

/**
 * Dual-write a host profile edit: persist to the host's local Dexie store
 * (`StudyPlanSettings`) FIRST so the edit is never lost, then push to the backend
 * arbiter (`PUT /api/study/profile`). Degrading: a failed remote write still
 * returns the locally-persisted profile with `ok: false`, so the next successful
 * sync reconciles it (last-write-wins). Never throws.
 *
 * The patch defaults `lastWriter` to `"host"` since the host is the caller.
 */
export async function saveStudyProfile(
  patch: StudyProfilePatch,
  opts: { timeoutMs?: number } = {},
): Promise<StudyProfileResult> {
  const { timeoutMs = 4000 } = opts;
  const effective: StudyProfilePatch = { lastWriter: 'host', ...patch };

  // 1) Local-first: persist the host-owned view to Dexie so the edit survives a
  // down sidecar. Map the cross-domain patch onto StudyPlanSettings fields.
  let localProfile: SharedStudyProfile;
  try {
    const saved = await saveStudyPlanSettings(studyProfileToPlanSettingsPatch(effective));
    localProfile = studyPlanSettingsToProfile(saved);
  } catch {
    localProfile = await localProfileFallback();
  }

  // 2) Push to the backend arbiter (single source of truth).
  const res = await fetchProfileJson(timeoutMs, {
    method: 'PUT',
    body: JSON.stringify(studyProfilePatchToRaw(effective)),
  });
  if (!('ok' in res) || !res.ok || !res.data || typeof res.data !== 'object') {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return {
      ok: false,
      fromBackend: false,
      profile: localProfile,
      error: `Study profile not synced to backend — ${reason}. Saved locally.`,
    };
  }
  return {
    ok: true,
    fromBackend: true,
    profile: studyProfileFromRaw(res.data as RawSharedStudyProfile),
  };
}
