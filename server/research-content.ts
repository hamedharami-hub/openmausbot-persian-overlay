import { createHash } from "node:crypto";
import type { ResearchContentReceipt } from "../shared/research-evidence.ts";
import type { PageState } from "./browser-tool-shape.ts";

export interface ResearchContentOwner { threadId: string; generation: string; turnId: string }
export type ContentReceived = (owner: ResearchContentOwner, receipt: ResearchContentReceipt) => void;

export function publicResearchUrl(raw: string): string | null {
  if (raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    // Literal IPs and internal names are not public-source evidence; no DNS or network is used for admission.
    if (!host.includes(".") || host.includes(":") || /^[\d.]+$/u.test(host)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|onion|arpa)$/u.test(host)) return null;
    for (const [key, value] of url.searchParams) {
      if (/(?:token|secret|password|passwd|authorization|credential|signature|session|auth|api.?key|^key$|^code$|^sig$)/iu.test(key)
        || /@|bearer\s/iu.test(value)) return null;
    }
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function researchContentReceipt(page: PageState, scrub: (text: string) => string): ResearchContentReceipt | null {
  const url = publicResearchUrl(page.url);
  if (!url || scrub(url) !== url) return null;
  const scrubbed = scrub(page.text);
  const text = scrubbed.slice(0, 200_000);
  if (!text.trim()) return null;
  const pageDate = (raw: string | undefined): string | undefined => {
    if (!raw || raw.length > 120 || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/u.test(raw) || !Number.isFinite(Date.parse(raw))) return undefined;
    return scrub(raw) === raw ? raw : undefined;
  };
  const publishedAt = pageDate(page.publishedAt), modifiedAt = pageDate(page.modifiedAt);
  return {
    version: 1, source: "agent-browser-dom", url, observedAt: Date.now(),
    contentHash: createHash("sha256").update(text).digest("hex"), capturedChars: text.length,
    truncated: page.truncated === true || page.text.length > 200_000 || scrubbed.length > 200_000,
    hashBasis: "scrubbed-dom-visible-text", requestedUrl: null,
    ...(publishedAt ? { publishedAt } : {}), ...(modifiedAt ? { modifiedAt } : {}),
  };
}

export function ownsResearchContent(owner: ResearchContentOwner, active: string | undefined,
  request: { generation: string; turnId: string | null; stopped?: boolean } | undefined): boolean {
  return active === owner.generation && request?.generation === owner.generation &&
    request.turnId === owner.turnId && !request.stopped;
}
