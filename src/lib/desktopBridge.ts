export type DesktopUnsubscribe = () => void;

export interface StudyVaultPdfEntry {
  path: string;
  name: string;
  extension: '.pdf';
  size: number;
  relative_path: string;
}

export interface StudyVaultFileDescriptor {
  path: string;
  name: string;
  extension: '.pdf' | '.txt';
  size: number;
}

export interface StudyVaultReadResult extends StudyVaultFileDescriptor {
  data: Uint8Array;
}

export interface StudyVaultRuntimeInfo {
  app_version: string;
  electron_version: string;
  chrome_version: string;
  node_version: string;
  platform: 'win32' | 'darwin' | 'linux';
  arch: string;
  is_packaged: boolean;
}

export interface StudyVaultSidecarStatus {
  name: string;
  port: number | null;
  ready_port: number | null;
  healthy: boolean;
  ready: boolean;
  depends_on: string[];
  pid: number | null;
  optional: boolean;
  present: boolean;
  blocked: boolean;
  block_reason: string | null;
  provenance_status: string | null;
  state: 'pending' | 'starting' | 'ready' | 'degraded' | 'stopped' | 'exited' | 'skipped' | 'blocked' | 'backoff';
  restart_count: number;
}

export type StudyVaultHealthVerdict = 'ok' | 'degraded' | 'error';

export interface StudyVaultSidecarAggregate {
  status: StudyVaultHealthVerdict;
  ready: number;
  required_down: number;
  optional_down: number;
  total: number;
  required_down_names: string[];
}

export interface StudyVaultBootStatus {
  status: StudyVaultHealthVerdict;
  launched: number;
  skipped: number;
  blocked: number;
  skipped_names: string[];
  blocked_names: string[];
  degraded_reason: string;
}

export interface StudyVaultSecondInstanceEvent {
  argv: string[];
  cwd: string;
  paths: string[];
}

export interface StudyVaultPathEvent {
  paths: string[];
}

export interface StudyVaultNotificationOptions {
  title: string;
  body: string;
}

export interface StudyVaultBridge {
  runtime: {
    info(): Promise<StudyVaultRuntimeInfo>;
  };
  files: {
    pickFolder(): Promise<string | null>;
    pickFiles(): Promise<StudyVaultFileDescriptor[]>;
    listPdfs(root: string): Promise<StudyVaultPdfEntry[]>;
    read(path: string): Promise<StudyVaultReadResult>;
  };
  sidecar: {
    status(): Promise<StudyVaultSidecarStatus[]>;
    logs(name: string): Promise<string[]>;
    aggregate(): Promise<StudyVaultSidecarAggregate>;
  };
  keychain: {
    get(): Promise<string | null>;
    set(secret: string): Promise<{ ok: true }>;
    delete(): Promise<{ ok: true }>;
  };
  openPath(path: string): Promise<{ opened: boolean; error: string }>;
  openExternal(url: string): Promise<{ opened: true }>;
  popout(options: { route: string; title?: string; width?: number; height?: number }): Promise<{ id: number }>;
  notification(options: StudyVaultNotificationOptions): Promise<{ shown: boolean }>;
  fullscreen: {
    get(): Promise<boolean>;
    set(value: boolean): Promise<boolean>;
  };
  events: {
    onBootStatus(handler: (status: StudyVaultBootStatus) => void): DesktopUnsubscribe;
    onSecondInstance(handler: (event: StudyVaultSecondInstanceEvent) => void): DesktopUnsubscribe;
    onOpenFile(handler: (event: StudyVaultPathEvent) => void): DesktopUnsubscribe;
    onPdfDrop(handler: (event: StudyVaultPathEvent) => void): DesktopUnsubscribe;
  };
}

declare global {
  interface Window {
    studyvault?: StudyVaultBridge;
  }
}

export function getDesktopBridge(): StudyVaultBridge | null {
  return typeof window === 'undefined' ? null : (window.studyvault ?? null);
}

export function isElectronRuntime(): boolean {
  return getDesktopBridge() !== null;
}

/** Register a preload event while still returning cleanup synchronously. */
export function registerDesktopSubscription(
  register: () => Promise<DesktopUnsubscribe> | DesktopUnsubscribe,
): DesktopUnsubscribe {
  let disposed = false;
  let unsubscribe: DesktopUnsubscribe | null = null;

  const accept = (next: DesktopUnsubscribe) => {
    if (disposed) next();
    else unsubscribe = next;
  };

  try {
    const pending = register();
    if (typeof pending === 'function') {
      accept(pending);
    } else {
      void pending.then(accept).catch(() => undefined);
    }
  } catch {
    // Missing/older preload surfaces degrade to a no-op subscription.
  }

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}
