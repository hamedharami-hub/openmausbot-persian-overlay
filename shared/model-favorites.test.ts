import { describe, expect, it } from "vitest";
import { favoriteModelsFirst, isModelFavorite, toggleModelFavorite, type ModelFavorite } from "./model-favorites.ts";

describe("model favorites", () => {
  it("toggles a provider/model pair without affecting a same-named model from another provider", () => {
    let favorites: ModelFavorite[] = [];
    favorites = toggleModelFavorite(favorites, "provider-a", "model-x");
    favorites = toggleModelFavorite(favorites, "provider-b", "model-x");
    expect(favorites).toEqual([
      { instanceId: "provider-a", model: "model-x" },
      { instanceId: "provider-b", model: "model-x" },
    ]);
    favorites = toggleModelFavorite(favorites, "provider-a", "model-x");
    expect(favorites).toEqual([{ instanceId: "provider-b", model: "model-x" }]);
    expect(isModelFavorite(favorites, "provider-a", "model-x")).toBe(false);
    expect(isModelFavorite(favorites, "provider-b", "model-x")).toBe(true);
  });

  it("puts only current-provider favorites first while preserving each group's catalog order", () => {
    const models = [{ id: "slow" }, { id: "best" }, { id: "cheap" }];
    const sorted = favoriteModelsFirst(models, "provider-a", [
      { instanceId: "provider-a", model: "best" },
      { instanceId: "provider-b", model: "cheap" },
      { instanceId: "provider-a", model: "slow" },
    ]);
    expect(sorted).toEqual({ favorites: [{ id: "slow" }, { id: "best" }], rest: [{ id: "cheap" }] });
  });
});
