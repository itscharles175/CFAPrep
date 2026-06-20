/** Shared Tauri runtime helpers (web build stays unaffected). */

import { setJSON } from "./storage";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Desktop log directory (Tauri plugin-log); null in browser builds. */
export async function getAppLogDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("app_log_dir");
  } catch {
    return null;
  }
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

// AUDIT-3 — under the unified shell the LSAT backend is a SUPERVISED SIDECAR: the
// Rust supervisor in src-tauri owns its lifecycle (ordered startup BA2, health-
// poll + auto-respawn BA1, log ring BA8) and exposes `get_sidecar_status` /
// `get_sidecar_logs` / `get_system_health_aggregated`. The standalone LSAT-Lab
// native commands this module historically invoked — `get_backend_status`,
// `restart_backend`, `export_backend_logs`, `app_log_dir` — are NOT registered in
// the CFAPrep crate, so they used to reject and SILENTLY no-op in the packaged app
// (the diagnostics "Native backend" card rendered dead). These now read the
// supervisor's status instead. Several other LSAT-Lab native affordances
// (openFocusTimer, openNotebookOS, quickCaptureNote, playAudioBriefing,
// emitFirewallBlocked, saveReport, take_launch_file, mica_active) likewise have no
// command in this shell and remain intentional, guarded no-ops below.

/** Minimal mirror of the supervisor's per-sidecar status row (snake_case wire). */
interface SupervisorSidecarRow {
  name: string;
  ready?: boolean;
  healthy?: boolean;
}

/** vNext — native backend supervision status, browser-safe. Projects the LSAT
 *  backend's row from the supervisor's `get_sidecar_status` onto BackendStatus.
 *  Returns null in the browser or if the supervisor command is unavailable. */
export async function getBackendStatus(): Promise<BackendStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<SupervisorSidecarRow[]>("get_sidecar_status");
    const row = Array.isArray(rows)
      ? rows.find((r) => typeof r?.name === "string" && r.name.toLowerCase().includes("lsat"))
      : undefined;
    if (!row) return null;
    const ready = row.ready === true;
    return {
      managed: "LSAT backend (supervised)",
      port_open: row.healthy === true,
      healthy: ready,
      // The supervisor auto-restarts a down sidecar (BA1); there is no manual
      // restart command, so the card shows status without a (broken) Restart button.
      restartable: false,
      degraded: ready ? undefined : true,
      message: ready
        ? "Supervised by the desktop shell."
        : "Sidecar not ready — the supervisor auto-restarts it.",
    };
  } catch {
    return null;
  }
}

/** vNext — the supervisor owns restarts (auto-respawn on health failure); there is
 *  no manual restart command, so this simply re-reads the supervised status. */
export async function restartBackend(): Promise<BackendStatus | null> {
  return getBackendStatus();
}

/** vNext — reveal where backend/native logs live. The supervisor exposes a log
 *  ring (`get_sidecar_logs`) rather than a directory path; fall back to the app
 *  log dir when the shell provides one. */
export async function exportBackendLogs(): Promise<string | null> {
  return getAppLogDir();
}

/** vNext — open the native focus-timer affordance. */
export async function openFocusTimer(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("open_focus_timer");
  } catch {
    return false;
  }
}

/** Notebook OS — focus the app and navigate to the central workspace. */
export async function openNotebookOS(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("open_notebook_os");
  } catch {
    return false;
  }
}

/** Notebook OS — native quick capture into the workbench. */
export async function quickCaptureNote(body: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("quick_capture_note", { body });
  } catch {
    return false;
  }
}

/** Notebook OS — request playback/opening for a study briefing. */
export async function playAudioBriefing(episodeId?: number): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("play_audio_briefing", {
      episodeId: episodeId ?? null,
    });
  } catch {
    return false;
  }
}

/** Native/desktop privacy surface for denied official-content actions. */
export async function emitFirewallBlocked(
  reason: string,
  target: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("emit_firewall_blocked", { reason, target });
  } catch {
    return false;
  }
}

/** vNext — save a report via the native shell into the app data directory. */
export async function saveReport(
  filename: string,
  contents: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("save_report", { filename, contents });
  } catch {
    return null;
  }
}

/**
 * G6 — open a file-system path (typically a directory) in the OS shell.
 * Uses `@tauri-apps/plugin-shell` `open` under Tauri; no-ops in the browser.
 * Uses `importOptional` (indirection via `new Function`) so the specifier is
 * invisible to static resolvers (Vite/Vitest don't try to bundle the package
 * in non-Tauri environments).
 */
export async function openPath(path: string): Promise<void> {
  const shell = await importOptional<{ open: (p: string) => Promise<void> }>(
    "@tauri-apps/plugin-shell",
  );
  if (!shell) return;
  try {
    await shell.open(path);
  } catch {
    /* ignore — shell plugin unavailable or path invalid */
  }
}

/** Wrap on-disk bytes at `path` in a `File` (name + MIME inferred). */
function fileFromBytes(path: string, bytes: Uint8Array): File {
  const name = path.split(/[/\\]/).pop() ?? "import.pdf";
  // Copy into a fresh ArrayBuffer-backed view: TS 5.7+ types `Uint8Array` as
  // `Uint8Array<ArrayBufferLike>`, which isn't assignable to `BlobPart` (it
  // wants an ArrayBuffer-backed view, not a possibly-shared one).
  return new File([new Uint8Array(bytes)], name, {
    type: name.toLowerCase().endsWith(".txt") ? "text/plain" : "application/pdf",
  });
}

/** Open a native file picker (desktop) for PrepTest PDF/TXT import. */
export async function pickPdfFile(): Promise<File | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({
      multiple: false,
      filters: [{ name: "PrepTest", extensions: ["pdf", "txt"] }],
    });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return fileFromBytes(String(path), bytes);
  } catch {
    return null;
  }
}

/**
 * 4.3 — read a file the app was launched/associated with (an absolute path from
 * `listenOpenFile`) into a `File` for the import wizard. Returns null in the
 * browser or if the read fails.
 */
export async function readFileFromPath(path: string): Promise<File | null> {
  if (!isTauri()) return null;
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(path);
    return fileFromBytes(path, bytes);
  } catch {
    return null;
  }
}

/** Load optional Tauri plugins without failing the web build. */
async function importOptional<T>(specifier: string): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const loader = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<T>;
    return await loader(specifier);
  } catch {
    return null;
  }
}

export const POPOUT_PASSAGE_KEY = "lsatlab.popout.passage";

export interface PopoutPassage {
  topic?: string;
  text: string;
  at: number;
}

/**
 * C3 — pop the RC passage into its own window (second monitor). Content rides
 * in localStorage (shared same-origin) so the pop-out updates live via the
 * `storage` event; under Tauri we spawn a real WebviewWindow, otherwise a
 * browser popup. Both load the `/popout/passage` route.
 */
export async function openPassagePopout(payload: {
  topic?: string;
  text: string;
}): Promise<void> {
  setJSON(POPOUT_PASSAGE_KEY, { ...payload, at: Date.now() });
  const route = "/popout/passage";
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // A fixed label reuses one window; if it already exists the constructor
      // throws — we then focus the existing window (content syncs via storage).
      new WebviewWindow("passage-popout", {
        url: route,
        title: "Passage",
        width: 620,
        height: 820,
      });
    } catch {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("passage-popout");
      if (existing) {
        await existing.show();
        await existing.setFocus();
      }
    }
    return;
  }
  window.open(route, "lsatlab-passage-popout", "width=620,height=820,resizable=yes");
}

/**
 * Best-effort desktop notification: the Tauri notification plugin when it's
 * bundled, otherwise the Web Notifications API, otherwise a no-op. Safe to call
 * from anywhere (browser or Tauri).
 */
export async function notify(title: string, body?: string): Promise<void> {
  const plugin = await importOptional<{
    isPermissionGranted: () => Promise<boolean>;
    requestPermission: () => Promise<string>;
    sendNotification: (o: { title: string; body?: string }) => void;
  }>("@tauri-apps/plugin-notification");
  if (plugin) {
    try {
      let granted = await plugin.isPermissionGranted();
      if (!granted) granted = (await plugin.requestPermission()) === "granted";
      if (granted) {
        plugin.sendNotification({ title, body });
        return;
      }
    } catch {
      /* fall through to web */
    }
  }
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      const perm = await Notification.requestPermission();
      if (perm === "granted") new Notification(title, { body });
    }
  } catch {
    /* ignore */
  }
}

/** C7 — toggle OS fullscreen (kiosk/test mode) under Tauri; no-op in browser. */
export async function setFullscreen(on: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch {
    /* ignore — window API unavailable */
  }
}

/**
 * Subscribe to a Tauri backend event by name, browser-safe. The `@tauri-apps/api`
 * event module is imported dynamically and only under Tauri, so the web bundle is
 * unaffected. Returns an unsubscribe function (a no-op in the browser).
 */
function listenTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    if (cancelled) return;
    listen<T>(event, (e) => handler(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * Tray "Open"/"Resume", a bare second launch, and the Ctrl/Cmd+Shift+L global
 * shortcut all emit `tray-open` → focus window and resume the last session.
 */
export function listenTrayOpen(onOpen: () => void): () => void {
  return listenTauriEvent<unknown>("tray-open", () => onOpen());
}

/**
 * Richer tray items ("Today's SRS", "Quick drill") emit `tray-navigate` with the
 * target route as the payload (e.g. "/srs", "/drills"). The frontend navigates
 * there. No-op in the browser.
 */
export function listenTrayNavigate(onNavigate: (path: string) => void): () => void {
  return listenTauriEvent<string>("tray-navigate", (path) => {
    if (typeof path === "string" && path) onNavigate(path);
  });
}

export function listenBackendReady(onReady: (ready: boolean) => void): () => void {
  return listenTauriEvent<boolean>("backend-ready", (ready) => onReady(Boolean(ready)));
}

export function listenBackendDegraded(onStatus: (status: BackendStatus) => void): () => void {
  return listenTauriEvent<BackendStatus>("backend-degraded", (status) => onStatus(status));
}

export function listenQuickCaptureNote(onCapture: (body: string) => void): () => void {
  return listenTauriEvent<string>("quick-capture-note", (body) => onCapture(body || ""));
}

export interface NativeJobProgress {
  kind: string;
  id: string;
  status: string;
  progress_pct: number;
}

export function listenJobProgress(onProgress: (payload: NativeJobProgress) => void): () => void {
  return listenTauriEvent<NativeJobProgress>("job-progress", onProgress);
}

export interface FirewallBlockedEvent {
  reason: string;
  target: string;
}

export function listenFirewallBlocked(onBlocked: (payload: FirewallBlockedEvent) => void): () => void {
  return listenTauriEvent<FirewallBlockedEvent>("firewall-blocked", onBlocked);
}

/**
 * 4.3 — the app was opened with a file (OS "Open with LSAT Lab" on a `.pdf`, or a
 * second launch forwarded one via single-instance). Two delivery paths are
 * covered so an initial-launch race can't drop the file:
 *   1. a one-shot `take_launch_file` command pulled on mount (initial launch,
 *      captured natively before the webview existed), and
 *   2. the `open-file` event (second-instance forwards + a belt-and-braces emit
 *      after the window is revealed).
 * The callback receives the absolute file path. No-op / never fires in browser.
 */
export function listenOpenFile(onFile: (path: string) => void): () => void {
  if (!isTauri()) return () => {};
  let delivered = false;
  const deliver = (path: string) => {
    if (delivered || typeof path !== "string" || !path) return;
    delivered = true;
    onFile(path);
  };
  // (1) Pull any launch file captured natively at startup.
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<string | null>("take_launch_file"))
    .then((path) => {
      if (path) deliver(path);
    })
    .catch(() => {
      /* command unavailable — rely on the event */
    });
  // (2) Also listen for the event (second-instance handoff / post-reveal emit).
  return listenTauriEvent<string>("open-file", (path) => deliver(path));
}
