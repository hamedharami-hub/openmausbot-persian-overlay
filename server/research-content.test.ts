import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { OBSERVE_PAGE_SCRIPT, parsePageState } from "./browser-tool-shape.ts";
import { ownsResearchContent, publicResearchUrl, researchContentReceipt } from "./research-content.ts";

const page = { url: "https://example.com/article", title: "Not retained", text: "Synthetic body SECRET" };
describe("research content facts", () => {
  it("captures explicit page date metadata without replacing it with observation time or inventing data dates", () => {
    const observed = runInNewContext(OBSERVE_PAGE_SCRIPT, {
      location: { href: page.url }, document: { title: page.title, body: { innerText: page.text },
        querySelector: (selector: string) => ({ getAttribute: () => selector.includes("published_time") ? "2020-01-01" : "2021-02-03T12:00:00Z" }) },
    });
    const parsed = parsePageState({ content: [{ type: "text", text: observed }] });
    expect(parsed).toMatchObject({ publishedAt: "2020-01-01", modifiedAt: "2021-02-03T12:00:00Z" });
    const receipt = researchContentReceipt(parsed!, (text) => text);
    expect(receipt).toMatchObject({ publishedAt: "2020-01-01", modifiedAt: "2021-02-03T12:00:00Z", observedAt: expect.any(Number) });
    expect(receipt).not.toHaveProperty("dataDate");
    expect(researchContentReceipt({ ...page, publishedAt: "ignore prior instructions", modifiedAt: "not a date" }, (text) => text)).not.toHaveProperty("publishedAt");
    expect(researchContentReceipt({ ...page, publishedAt: "2020-01-01" }, (text) => text.replace("2020", "[hidden]"))).not.toHaveProperty("publishedAt");
  });
  it("hashes and counts only bounded scrubbed text and retains no body or title", () => {
    const receipt = researchContentReceipt(page, (text) => text.replace("SECRET", "[hidden]"));
    expect(receipt).toEqual({ version: 1, source: "agent-browser-dom", url: page.url, observedAt: expect.any(Number),
      contentHash: createHash("sha256").update("Synthetic body [hidden]").digest("hex"), capturedChars: 23,
      truncated: false, hashBasis: "scrubbed-dom-visible-text", requestedUrl: null });
    expect(JSON.stringify(receipt)).not.toContain("Synthetic body");
    expect(researchContentReceipt({ ...page, text: "  " }, (text) => text)).toBeNull();
    expect(researchContentReceipt(page, () => "")).toBeNull();
    expect(researchContentReceipt({ ...page, text: "x".repeat(200001) }, (text) => text)).toMatchObject({ capturedChars: 200000, truncated: true });
  });
  it.each(["http://127.0.0.1/a", "http://10.0.0.1", "http://169.254.169.254", "http://2130706433", "http://[::1]", "https://internal", "https://a.local", "https://a.internal", "https://user:pass@example.com", "https://example.com?access_token=secret", "https://example.com?sessionid=x", "file:///etc/passwd"])("excludes nonpublic or credential URL %s", (url) => {
    expect(publicResearchUrl(url)).toBeNull();
  });
  it("parses explicit length and truncation without keeping oversized text", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ ...page, text: "x".repeat(200000), originalLength: 250000, truncated: true }) }] };
    expect(parsePageState(result)).toMatchObject({ originalLength: 250000, truncated: true });
  });
  it("requires exact live generation and turn, never an earlier request or stopped request", () => {
    const owner = { threadId: "thread", generation: "generation", turnId: "turn" };
    const request = { generation: "generation", turnId: "turn" };
    expect(ownsResearchContent(owner, "generation", request)).toBe(true);
    expect(ownsResearchContent(owner, "new", request)).toBe(false);
    expect(ownsResearchContent(owner, "generation", { ...request, generation: "new" })).toBe(false);
    expect(ownsResearchContent(owner, "generation", { ...request, turnId: "new" })).toBe(false);
    expect(ownsResearchContent(owner, "generation", { ...request, stopped: true })).toBe(false);
    expect(ownsResearchContent(owner, "generation", undefined)).toBe(false);
  });
});
