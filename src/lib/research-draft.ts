import { useSyncExternalStore } from "react";
import type { ResearchRequest } from "../../shared/research-request";

const key = "omb-research-drafts";
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
function snapshot(id: string): string {
  if (memory.has(id)) return memory.get(id)!;
  try {
    const values = JSON.parse(localStorage.getItem(key) ?? "{}");
    const value = values[id];
    if (value && ["research", "verify", "report"].includes(value.mode)
      && ["standard", "deep"].includes(value.depth) && ["short", "normal", "long"].includes(value.length)) return JSON.stringify(value);
  } catch { /* storage unavailable */ }
  return "null";
}
export function getDraftResearch(id: string): ResearchRequest | null {
  return JSON.parse(snapshot(id)) as ResearchRequest | null;
}
export function setDraftResearch(id: string, value: ResearchRequest | null): void {
  memory.set(id, JSON.stringify(value));
  try {
    const values = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (value) values[id] = value;
    else delete values[id];
    localStorage.setItem(key, JSON.stringify(values));
  } catch { /* in-memory selection remains usable */ }
  for (const notify of listeners) notify();
}
export function useDraftResearch(id: string): [ResearchRequest | null, (value: ResearchRequest | null) => void] {
  const serialized = useSyncExternalStore((notify) => {
    listeners.add(notify);
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      memory.clear();
      notify();
    };
    window.addEventListener("storage", changed);
    return () => { listeners.delete(notify); window.removeEventListener("storage", changed); };
  }, () => snapshot(id), () => "null");
  return [JSON.parse(serialized) as ResearchRequest | null, (value) => setDraftResearch(id, value)];
}
