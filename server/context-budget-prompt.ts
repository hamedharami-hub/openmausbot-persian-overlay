import type { EffectiveContextBudget } from "../shared/context-budget.ts";
import { planContextBudget, type ContextBudgetPlan, type ContextBudgetSegment } from "./context-budget-planner.ts";
import { isVolatilePromptSection, systemPromptFromSections, type PromptSection } from "./system-prompt.ts";

const OPTIONAL_PRIORITY: Readonly<Record<string, number>> = {
  "user-profile": 3,
  recall: 7,
  routine: 4,
  outstanding: 8,
  "team-memory": 6,
  recent: 2,
  memory: 9,
  skills: 6,
  "skill-instructions": 5,
  playbooks: 4,
  availability: 5,
};

export function estimateContextTokens(text: string): number {
  let asciiBytes = 0;
  let nonAsciiCharacters = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) asciiBytes++;
    else nonAsciiCharacters++;
  }
  return Math.ceil(asciiBytes / 4) + nonAsciiCharacters;
}

/** A local planning heuristic, not provider image tokenization or an actual usage measurement. */
export function estimateInputContextTokens(text: string, imageCount = 0): number {
  if (!Number.isSafeInteger(imageCount) || imageCount < 0) throw new Error("Invalid image count");
  return estimateContextTokens(text) + imageCount * 1_024;
}

export function budgetSystemPrompt(input: {
  sections: PromptSection[];
  budget: EffectiveContextBudget;
  modelWindow?: number;
  outputReservation: number;
  mandatoryContext?: Array<{ id: string; estimatedTokens: number }>;
}): { prompt: ReturnType<typeof systemPromptFromSections>; plan: ContextBudgetPlan } | { prompt: null; plan: ContextBudgetPlan } {
  const mandatory: ContextBudgetSegment[] = [];
  const optional: ContextBudgetSegment[] = [];
  let order = 0;
  for (const section of input.sections) {
    const priority = isVolatilePromptSection(section.id) ? OPTIONAL_PRIORITY[section.id] ?? 0 : undefined;
    const segment = {
      id: `prompt:${section.id}`,
      estimatedTokens: estimateContextTokens(section.text),
      priority: priority ?? 0,
      order: order++,
    };
    if (priority === undefined) mandatory.push(segment);
    else optional.push(segment);
  }
  for (const segment of input.mandatoryContext ?? []) {
    mandatory.push({ ...segment, id: `context:${segment.id}`, priority: 0, order: order++ });
  }
  const plan = planContextBudget({
    budget: input.budget,
    ...(input.modelWindow !== undefined ? { modelWindow: input.modelWindow } : {}),
    outputReservation: input.outputReservation,
    mandatory,
    optional,
  });
  if (plan.mandatoryOverflow) return { prompt: null, plan };
  const included = new Set(plan.includedIds);
  const sections = input.sections.filter((section) => included.has(`prompt:${section.id}`));
  return { prompt: systemPromptFromSections(sections), plan };
}

export function requireBudgetedSystemPrompt(
  result: ReturnType<typeof budgetSystemPrompt>,
): NonNullable<ReturnType<typeof systemPromptFromSections> | null> {
  if (result.prompt) return result.prompt;
  throw new Error(
    `Required system context exceeds this chat's configured input budget (local estimate ${result.plan.estimatedIncludedTokens} > ${result.plan.inputCeiling} tokens). The conversation turn was blocked before dispatch to the selected model; a separate summarization job may still have run. Increase the context budget or reduce required instructions and memories.`,
  );
}
