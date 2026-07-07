const DEFAULT_WORKER_THRESHOLD = 750_000;
export const DEFAULT_JSON_FILE_MAX_BYTES = 100 * 1024 * 1024;

interface JsonWorkerMessage {
  ok?: boolean;
  payload?: unknown;
  error?: string;
}

function parseJsonInWorker(text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jsonParseWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<JsonWorkerMessage>) => {
      worker.terminate();
      if (event.data?.ok) {
        resolve(event.data.payload);
      } else {
        reject(new Error(event.data?.error || 'Unable to parse JSON file.'));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      reject(new Error(event.message || 'Unable to parse JSON file.'));
    };
    worker.postMessage({ text });
  });
}

export interface ParseJsonOptions {
  workerThreshold?: number;
  maxBytes?: number;
}

export interface ParseJsonResult {
  payload: unknown;
  sizeBytes: number;
  parsedInWorker: boolean;
}

export async function parseJsonFile(
  file: File,
  {
    workerThreshold = DEFAULT_WORKER_THRESHOLD,
    maxBytes = DEFAULT_JSON_FILE_MAX_BYTES,
  }: ParseJsonOptions = {},
): Promise<ParseJsonResult> {
  if (typeof file.size === 'number' && file.size > maxBytes) {
    throw new Error(`JSON file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`);
  }
  const text = await file.text();
  const sizeBytes = file.size ?? new Blob([text]).size;
  if (sizeBytes > maxBytes) {
    throw new Error(`JSON file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`);
  }
  const canUseWorker = typeof Worker !== 'undefined' && text.length >= workerThreshold;
  return {
    payload: canUseWorker ? await parseJsonInWorker(text) : JSON.parse(text),
    sizeBytes,
    parsedInWorker: canUseWorker,
  };
}
