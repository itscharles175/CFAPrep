export {};

export interface StudyVaultFileDescriptor {
  path: string;
  name: string;
  extension: '.pdf' | '.txt';
  size: number;
}

export interface StudyVaultPdfEntry extends StudyVaultFileDescriptor {
  extension: '.pdf';
  relative_path: string;
}

export interface StudyVaultReadResult extends StudyVaultFileDescriptor {
  data: Uint8Array;
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

export interface StudyVaultAggregate {
  status: 'ok' | 'degraded' | 'error';
  ready: number;
  required_down: number;
  optional_down: number;
  total: number;
  required_down_names: string[];
}

export interface StudyVaultBootStatus {
  status: 'ok' | 'degraded' | 'error';
  launched: number;
  skipped: number;
  blocked: number;
  skipped_names: string[];
  blocked_names: string[];
  required_down_names: string[];
  degraded_reason: string;
}

type Unsubscribe = () => void;

declare global {
  interface Window {
    studyvault: Readonly<{
      runtime: Readonly<{
        info(): Promise<{
          app_version: string;
          electron_version: string;
          chrome_version: string;
          node_version: string;
          platform: 'win32' | 'darwin' | 'linux';
          arch: string;
          is_packaged: boolean;
        }>;
      }>;
      files: Readonly<{
        pickFolder(): Promise<string | null>;
        pickFiles(): Promise<StudyVaultFileDescriptor[]>;
        listPdfs(root: string): Promise<StudyVaultPdfEntry[]>;
        read(path: string): Promise<StudyVaultReadResult>;
      }>;
      sidecar: Readonly<{
        status(): Promise<StudyVaultSidecarStatus[]>;
        logs(name: string): Promise<string[]>;
        aggregate(): Promise<StudyVaultAggregate>;
      }>;
      keychain: Readonly<{
        set(secret: string): Promise<{ ok: true }>;
        get(): Promise<string | null>;
        delete(): Promise<{ ok: true }>;
      }>;
      openPath(path: string): Promise<{ opened: boolean; error: string }>;
      openExternal(url: string): Promise<{ opened: true }>;
      popout(options: { route: string; title?: string; width?: number; height?: number }): Promise<{ id: number }>;
      notification(options: { title: string; body: string }): Promise<{ shown: boolean }>;
      fullscreen: Readonly<{
        get(): Promise<boolean>;
        set(value: boolean): Promise<boolean>;
      }>;
      events: Readonly<{
        onBootStatus(listener: (event: StudyVaultBootStatus) => void): Unsubscribe;
        onSecondInstance(listener: (event: { argv: string[]; cwd: string; paths: string[] }) => void): Unsubscribe;
        onOpenFile(listener: (event: { paths: string[] }) => void): Unsubscribe;
        onPdfDrop(listener: (event: { paths: string[] }) => void): Unsubscribe;
      }>;
    }>;
  }
}
