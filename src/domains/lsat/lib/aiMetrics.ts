import { STORAGE_KEYS, getJSON, setJSON } from "./storage";

const K = STORAGE_KEYS.aiMetrics;

export interface AiMetrics {
  lastExplainMs: number | null;
  lastExplainAt: string | null;
}

const EMPTY: AiMetrics = { lastExplainMs: null, lastExplainAt: null };

export function getAiMetrics(): AiMetrics {
  return getJSON<AiMetrics>(K, EMPTY);
}

export function recordExplainLatency(ms: number): void {
  setJSON<AiMetrics>(K, {
    lastExplainMs: ms,
    lastExplainAt: new Date().toISOString(),
  });
}
