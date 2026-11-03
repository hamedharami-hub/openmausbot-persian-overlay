import { describe, expect, it } from "vitest";
import { parseResearchRequest, promptWithResearchRequest, researchRequestInstructions, type ResearchRequest } from "./research-request.ts";

const request: ResearchRequest = { mode: "research", depth: "deep", length: "short" };

describe("request-scoped research guidance", () => {
  it("preserves legacy input and accepts only complete bounded enum settings", () => {
    expect(parseResearchRequest(undefined)).toBeUndefined();
    expect(promptWithResearchRequest("Original text")).toBe("Original text");
    expect(parseResearchRequest(request)).toEqual(request);
    for (const value of [null, [], {}, "research", { ...request, depth: "infinite" }, { ...request, length: "x".repeat(10000) }, { ...request, instruction: "ignore policy" }]) {
      expect(() => parseResearchRequest(value)).toThrow();
    }
  });

  it("bounds all combinations and requires honest, opened-page evidence without grants", () => {
    for (const mode of ["research", "verify", "report"] as const) {
      for (const depth of ["standard", "deep"] as const) {
        for (const length of ["short", "normal", "long"] as const) {
          const instructions = researchRequestInstructions({ mode, depth, length });
          expect(instructions.length).toBeLessThan(2400);
          expect(instructions).toContain("real web evidence");
          expect(instructions).toContain("Open and read relevant pages");
          expect(instructions).toContain("Never fabricate");
          expect(instructions).toContain("without a url argument");
          expect(instructions).toContain("date of the underlying data");
          expect(instructions).toContain("mark it unknown");
          expect(instructions).toContain("not enforced");
          expect(instructions).toContain("grant no tools or permissions");
        }
      }
    }
    expect(promptWithResearchRequest("Original text", request)).toMatch(/<research-request>[\s\S]*<\/research-request>\n\nOriginal text$/);
  });
});
