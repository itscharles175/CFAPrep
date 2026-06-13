/** Per-route scroll positions (Round 2 — avoid remounting main on navigation). */
import { getRaw, setRaw } from "./storage";

const PREFIX = "lsatlab.scroll.";

export function saveScroll(path: string, y: number) {
  setRaw(PREFIX + path, String(y), "session");
}

export function restoreScroll(path: string): number {
  const raw = getRaw(PREFIX + path, "session");
  return raw ? Number(raw) : 0;
}
