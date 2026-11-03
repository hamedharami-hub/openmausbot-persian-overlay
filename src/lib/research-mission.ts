import type { Message } from "@/state/store";
import type { ResearchContentReceipt } from "../../shared/research-evidence";

export type ResearchMissionStatus = "sending" | "pending" | "responded" | "failed" | "cancelled" | "unknown";
export interface ResearchSourceMention { messageId: string; kind: "citation" | "tool-output" | "failed-attempt"; at: number }
export interface ResearchAnswerReference { messageId: string; text: string; at: number }
export interface ResearchSource {
  url: string;
  hostname: string;
  mentions: ResearchSourceMention[];
  observations?: ResearchContentReceipt[];
  references?: ResearchAnswerReference[];
}
export interface ResearchMission {
  requestId: string;
  status: ResearchMissionStatus;
  sources: ResearchSource[];
  sourcesTruncated: boolean;
  toolCount: number;
  failedToolCount: number;
  outputCount: number;
  hasUnattributedActivity: boolean;
}
const MAX_SOURCES = 30;
const MAX_TEXT = 64_000;
const MAX_SCAN = 512_000;

function publicUrl(raw: string): URL | null {
  const trimmed = raw.replace(/[.,;!?،؛؟]+$/u, "");
  let value = trimmed;
  while (/[)\]}]$/u.test(value)) {
    const close = value.at(-1)!;
    const open = close === ")" ? "(" : close === "]" ? "[" : "{";
    if (value.split(close).length <= value.split(open).length) break;
    value = value.slice(0, -1);
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/u.test(host)
      || /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
      || host === "::1" || host.includes(":")) return null;
    const tracking: string[] = [];
    for (const key of url.searchParams.keys()) {
      if (/^(?:key|api[-_]?key|x-goog-api-key|token|access[-_]?token|secret|password|authorization|signature|x-amz-signature)$/iu.test(key)) return null;
      if (/^utm_|^(?:fbclid|gclid)$/iu.test(key)) tracking.push(key);
    }
    for (const key of tracking) url.searchParams.delete(key);
    url.hash = "";
    return url;
  } catch { return null; }
}

/** Only server-proven requestMessageId ownership counts; neighboring text is not evidence of ownership. */
export function researchMission(request: Message, messages: readonly Message[]): ResearchMission {
  const owned = messages.filter((message) => message.role === "bot" && message.requestMessageId === request.id);
  const terminal = owned.filter((message) => message.turnSucceeded !== undefined).at(-1);
  const status: ResearchMissionStatus = request.requestCancelled ? "cancelled"
    : request.id.startsWith("optimistic-") ? "sending"
    : request.requestPending === true ? "pending"
    : terminal?.turnSucceeded === false ? "failed"
    : request.requestPending === false && terminal?.turnSucceeded === true ? "responded"
    : "unknown";
  const sources = new Map<string, ResearchSource>();
  let sourcesTruncated = false, scanned = 0;
  const sourceFor = (raw: string): ResearchSource | null => {
    const url = publicUrl(raw);
    if (!url) return null;
    const existing = sources.get(url.href);
    if (!existing && sources.size >= MAX_SOURCES) { sourcesTruncated = true; return null; }
    const source: ResearchSource = existing ?? { url: url.href, hostname: url.hostname, mentions: [] };
    sources.set(url.href, source);
    return source;
  };
  const add = (text: string | undefined, message: Message, kind: ResearchSourceMention["kind"]) => {
    if (!text) return;
    if (scanned >= MAX_SCAN) { sourcesTruncated = true; return; }
    const budget = Math.min(MAX_TEXT, MAX_SCAN - scanned);
    const sample = text.slice(0, budget);
    if (sample.length < text.length) sourcesTruncated = true;
    scanned += sample.length;
    for (const match of sample.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
      const source = sourceFor(match[0]);
      if (!source) continue;
      if (source.mentions.length < 6 && !source.mentions.some((mention) => mention.messageId === message.id && mention.kind === kind)) {
        source.mentions.push({ messageId: message.id, kind, at: message.at });
      }
      if (kind === "citation") {
        const start = Math.max(sample.lastIndexOf("\n", match.index) + 1, match.index - 240);
        const lineEnd = sample.indexOf("\n", match.index);
        const end = Math.min(lineEnd < 0 ? sample.length : lineEnd, match.index + match[0].length + 160);
        const text = sample.slice(start, end).replace(/\[([^\]]{0,160})\]\(https?:\/\/[^)]+\)/giu, "$1")
          .replace(/https?:\/\/[^\s<>"'`]+/giu, "").replace(/\s+/gu, " ").trim().slice(0, 350);
        const references = source.references ?? (source.references = []);
        if (text.length >= 16 && references.length < 4 && !references.some((ref) => ref.messageId === message.id && ref.text === text)) {
          references.push({ messageId: message.id, text, at: message.at });
        }
      }
    }
  };
  for (const message of owned) {
    const receipt = message.researchContent;
    if (receipt?.version === 1 && receipt.source === "agent-browser-dom" && receipt.hashBasis === "scrubbed-dom-visible-text"
      && /^[a-f0-9]{64}$/u.test(receipt.contentHash) && Number.isInteger(receipt.capturedChars) && receipt.capturedChars > 0
      && receipt.capturedChars <= 200_000 && Number.isFinite(receipt.observedAt) && receipt.observedAt > 0 && receipt.observedAt <= 8_640_000_000_000_000) {
      const source = sourceFor(receipt.url);
      if (source) {
        const observations = source.observations ?? (source.observations = []);
        if (!observations.some((value) => value.contentHash === receipt.contentHash && value.observedAt === receipt.observedAt)) {
          if (observations.length < 6) observations.push(receipt);
          else sourcesTruncated = true;
        }
      }
    }
    if (message.kind === "text" && !message.webhookPost) add(message.text, message, "citation");
    if (message.tool?.ok === true) add(message.tool.output, message, "tool-output");
    if (message.tool?.ok === false) add(message.tool.input, message, "failed-attempt");
  }
  const index = messages.findIndex((message) => message.id === request.id);
  const later = index < 0 ? [] : messages.slice(index + 1);
  const nextUser = later.findIndex((message) => message.role === "user");
  const neighborhood = nextUser < 0 ? later : later.slice(0, nextUser);
  return {
    requestId: request.id, status, sources: [...sources.values()], sourcesTruncated,
    toolCount: owned.filter((message) => message.tool).length,
    failedToolCount: owned.filter((message) => message.tool?.ok === false).length,
    outputCount: owned.filter((message) => message.kind === "text" && Boolean(message.text?.trim()) && !message.webhookPost).length,
    hasUnattributedActivity: neighborhood.some((message) => message.role === "bot" && !message.requestMessageId),
  };
}
