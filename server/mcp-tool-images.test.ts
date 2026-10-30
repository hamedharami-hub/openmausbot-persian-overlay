import { describe, expect, it } from "vitest";
import { extractMcpImages } from "./mcp-tool-images.ts";

describe("extractMcpImages", () => {
  it("pulls image blocks out of a raw content array, ignoring text", () => {
    const content = [
      { type: "text", text: "ok" },
      { type: "image", data: "abc123", mimeType: "image/png" },
    ];
    expect(extractMcpImages(content)).toEqual([{ type: "image", data: "abc123", mimeType: "image/png" }]);
  });

  it("pulls image blocks out of a { content: [...] } wrapper", () => {
    const result = { content: [{ type: "image", data: "xyz", mimeType: "image/jpeg" }], isError: false };
    expect(extractMcpImages(result)).toEqual([{ type: "image", data: "xyz", mimeType: "image/jpeg" }]);
  });

  it("returns [] for text-only, missing, or malformed input", () => {
    expect(extractMcpImages([{ type: "text", text: "ok" }])).toEqual([]);
    expect(extractMcpImages(undefined)).toEqual([]);
    expect(extractMcpImages({ content: [{ type: "image", data: 5, mimeType: "image/png" }] })).toEqual([]);
  });

  it("normalizes Anthropic API image blocks (Claude CLI's tool_result shape)", () => {
    const content = [
      { type: "text", text: "ok" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "def456" } },
    ];
    expect(extractMcpImages(content)).toEqual([{ data: "def456", mimeType: "image/jpeg" }]);
  });

  it("extracts OpenCode ACP tool-result images from content blocks", () => {
    const result = [
      { type: "content", content: { type: "text", text: "Generated image" } },
      { type: "content", content: { type: "image", data: "jpeg-bytes", mimeType: "image/jpeg" } },
    ];
    expect(extractMcpImages(result)).toEqual([{ type: "image", data: "jpeg-bytes", mimeType: "image/jpeg" }]);
  });

  it("does not interpret arbitrary nested objects, resource links or malformed ACP content as images", () => {
    expect(extractMcpImages([
      { type: "resource_link", content: { type: "image", data: "private", mimeType: "image/png" } },
      { type: "content", content: null },
      { type: "content", content: { type: "image", data: 123, mimeType: "image/png" } },
      { type: "content", content: { type: "content", content: { type: "image", data: "nested", mimeType: "image/png" } } },
    ])).toEqual([]);
  });
});
