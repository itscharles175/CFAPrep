/** Coach recommendation inbox — snooze/done (R4-A3). */

import { STORAGE_KEYS, getJSON, setJSON } from "./storage";

const K_INBOX = STORAGE_KEYS.recommendationInbox;

export interface InboxItem {
  id: string;
  label: string;
  to: string;
  minutes: number;
  source: "coach" | "srs" | "weak-type" | "br";
  snoozedUntil?: string;
  done?: boolean;
}

export function getInboxItems(): InboxItem[] {
  const arr = getJSON<InboxItem[]>(K_INBOX, []);
  return Array.isArray(arr) ? arr : [];
}

export function setInboxItems(items: InboxItem[]): void {
  setJSON(K_INBOX, items);
}

export function mergeInboxItems(incoming: InboxItem[]): InboxItem[] {
  const existing = getInboxItems();
  const byId = new Map(existing.map((i) => [i.id, i]));
  for (const item of incoming) {
    const prev = byId.get(item.id);
    if (prev?.done) continue;
    if (prev?.snoozedUntil && prev.snoozedUntil > new Date().toISOString()) {
      byId.set(item.id, prev);
    } else {
      byId.set(item.id, { ...prev, ...item, done: prev?.done });
    }
  }
  const merged = [...byId.values()].filter(
    (i) =>
      !i.done &&
      (!i.snoozedUntil || i.snoozedUntil <= new Date().toISOString()),
  );
  setInboxItems(merged);
  return merged;
}

export function markInboxDone(id: string): void {
  const items = getInboxItems().map((i) =>
    i.id === id ? { ...i, done: true } : i,
  );
  setInboxItems(items);
}

export function snoozeInbox(id: string, hours = 24): void {
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  const items = getInboxItems().map((i) =>
    i.id === id ? { ...i, snoozedUntil: until } : i,
  );
  setInboxItems(items);
}
