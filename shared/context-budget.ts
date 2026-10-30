import { z } from "zod";

export const contextBudgetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z.object({ mode: z.enum(["economy", "balanced", "full"]) }).strict(),
  z.object({ mode: z.literal("custom"), inputTokens: z.number().int().positive().max(10_000_000) }).strict(),
]);
export type ContextBudget = z.infer<typeof contextBudgetSchema>;
export type EffectiveContextBudget = Exclude<ContextBudget, { mode: "inherit" }>;

export function contextBudgetInputLimit(modelWindow: number, budget: EffectiveContextBudget): number {
  if (!Number.isSafeInteger(modelWindow) || modelWindow < 1) throw new Error("Invalid model context window");
  if (budget.mode === "custom") return Math.min(modelWindow, budget.inputTokens);
  const ratio = budget.mode === "economy" ? 0.25 : budget.mode === "balanced" ? 0.5 : 1;
  return Math.max(1, Math.floor(modelWindow * ratio));
}

export function resolveContextBudget(botDefault?: ContextBudget, threadOverride?: ContextBudget): {
  budget: EffectiveContextBudget; source: "thread" | "bot" | "default";
} {
  if (threadOverride && threadOverride.mode !== "inherit") return { budget: { ...threadOverride }, source: "thread" };
  if (botDefault && botDefault.mode !== "inherit") return { budget: { ...botDefault }, source: "bot" };
  return { budget: { mode: "balanced" }, source: "default" };
}
