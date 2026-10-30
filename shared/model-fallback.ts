export interface FallbackModel {
  instanceId: string;
  model: string;
}

export interface FallbackModelInstance {
  instanceId: string;
  displayName: string;
  snapshot: { state: "available" | "unavailable" };
  models: { default: string; options: Array<{ id: string; label: string }> };
}

export const MAX_MODEL_FALLBACKS = 4;

export function sameFallbackModel(a: FallbackModel, b: FallbackModel): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

/** Build choices from the live catalog. The same provider may appear more than once with different models. */
export function availableFallbackModels(
  instances: readonly FallbackModelInstance[],
  primary: FallbackModel,
  chain: readonly FallbackModel[],
): Array<FallbackModel & { displayName: string; modelLabel: string }> {
  const choices: Array<FallbackModel & { displayName: string; modelLabel: string }> = [];
  for (const instance of instances) {
    if (instance.snapshot.state !== "available") continue;
    const models = [
      ...(instance.models.default ? [{ id: instance.models.default, label: instance.models.default }] : []),
      ...instance.models.options,
    ];
    const seen = new Set<string>();
    for (const model of models) {
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      const candidate = { instanceId: instance.instanceId, model: model.id };
      if (sameFallbackModel(candidate, primary) || chain.some((entry) => sameFallbackModel(entry, candidate))) continue;
      choices.push({ ...candidate, displayName: instance.displayName, modelLabel: model.label || model.id });
    }
  }
  return choices;
}

export function canAddFallbackModel(chain: readonly FallbackModel[]): boolean {
  return chain.length < MAX_MODEL_FALLBACKS;
}

export function moveFallbackModel(chain: readonly FallbackModel[], index: number, delta: -1 | 1): FallbackModel[] {
  const target = index + delta;
  if (index < 0 || index >= chain.length || target < 0 || target >= chain.length) return [...chain];
  const next = [...chain];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
