import { describe, expect, it } from "vitest";
import { researchCommand, typedResearchCommand } from "./research-commands";

describe("request-scoped research commands", () => {
  it("chooses independent depth and length defaults", () => {
    expect(researchCommand("research")).toEqual({ mode: "research", depth: "deep", length: "normal" });
    expect(researchCommand("verify")?.length).toBe("normal");
    expect(researchCommand("report")?.length).toBe("long");
    expect(researchCommand("goal")).toBeNull();
  });
  it("parses explicit commands without leaking slash syntax to the model", () => {
    expect(typedResearchCommand("/research جدیدترین قانون را بررسی کن")).toEqual({ research: researchCommand("research"), text: "جدیدترین قانون را بررسی کن" });
    expect(typedResearchCommand("/VERIFY\ncheck dates")?.text).toBe("check dates");
    expect(typedResearchCommand("/report")?.text).toBe("");
  });
  it("does not intercept ordinary prose or other skill names", () => {
    for (const text of ["/researcher topic", "Please /verify this", "hello", "/research-custom topic"]) expect(typedResearchCommand(text)).toBeNull();
  });
});
