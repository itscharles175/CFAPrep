const DEFAULT_WORKER_THRESHOLD = 750_000;

function parseJsonInWorker(text) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jsonParseWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data?.ok) {
        resolve(event.data.payload);
      } else {
        reject(new Error(event.data?.error || 'Unable to parse JSON file.'));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Unable to parse JSON file.'));
    };
    worker.postMessage({ text });
  });
}

export async function parseJsonFile(file, { workerThreshold = DEFAULT_WORKER_THRESHOLD } = {}) {
  const text = await file.text();
  const canUseWorker = typeof Worker !== 'undefined' && text.length >= workerThreshold;
  return {
    payload: canUseWorker ? await parseJsonInWorker(text) : JSON.parse(text),
    sizeBytes: file.size ?? new Blob([text]).size,
    parsedInWorker: canUseWorker,
  };
}
