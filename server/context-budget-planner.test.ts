import { describe, expect, it } from "vitest";
import { contextBudgetInputLimit, contextBudgetSchema, resolveContextBudget } from "../shared/context-budget.ts";
import { planContextBudget, type ContextBudgetSegment } from "./context-budget-planner.ts";

const segment = (id: string, estimatedTokens: number, priority = 0, order = 0): ContextBudgetSegment =>
  ({ id, estimatedTokens, priority, order });
const base = { budget: { mode: "full" as const }, outputReservation: 1024, mandatory: [], optional: [] };

describe("context budget inheritance", () => {
  it("resolves independent thread overrides without mutating the bot", () => {
    const bot = { mode: "custom" as const, inputTokens: 3000 };
    const first = resolveContextBudget(bot, { mode: "economy" });
    const second = resolveContextBudget(bot, { mode: "inherit" });
    expect(first).toEqual({ budget: { mode: "economy" }, source: "thread" });
    expect(second).toEqual({ budget: bot, source: "bot" });
    expect(second.budget).not.toBe(bot);
    expect(resolveContextBudget({ mode: "inherit" })).toEqual({ budget: { mode: "balanced" }, source: "default" });
    expect(bot.inputTokens).toBe(3000);
  });
  it("rejects ambiguous custom caps and unrelated summary settings", () => {
    for (const value of [{ mode: "custom" }, { mode: "custom", inputTokens: 0 }, { mode: "full", maxBytes: 4096 }]) {
      expect(contextBudgetSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("context budget input targets", () => {
  it("scales with each member model and clamps custom caps", () => {
    expect(contextBudgetInputLimit(200_000, { mode: "economy" })).toBe(50_000);
    expect(contextBudgetInputLimit(200_000, { mode: "balanced" })).toBe(100_000);
    expect(contextBudgetInputLimit(200_000, { mode: "full" })).toBe(200_000);
    expect(contextBudgetInputLimit(32_000, { mode: "custom", inputTokens: 50_000 })).toBe(32_000);
    expect(contextBudgetInputLimit(200_000, { mode: "custom", inputTokens: 8_000 })).toBe(8_000);
  });
});

describe("whole segment context planning", () => {
  it("labels an unknown window conservatively and never reports provider usage", () => {
    const plan = planContextBudget(base);
    expect(plan).toMatchObject({ modelWindow: 8192, inputCeiling: 7168, windowSource: "conservative-8k-estimate", measurement: "local-estimate" });
    expect(plan).not.toHaveProperty("providerUsage");
    expect(plan).not.toHaveProperty("cost");
  });
  it("recalculates for a smaller fallback window and reserves output first", () => {
    expect(planContextBudget({ ...base, modelWindow: 4096 }).inputCeiling).toBe(3072);
    expect(planContextBudget({ ...base, modelWindow: 512 }).inputCeiling).toBe(0);
    expect(planContextBudget({ ...base, modelWindow: 8192, budget: { mode: "economy" } }).inputCeiling).toBe(1792);
    expect(planContextBudget({ ...base, modelWindow: 8192, budget: { mode: "balanced" } }).inputCeiling).toBe(3584);
  });
  it("clamps custom caps to the effective model window", () => {
    expect(planContextBudget({ ...base, modelWindow: 4096, budget: { mode: "custom", inputTokens: 5000 } }).inputCeiling).toBe(3072);
    expect(planContextBudget({ ...base, budget: { mode: "custom", inputTokens: 1200 } }).inputCeiling).toBe(1200);
  });
  it("preserves mandatory segments and explicitly blocks overflow", () => {
    const plan = planContextBudget({ ...base, modelWindow: 2048, mandatory: [segment("system", 700), segment("request", 600)], optional: [segment("history", 10)] });
    expect(plan).toMatchObject({ status: "mandatory-overflow", mandatoryOverflow: true, estimatedIncludedTokens: 1300, includedIds: ["system", "request"], omittedIds: ["history"] });
  });
  it("allocates by priority, breaks ties by order, and never slices a segment", () => {
    const optional = [segment("low", 300, 0, 1), segment("later", 400, 2, 4), segment("earlier", 400, 2, 3), segment("too-large", 2000, 3, 2)];
    const original = structuredClone(optional);
    const plan = planContextBudget({ ...base, modelWindow: 2048, mandatory: [segment("request", 100, 0, 0)], optional });
    expect(plan.includedIds).toEqual(["request", "earlier", "later"]);
    expect(plan.omittedIds).toEqual(["low", "too-large"]);
    expect(plan.estimatedIncludedTokens).toBe(900);
    expect(optional).toEqual(original);
  });
  it("rejects invalid estimates, duplicate IDs and invalid windows", () => {
    expect(() => planContextBudget({ ...base, optional: [segment("bad", -1)] })).toThrow();
    expect(() => planContextBudget({ ...base, mandatory: [segment("same", 1)], optional: [segment("same", 1)] })).toThrow();
    expect(() => planContextBudget({ ...base, modelWindow: 0 })).toThrow();
  });
});
