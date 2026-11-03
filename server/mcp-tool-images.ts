export interface McpImageContent {
  data: string;
  mimeType: string;
}

const asMcpImage = (raw: unknown): McpImageContent | null => {
  const c = (raw as { type?: unknown; content?: unknown } | null)?.type === "content" &&
    (raw as { content?: unknown }).content &&
    typeof (raw as { content?: unknown }).content === "object"
    ? (raw as { content: Record<string, unknown> }).content
    : (raw as Record<string, unknown> | null);
  if (!c || typeof c !== "object" || c.type !== "image" || typeof c.data !== "string") return null;
  const mimeType = typeof c.mimeType === "string"
    ? c.mimeType
    : typeof c.mime_type === "string"
      ? c.mime_type
      : "image/jpeg";
  return { data: c.data, mimeType };
};

// Claude CLI hands MCP images over in Anthropic Messages shape ({type:"image", source:{type:"base64", media_type, data}});
// codex/acp pass the MCP-native {type, data, mimeType} through.
const asAnthropicImage = (c: unknown): McpImageContent | null => {
  const source = (c as { type?: unknown; source?: unknown } | null)?.type === "image"
    ? (c as { source?: unknown }).source
    : null;
  if (!source || typeof source !== "object") return null;
  const { type, media_type, data } = source as { type?: unknown; media_type?: unknown; data?: unknown };
  return type === "base64" && typeof media_type === "string" && typeof data === "string"
    ? { data, mimeType: media_type }
    : null;
};

const asImageBlock = (c: unknown): McpImageContent | null => asMcpImage(c) ?? asAnthropicImage(c);

export function extractMcpImages(value: unknown): McpImageContent[] {
  const arr = Array.isArray(value)
    ? value
    : Array.isArray((value as { content?: unknown } | null)?.content)
      ? (value as { content: unknown[] }).content
      : null;
  return arr ? arr.map(asImageBlock).filter((v): v is McpImageContent => v !== null) : [];
}
