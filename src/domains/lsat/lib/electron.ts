/** Shared Electron runtime helpers (web build stays unaffected). */

import {
  getDesktopBridge,
  isElectronRuntime,
  registerDesktopSubscription,
  type StudyVaultBootStatus,
  type StudyVaultSecondInstanceEvent,
} from '@/lib/desktopBridge';
import { setJSON } from './storage';

export function isElectron(): boolean {
  return isElectronRuntime();
}

/** Desktop log directory; null until the Electron bridge exposes a log path. */
export async function getAppLogDir(): Promise<string | null> {
  return null;
}

export interface BackendStatus {
  managed: string;
  port_open: boolean;
  healthy: boolean;
  restartable: boolean;
  degraded?: boolean;
  crash_loop_state?: string;
  message: string;
}

/** Minimal mirror of the supervisor's per-sidecar status row. */
interface SupervisorSidecarRow {
  name: string;
  ready?: boolean;
  healthy?: boolean;
}

/** Native backend supervision status, with a browser-safe null fallback. */
export async function getBackendStatus(): Promise<BackendStatus | null> {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  try {
    const rows: SupervisorSidecarRow[] = await bridge.sidecar.status();
    const row = Array.isArray(rows)
      ? rows.find((candidate) => typeof candidate?.name === 'string' && candidate.name.toLowerCase().includes('lsat'))
      : undefined;
    if (!row) return null;
    const ready = row.ready === true;
    return {
      managed: 'LSAT backend (supervised)',
      port_open: row.healthy === true,
      healthy: ready,
      restartable: false,
      degraded: ready ? undefined : true,
      message: ready ? 'Supervised by the desktop shell.' : 'Sidecar not ready - the supervisor auto-restarts it.',
    };
  } catch {
    return null;
  }
}

/** The supervisor owns restarts, so this refreshes the current status. */
export async function restartBackend(): Promise<BackendStatus | null> {
  return getBackendStatus();
}

/** Retained for diagnostics consumers; no log-directory bridge exists yet. */
export async function exportBackendLogs(): Promise<string | null> {
  return getAppLogDir();
}

// These historical LSAT-Lab native affordances are not part of the StudyVault
// Electron bridge. Their established guarded fallback remains intentional.
export async function openFocusTimer(): Promise<boolean> {
  return false;
}

export async function openNotebookOS(): Promise<boolean> {
  return false;
}

export async function quickCaptureNote(_body: string): Promise<boolean> {
  return false;
}

export async function playAudioBriefing(_episodeId?: number): Promise<boolean> {
  return false;
}

export async function emitFirewallBlocked(_reason: string, _target: string): Promise<boolean> {
  return false;
}

export async function saveReport(_filename: string, _contents: string): Promise<string | null> {
  return null;
}

/** Open a validated file-system path through the constrained main-process handler. */
export async function openPath(path: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) return;
  try {
    await bridge.openPath(path);
  } catch {
    // Invalid or disallowed paths are rejected by the main process.
  }
}

/** Wrap on-disk bytes at `path` in a File (name + MIME inferred). */
function fileFromBytes(path: string, bytes: Uint8Array): File {
  const name = path.split(/[/\\]/).pop() ?? 'import.pdf';
  return new File([new Uint8Array(bytes)], name, {
    type: name.toLowerCase().endsWith('.txt') ? 'text/plain' : 'application/pdf',
  });
}

/** Open a desktop file picker for PrepTest PDF/TXT import. */
export async function pickPdfFile(): Promise<File | null> {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  try {
    const files = await bridge.files.pickFiles();
    const selected = files[0];
    if (!selected) return null;
    const result = await bridge.files.read(selected.path);
    return fileFromBytes(result.path, new Uint8Array(result.data));
  } catch {
    return null;
  }
}

/** Read an absolute path delivered by `listenOpenFile` into an importable File. */
export async function readFileFromPath(path: string): Promise<File | null> {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  try {
    const result = await bridge.files.read(path);
    return fileFromBytes(result.path, new Uint8Array(result.data));
  } catch {
    return null;
  }
}

export const POPOUT_PASSAGE_KEY = 'lsatlab.popout.passage';

export interface PopoutPassage {
  topic?: string;
  text: string;
  at: number;
}

/** Pop the RC passage into its own window while retaining the browser fallback. */
export async function openPassagePopout(payload: { topic?: string; text: string }): Promise<void> {
  setJSON(POPOUT_PASSAGE_KEY, { ...payload, at: Date.now() });
  const route = '/lsat/popout/passage';
  const bridge = getDesktopBridge();
  if (bridge) {
    try {
      await bridge.popout({
        route,
        title: 'Passage',
        width: 620,
        height: 820,
      });
    } catch {
      // The main process owns window creation/reuse and may reject during shutdown.
    }
    return;
  }
  window.open(route, 'lsatlab-passage-popout', 'width=620,height=820,resizable=yes');
}

/** Best-effort desktop notification, then the Web Notifications fallback. */
export async function notify(title: string, body?: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (bridge) {
    try {
      await bridge.notification({ title, body: body ?? '' });
      return;
    } catch {
      // Fall through to the browser notification surface.
    }
  }
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') new Notification(title, { body });
    }
  } catch {
    // Notifications are best effort.
  }
}

/** Toggle OS fullscreen in Electron; no-op in the browser. */
export async function setFullscreen(on: boolean): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge) return;
  try {
    await bridge.fullscreen.set(on);
  } catch {
    // Window may be closing or unavailable.
  }
}

function listenBootStatus(handler: (status: StudyVaultBootStatus) => void): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) return () => {};
  return registerDesktopSubscription(() => bridge.events.onBootStatus(handler));
}

function listenSecondInstance(handler: (event: StudyVaultSecondInstanceEvent) => void): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) return () => {};
  return registerDesktopSubscription(() => bridge.events.onSecondInstance(handler));
}

/** A bare second launch focuses the existing app and resumes the last session. */
export function listenTrayOpen(onOpen: () => void): () => void {
  return listenSecondInstance(() => onOpen());
}

function routeFromSecondInstance(event: StudyVaultSecondInstanceEvent): string | null {
  for (const arg of event.argv) {
    if (/^\/[A-Za-z0-9/_-]*$/.test(arg)) return arg;
    const prefix = 'studyvault://navigate/';
    if (arg.startsWith(prefix)) return `/${arg.slice(prefix.length)}`;
  }
  return null;
}

/** Navigate when a second launch carries an explicit StudyVault route. */
export function listenTrayNavigate(onNavigate: (path: string) => void): () => void {
  return listenSecondInstance((event) => {
    const path = routeFromSecondInstance(event);
    if (path) onNavigate(path);
  });
}

export function listenBackendReady(onReady: (ready: boolean) => void): () => void {
  return listenBootStatus((status) => {
    if (status.status === 'ok') onReady(true);
  });
}

export function listenBackendDegraded(onStatus: (status: BackendStatus) => void): () => void {
  return listenBootStatus((status) => {
    if (status.status === 'ok') return;
    onStatus({
      managed: 'LSAT backend (supervised)',
      port_open: false,
      healthy: false,
      restartable: false,
      degraded: true,
      message: status.degraded_reason || 'Desktop sidecars are degraded.',
    });
  });
}

export function listenQuickCaptureNote(_onCapture: (body: string) => void): () => void {
  return () => {};
}

export interface NativeJobProgress {
  kind: string;
  id: string;
  status: string;
  progress_pct: number;
}

export function listenJobProgress(_onProgress: (payload: NativeJobProgress) => void): () => void {
  return () => {};
}

export interface FirewallBlockedEvent {
  reason: string;
  target: string;
}

export function listenFirewallBlocked(_onBlocked: (payload: FirewallBlockedEvent) => void): () => void {
  return () => {};
}

/** Receive initial-launch and second-instance file-open handoffs from preload. */
export function listenOpenFile(onFile: (path: string) => void): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) return () => {};
  let delivered = false;
  const deliver = (path: string) => {
    if (delivered || typeof path !== 'string' || !path) return;
    delivered = true;
    onFile(path);
  };
  return registerDesktopSubscription(() =>
    bridge.events.onOpenFile((event) => {
      for (const path of event.paths) deliver(path);
    }),
  );
}
