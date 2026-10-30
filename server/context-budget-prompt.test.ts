import { describe, expect, it } from "vitest";
import { budgetSystemPrompt, estimateContextTokens, estimateInputContextTokens, requireBudgetedSystemPrompt } from "./context-budget-prompt.ts";
import type { PromptSection } from "./system-prompt.ts";

const sections: PromptSection[] = [
  { id: "persona", label: "Identity", text: "identity", bytes: 8 },
  { id: "soul", label: "Standing instructions", text: "safety", bytes: 8 },
  { id: "memory", label: "Memory", text: "M".repeat(400), bytes: 400 },
  { id: "recent", label: "Recent work", text: "R".repeat(200), bytes: 200 },
];

describe("budgetSystemPrompt", () => {
  it("estimates Persian text and reserves a disclosed local allowance for each image", () => {
    expect(estimateContextTokens("سلام")).toBe(4);
    expect(estimateInputContextTokens("hello", 2)).toBe(2050);
    expect(() => estimateInputContextTokens("hello", -1)).toThrow(/image count/);
  });

  it("keeps required sections and reconstructs the prompt halves", () => {
    const result = budgetSystemPrompt({ sections, budget: { mode: "full" }, modelWindow: 8192, outputReservation: 256 });
    expect(result.prompt?.text).toContain("identity");
    expect(result.prompt?.text).toContain("safety");
    expect(result.prompt?.stable).toBe("identitysafety");
    expect(result.prompt?.volatile).toHaveLength(600);
    expect(result.plan.measurement).toBe("local-estimate");
  });

  it("never drops stable prompt sections just to meet a smaller target", () => {
    const mixed = [...sections, { id: "team-memory", label: "Team memory", text: "standing memory", bytes: 14 }];
    const result = budgetSystemPrompt({ sections: mixed, budget: { mode: "economy" }, modelWindow: 4096, outputReservation: 512 });
    expect(result.prompt?.sections.map(section => section.id)).toContain("team-memory");
    expect(result.prompt?.stable).toContain("standing memory");
  });

  it("uses a conservative local estimate for Persian context text", () => {
    const result = budgetSystemPrompt({ sections: sections.slice(0, 2).concat({
      id: "memory", label: "Memory", text: "سلام", bytes: 8,
    }), budget: { mode: "full" }, modelWindow: 8192, outputReservation: 256 });
    expect(result.plan.estimatedIncludedTokens).toBe(8);
  });

  it("drops complete low-priority segments before higher-priority segments", () => {
    const result = budgetSystemPrompt({
      sections,
      budget: { mode: "custom", inputTokens: 100 },
      modelWindow: 8192,
      outputReservation: 64,
    });
    expect(result.prompt?.sections.map((section) => section.id)).toEqual(["persona", "soul", "recent"]);
    expect(result.plan.omittedIds).toContain("prompt:memory");
    expect(result.plan.omittedIds).not.toContain("prompt:recent");
  });

  it("refuses to produce a prompt if mandatory context exceeds the budget", () => {
    const result = budgetSystemPrompt({
      sections,
      budget: { mode: "custom", inputTokens: 10 },
      modelWindow: 8192,
      outputReservation: 64,
      mandatoryContext: [{ id: "conversation", estimatedTokens: 100 }],
    });
    expect(result.prompt).toBeNull();
    expect(result.plan.status).toBe("mandatory-overflow");
    expect(() => requireBudgetedSystemPrompt(result)).toThrow(/conversation turn was blocked before dispatch/);
  });

  it("labels unknown model windows as conservative estimates", () => {
    const result = budgetSystemPrompt({ sections: sections.slice(0, 2), budget: { mode: "balanced" }, outputReservation: 256 });
    expect(result.plan).toMatchObject({ windowSource: "conservative-8k-estimate", measurement: "local-estimate" });
  });
});
