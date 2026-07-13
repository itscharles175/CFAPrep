/** Recent command-palette destinations (R4-H12). */

import { STORAGE_KEYS, getJSON, setJSON } from "./storage";
import { canonicalRoutePath, routeCommandLabelFromManifest } from "./routeManifest";

const K_RECENTS = STORAGE_KEYS.commandRecents;
const MAX = 8;

export function routeCommandLabel(path: string): string {
  const label = routeCommandLabelFromManifest(path);
  if (label) return label;
  if (path === "/review/history") return "Session history";
  if (path.startsWith("/analytics/type/")) return "Type analytics";
  if (path.startsWith("/take/")) return "Timed section";
  if (path.startsWith("/exam/")) return "Full exam";
  return path;
}

export function getCommandRecents(): string[] {
  const arr = getJSON<string[]>(K_RECENTS, []);
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  return arr
    .map((path) => canonicalRoutePath(path))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

export function pushCommandRecent(path: string): void {
  const canonical = canonicalRoutePath(path);
  const prev = getCommandRecents().filter((p) => p !== canonical);
  const next = [canonical, ...prev].slice(0, MAX);
  setJSON(K_RECENTS, next);
}
