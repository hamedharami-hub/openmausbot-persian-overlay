import { describe, expect, it } from "vitest";
import { compactSidebarLabel } from "./sidebar-labels";

describe("sidebar label", () => {
  it("keeps the short form of a two-language name and leaves the rest for the tooltip", () => {
    expect(compactSidebarLabel("انتشار و تحلیل (Growth)")).toEqual({ label: "انتشار و تحلیل", rest: "انتشار و تحلیل (Growth)" });
  });

  it("leaves a name without parentheses alone", () => {
    expect(compactSidebarLabel("Portal Publish")).toEqual({ label: "Portal Publish", rest: "" });
  });

  it("keeps a name whose parentheses are part of the word", () => {
    expect(compactSidebarLabel("Bot (v2)")).toEqual({ label: "Bot (v2)", rest: "" });
    expect(compactSidebarLabel("(only in brackets)")).toEqual({ label: "(only in brackets)", rest: "" });
  });

  it("cuts the Persian gloss of a Latin name the same way", () => {
    expect(compactSidebarLabel("Portal Publish (انتشار)")).toEqual({ label: "Portal Publish", rest: "Portal Publish (انتشار)" });
  });

  it("does not cut a very long bracket", () => {
    const long = `x (${"y".repeat(90)})`;
    expect(compactSidebarLabel(long)).toEqual({ label: long, rest: "" });
  });
});
