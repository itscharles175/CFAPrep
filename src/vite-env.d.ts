/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AI_ENABLED: string;
  readonly VITE_SYNC_ENABLED: string;
  readonly VITE_ANALYTICS_VERBOSE: string;
  readonly VITE_DEFAULT_CFA_LEVEL: string;
  readonly VITE_CONTENT_RUNTIME_MODE: string;
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
