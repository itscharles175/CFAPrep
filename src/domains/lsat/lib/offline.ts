import { getQueueDepth, subscribeQueue } from "./offlineQueue";

let offline = false;
const listeners = new Set<() => void>();

export function setOfflineMode(v: boolean): void {
  if (offline === v) return;
  offline = v;
  refreshStatusSnapshot();
  listeners.forEach((l) => l());
}

export function getOfflineSnapshot(): boolean {
  return offline;
}

export function subscribeOffline(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Cache the combined-status object so useSyncExternalStore sees a stable
// reference between renders. Returning a fresh object literal on every call
// causes "getSnapshot should be cached" warnings and an infinite render loop.
export interface OfflineStatus {
  offline: boolean;
  queueDepth: number;
}

let statusSnapshot: OfflineStatus = { offline, queueDepth: 0 };

function refreshStatusSnapshot(): boolean {
  const next: OfflineStatus = { offline, queueDepth: getQueueDepth() };
  if (
    next.offline === statusSnapshot.offline &&
    next.queueDepth === statusSnapshot.queueDepth
  ) {
    return false;
  }
  statusSnapshot = next;
  return true;
}

// Initialise once at module load so the first render has the real queue depth.
refreshStatusSnapshot();

/** Combined offline flag + pending write queue depth for banners. */
export function getOfflineStatus(): OfflineStatus {
  return statusSnapshot;
}

export function subscribeOfflineStatus(cb: () => void): () => void {
  const handler = () => {
    if (refreshStatusSnapshot()) cb();
  };
  const unsubOffline = subscribeOffline(handler);
  const unsubQueue = subscribeQueue(handler);
  return () => {
    unsubOffline();
    unsubQueue();
  };
}
