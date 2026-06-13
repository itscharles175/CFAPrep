/** Optional Tauri plugins — declared so the web/CI build type-checks without installing them. */
declare module "@tauri-apps/plugin-dialog" {
  export function open(options: unknown): Promise<string | string[] | null>;
}

declare module "@tauri-apps/plugin-fs" {
  export function readFile(path: string): Promise<Uint8Array>;
}
