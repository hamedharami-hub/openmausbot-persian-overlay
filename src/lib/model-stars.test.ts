import { describe, expect, it } from "vitest";
import { modelStarKey, parseModelStars, starredModelsFirst } from "./model-stars";

describe("model stars", () => {
  it("keeps provider order within starred and unstarred models without mutating the catalog", () => {
    const options = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const stars = new Set([modelStarKey("go", "d"), modelStarKey("go", "b"), modelStarKey("other", "a")]);
    expect(starredModelsFirst(options, "go", stars).map((option) => option.id)).toEqual(["b", "d", "a", "c"]);
    expect(options.map((option) => option.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores malformed persisted preferences and avoids ambiguous keys", () => {
    expect([...parseModelStars("null")]).toEqual([]);
    expect([...parseModelStars("invalid")]).toEqual([]);
    expect([...parseModelStars('["one",false,"one",42]')]).toEqual(["one"]);
    expect(modelStarKey("a/b", "c")).not.toBe(modelStarKey("a", "b/c"));
  });
});
