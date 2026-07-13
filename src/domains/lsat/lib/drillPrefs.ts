import { STORAGE_KEYS, getRaw, remove, setRaw } from "./storage";

const K = STORAGE_KEYS.drillTimeCapMin;

/** Client-side drill time cap (minutes); section runner reads when set. */
export function getDrillTimeCapMin(): number | null {
  const raw = getRaw(K);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setDrillTimeCapMin(min: number | null): void {
  if (min == null) remove(K);
  else setRaw(K, String(min));
}
