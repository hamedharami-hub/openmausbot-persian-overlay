import { describe, expect, it } from "vitest";
import { clientInstanceCatalog } from "./instance-catalog-access.ts";

describe("member model catalog", () => {
  it("preserves selectable models and effort while excluding account and runtime secrets", () => {
    const catalog = clientInstanceCatalog([{
      instanceId: "go", driverKind: "opencode", displayName: "OpenCode Go", cli: "/private/bin/engine",
      authentication: { userCode: "PRIVATE" }, endpointUrl: "https://private.internal",
      snapshot: { state: "available", authenticated: true, account: { email: "PRIVATE" }, reason: "PRIVATE", update: { command: "PRIVATE" } },
      models: { default: "deepseek", options: [{ id: "deepseek", label: "DeepSeek", provider: "go", contextWindow: 128000,
        secret: "PRIVATE", variants: [{ id: "high", label: "High", secret: "PRIVATE" }] }] },
      capabilities: { images: true, modelVariants: true, effortLevels: ["low", "high"], secret: "PRIVATE" },
    }]);
    expect(catalog).toEqual([{
      instanceId: "go", driverKind: "opencode", displayName: "OpenCode Go",
      snapshot: { state: "available", authenticated: true },
      models: { default: "deepseek", options: [{ id: "deepseek", label: "DeepSeek", provider: "go", contextWindow: 128000, variants: [{ id: "high", label: "High" }] }] },
      capabilities: { images: true, modelVariants: true, effortLevels: ["low", "high"] },
    }]);
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE");
  });
  it("fails closed for malformed entries without mutating the source", () => {
    expect(clientInstanceCatalog(null)).toEqual([]);
    expect(clientInstanceCatalog([null, [], {}, { instanceId: "a" }])).toEqual([]);
    const source = { instanceId: "a", driverKind: "fake", models: { options: [null, {}, { id: "x", label: "X" }] } };
    expect(clientInstanceCatalog([source])).toMatchObject([{ models: { default: "", options: [{ id: "x", label: "X" }] } }]);
    expect(source.models.options).toHaveLength(3);
  });
});
