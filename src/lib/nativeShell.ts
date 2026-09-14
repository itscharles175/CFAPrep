import type { StudyVaultNativeNavigationEvent } from './desktopBridge';
import { readStudyContext, workspaceHref, type StudyContext } from './studyContext';
import { readResumeHandle } from './studyTrail';
import type { StudyWorkspace } from '../routes/routeManifest';

export const NATIVE_RECOVERY_EVENT = 'studyvault:native-recovery';
const NATIVE_WORKSPACE_PREFIX = '/__native/workspace/';
const NATIVE_RESUME_ROUTE = '/__native/resume';
const NATIVE_WORKSPACES = new Set<StudyWorkspace>([
  'today', 'learn', 'practice', 'review', 'progress', 'library',
]);

/** Renderer-side defense in depth for routes received from the main process. */
export function validatedNativeRoute(route: unknown): string | null {
  if (typeof route !== 'string' || route.length === 0 || route.length > 2_048) return null;
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null;
  try {
    const rawPath = decodeURIComponent(route.split(/[?#]/, 1)[0]);
    if (rawPath.split('/').includes('..')) return null;
    const parsed = new URL(route, 'app://studyvault');
    if (parsed.protocol !== 'app:' || parsed.host !== 'studyvault') return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/** Resolve native menu tokens at click time so they honor current study context. */
export function resolveNativeRoute(
  route: unknown,
  context: StudyContext = readStudyContext(),
): string | null {
  const validated = validatedNativeRoute(route);
  if (!validated) return null;
  if (validated === NATIVE_RESUME_ROUTE) {
    return validatedNativeRoute(readResumeHandle()?.route) ?? workspaceHref('today', context);
  }
  if (!validated.startsWith(NATIVE_WORKSPACE_PREFIX)) return validated;
  const workspace = validated.slice(NATIVE_WORKSPACE_PREFIX.length);
  if (!NATIVE_WORKSPACES.has(workspace as StudyWorkspace)) return null;
  return workspaceHref(workspace as StudyWorkspace, context);
}

export function dispatchNativeRecovery(detail: { state: 'resume' | 'unlock'; at: number }): void {
  window.dispatchEvent(new CustomEvent(NATIVE_RECOVERY_EVENT, { detail }));
}

export function isNativeNavigationEvent(value: unknown): value is StudyVaultNativeNavigationEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StudyVaultNativeNavigationEvent>;
  return validatedNativeRoute(candidate.route) !== null
    && ['menu', 'dock', 'notification', 'deep-link'].includes(candidate.source ?? '');
}
