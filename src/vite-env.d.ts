/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AI_ENABLED: string;
  readonly VITE_SYNC_ENABLED: string;
  readonly VITE_ANALYTICS_VERBOSE: string;
  readonly VITE_DEFAULT_CFA_LEVEL: string;
  readonly VITE_CONTENT_RUNTIME_MODE: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_LSAT_API_BASE?: string;
  readonly VITE_LSATLAB_LOCAL_API_TOKEN?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
