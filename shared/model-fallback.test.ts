import { describe, expect, it } from "vitest";
import { availableFallbackModels, canAddFallbackModel, MAX_MODEL_FALLBACKS, moveFallbackModel } from "./model-fallback.ts";

const instance = (instanceId: string, displayName: string, models: string[], state: "available" | "unavailable" = "available") => ({
  instanceId, displayName, snapshot: { state },
  models: { default: models[0] ?? "", options: models.map(id => ({ id, label: `${displayName} / ${id}` })) },
});

describe("model fallbacks", () => {
  it("offers distinct models from the same provider and from other providers", () => {
    const choices = availableFallbackModels([
      instance("deepseek", "DeepSeek account", ["deepseek-chat", "deepseek-reasoner"]),
      instance("luna", "Luna", ["gpt-6-luna"]),
      instance("offline", "Offline", ["offline-model"], "unavailable"),
    ], { instanceId: "deepseek", model: "deepseek-chat" }, []);

    expect(choices.map(({ instanceId, model }) => [instanceId, model])).toEqual([
      ["deepseek", "deepseek-reasoner"], ["luna", "gpt-6-luna"],
    ]);
  });

  it("excludes exact duplicate pairs while allowing another model from that same instance", () => {
    const choices = availableFallbackModels([instance("provider", "Provider", ["m1", "m2"])],
      { instanceId: "primary", model: "m0" }, [{ instanceId: "provider", model: "m1" }]);
    expect(choices.map(choice => choice.model)).toEqual(["m2"]);
  });

  it("caps new choices at four backups and keeps a legacy fifth entry visible", () => {
    const four = Array.from({ length: MAX_MODEL_FALLBACKS }, (_, i) => ({ instanceId: `p${i}`, model: `m${i}` }));
    expect(canAddFallbackModel(four)).toBe(false);
    expect(canAddFallbackModel([...four, { instanceId: "legacy", model: "old" }])).toBe(false);
    expect(availableFallbackModels([instance("new", "New", ["new-model"])], { instanceId: "primary", model: "p" }, four)).toHaveLength(1);
  });

  it("reorders an explicit chain without changing a boundary move", () => {
    const chain = [
      { instanceId: "a", model: "one" },
      { instanceId: "b", model: "two" },
      { instanceId: "c", model: "three" },
    ];
    expect(moveFallbackModel(chain, 2, -1)).toEqual([chain[0], chain[2], chain[1]]);
    expect(moveFallbackModel(chain, 0, -1)).toEqual(chain);
  });
});
