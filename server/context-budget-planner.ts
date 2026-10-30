import type { EffectiveContextBudget } from "../shared/context-budget.ts";

export interface ContextBudgetSegment {
  id: string;
  estimatedTokens: number;
  priority: number;
  order: number;
}

/** Local allocation estimates are never provider usage or a billing measurement. */
export interface ContextBudgetPlan {
  inputCeiling: number;
  modelWindow: number;
  windowSource: "model-metadata" | "conservative-8k-estimate";
  measurement: "local-estimate";
  estimatedIncludedTokens: number;
  mandatoryOverflow: boolean;
  status: "ready" | "mandatory-overflow";
  includedIds: string[];
  omittedIds: string[];
}

function tokens(value: number, name: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(`Invalid ${name}`);
  return value;
}

export function planContextBudget(input: {
  budget: EffectiveContextBudget;
  modelWindow?: number;
  outputReservation: number;
  mandatory: ContextBudgetSegment[];
  optional: ContextBudgetSegment[];
}): ContextBudgetPlan {
  const windowKnown = input.modelWindow !== undefined;
  const modelWindow = windowKnown ? tokens(input.modelWindow!, "model window", true) : 8192;
  const available = Math.max(0, modelWindow - tokens(input.outputReservation, "output reservation"));
  const ratio = input.budget.mode === "economy" ? 0.25 : input.budget.mode === "balanced" ? 0.5 : 1;
  const inputCeiling = input.budget.mode === "custom"
    ? Math.min(available, tokens(input.budget.inputTokens, "custom input cap", true))
    : Math.floor(available * ratio);
  const all = [...input.mandatory, ...input.optional];
  const ids = new Set<string>();
  for (const segment of all) {
    if (!segment.id || ids.has(segment.id)) throw new Error("Segment IDs must be unique and nonempty");
    ids.add(segment.id);
    tokens(segment.estimatedTokens, "segment estimate");
    if (!Number.isFinite(segment.priority) || !Number.isFinite(segment.order)) throw new Error("Invalid segment ranking");
  }
  const mandatoryTotal = input.mandatory.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
  if (!Number.isSafeInteger(mandatoryTotal)) throw new Error("Invalid mandatory total");
  const mandatoryOverflow = mandatoryTotal > inputCeiling;
  const included = new Set(input.mandatory.map(segment => segment.id));
  let estimatedIncludedTokens = mandatoryTotal;
  if (!mandatoryOverflow) {
    for (const segment of [...input.optional].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
      if (segment.estimatedTokens <= inputCeiling - estimatedIncludedTokens) {
        included.add(segment.id);
        estimatedIncludedTokens += segment.estimatedTokens;
      }
    }
  }
  return {
    inputCeiling, modelWindow,
    windowSource: windowKnown ? "model-metadata" : "conservative-8k-estimate",
    measurement: "local-estimate", estimatedIncludedTokens, mandatoryOverflow,
    status: mandatoryOverflow ? "mandatory-overflow" : "ready",
    includedIds: all.filter(segment => included.has(segment.id)).sort((a, b) => a.order - b.order).map(segment => segment.id),
    omittedIds: input.optional.filter(segment => !included.has(segment.id)).map(segment => segment.id),
  };
}
