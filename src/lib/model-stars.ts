import { useSyncExternalStore } from "react";

const STORAGE_KEY = "omb.model-stars";
const EVENT = "omb:model-stars";

export const modelStarKey = (instanceId: string, modelId: string): string => JSON.stringify([instanceId, modelId]);

function snapshot(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? "[]"; } catch { return "[]"; }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function parseModelStars(value: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch { return new Set(); }
}

export function useModelStars(): ReadonlySet<string> {
  return parseModelStars(useSyncExternalStore(subscribe, snapshot, () => "[]"));
}

export function toggleModelStar(instanceId: string, modelId: string): void {
  const stars = new Set(parseModelStars(snapshot()));
  const key = modelStarKey(instanceId, modelId);
  if (stars.has(key)) stars.delete(key);
  else stars.add(key);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...stars])); } catch { return; }
  window.dispatchEvent(new Event(EVENT));
}

export function starredModelsFirst<T extends { id: string }>(options: readonly T[], instanceId: string, stars: ReadonlySet<string>): T[] {
  return [...options].sort((a, b) => Number(stars.has(modelStarKey(instanceId, b.id))) - Number(stars.has(modelStarKey(instanceId, a.id))));
}
