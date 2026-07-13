/**
 * J7: Typed environment configuration.
 * All Vite environment variables are accessed through this module
 * so the rest of the codebase never touches `import.meta.env` directly.
 */

function bool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return value === 'true' || value === '1';
}

export const env = {
  /** Enable AI tutor provider (WebLLM / Ollama / API) */
  aiEnabled: bool(import.meta.env.VITE_AI_ENABLED),

  /** Enable cloud sync backend */
  syncEnabled: bool(import.meta.env.VITE_SYNC_ENABLED),

  /** Verbose analytics logging to console */
  analyticsVerbose: bool(import.meta.env.VITE_ANALYTICS_VERBOSE),

  /** Default CFA level for new users */
  defaultCfaLevel: (import.meta.env.VITE_DEFAULT_CFA_LEVEL as string) || 'level1',

  /** Content runtime mode */
  contentRuntimeMode: (import.meta.env.VITE_CONTENT_RUNTIME_MODE as string) || 'generated',

  /** App version from build */
  appVersion: (import.meta.env.VITE_APP_VERSION as string) || '0.0.0',

  /** Whether running in production mode */
  isProd: import.meta.env.PROD as boolean,

  /** Whether running in development mode */
  isDev: import.meta.env.DEV as boolean,
} as const;
