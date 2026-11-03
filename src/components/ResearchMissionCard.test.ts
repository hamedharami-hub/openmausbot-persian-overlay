import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { researchMission } from "@/lib/research-mission";
import type { Message } from "@/state/store";
import { ResearchMissionCard } from "./ResearchMissionCard";

type Mission = ReturnType<typeof researchMission>;
const fixture = vi.hoisted(() => ({ mission: vi.fn() }));
vi.mock("@/lib/research-mission", () => ({ researchMission: fixture.mission }));
vi.mock("@/lib/i18n", () => ({
  t: (key: string, params?: Record<string, string | number>) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`,
}));

const request: Message = {
  id: "request-1", role: "user", kind: "text", at: 1,
  text: "Compare these claims",
  research: { mode: "verify", depth: "deep", length: "short" },
};
let mission: Mission;
function render(currentRequest = request, messages: readonly Message[] = []) {
  return renderToStaticMarkup(createElement(ResearchMissionCard, { request: currentRequest, messages }));
}
function source(url: string, kinds: Array<"citation" | "tool-output" | "failed-attempt">): Mission["sources"][number] {
  return { url, hostname: "example.com", mentions: kinds.map((kind, index) => ({ messageId: `message-${index}`, kind, at: index + 1 })) };
}

beforeEach(() => {
  mission = {
    requestId: request.id, status: "unknown", sources: [], sourcesTruncated: false, toolCount: 0, failedToolCount: 0,
    outputCount: 0, hasUnattributedActivity: false,
  };
  fixture.mission.mockReset().mockImplementation(() => mission);
});

describe("ResearchMissionCard", () => {
  it("displays observation time separately from unverified page dates and never assumes a data date", () => {
    const entry = source("https://example.com/report", ["citation"]);
    entry.observations = [{ version: 1, source: "agent-browser-dom", url: entry.url, observedAt: 1_790_000_000_000,
      contentHash: "d".repeat(64), capturedChars: 1024, truncated: true, hashBasis: "scrubbed-dom-visible-text", requestedUrl: null,
      publishedAt: "2020-01-01" }];
    entry.references = [{ messageId: "answer", text: "The model claims <script>bad()</script> with this source", at: 3 }];
    mission.sources = [entry];
    const html = render();
    expect(html).toContain("research.mission.content.received");
    expect(html).toContain("research.mission.content.observedAt");
    expect(html).toContain("2020-01-01");
    expect(html).toContain("research.mission.content.partial");
    expect(html).toContain("research.mission.content.unknown");
    expect(html).toContain("research.mission.references.disclaimer");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("discloses incomplete older history instead of presenting full coverage", () => {
    const html = renderToStaticMarkup(createElement(ResearchMissionCard, { request, messages: [], partial: true }));
    expect(html).toContain("research.mission.partial");
  });
  it("uses the supplied request and readonly transcript, with a native collapsed disclosure", () => {
    const messages: readonly Message[] = Object.freeze([request]);
    const html = render(request, messages);
    expect(fixture.mission).toHaveBeenCalledWith(request, messages);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("Compare these claims");
    expect(html).toContain("research.mission.empty");
    expect(html).toContain("research.mission.disclaimer");
    expect(html).not.toContain("research.mission.unattributed");
  });

  it.each(["sending", "pending", "responded", "failed", "cancelled", "unknown"] as const)("shows only the helper's %s status", (status) => {
    mission.status = status;
    const html = render();
    expect(html).toContain(`research.mission.status.${status}`);
    expect(html.match(/research\.mission\.status\./g)).toHaveLength(1);
    expect(html).not.toMatch(/progressbar|animate-spin|\bCompleted\b|\bVerified\b|\bRead\b/);
  });

  it("keeps evidence kinds distinct, deduplicates badges, and uses safe external links", () => {
    mission.sources = [source("https://example.com/page?x=1&y=2", ["citation", "tool-output", "failed-attempt", "citation"])];
    mission.toolCount = 4;
    mission.failedToolCount = 1;
    mission.outputCount = 2;
    const html = render();
    for (const kind of ["citation", "tool-output", "failed-attempt"]) {
      expect(html.match(new RegExp(`research\\.mission\\.evidence\\.${kind}`, "g"))).toHaveLength(1);
    }
    expect(html).toContain('href="https://example.com/page?x=1&amp;y=2"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("&quot;tools&quot;:4,&quot;failed&quot;:1,&quot;outputs&quot;:2");
    expect(html).toContain("research.mission.disclaimer");
  });

  it("does not turn failed attempts into citations or tool-output evidence", () => {
    mission.sources = [source("https://example.com/failure", ["failed-attempt"])];
    const html = render();
    expect(html).toContain("research.mission.evidence.failed-attempt");
    expect(html).not.toContain("research.mission.evidence.citation");
    expect(html).not.toContain("research.mission.evidence.tool-output");
  });

  it("shows unattributed activity without assigning it to this request", () => {
    mission.hasUnattributedActivity = true;
    const html = render();
    expect(html).toContain("research.mission.unattributed");
    expect(html).toContain("research.mission.status.unknown");
    expect(html).toContain("research.mission.empty");
  });

  it("renders the objective as bounded plain text, never markdown or HTML", () => {
    const html = render({ ...request, text: `  <script>alert(1)</script> **bold**\n${"x".repeat(1000)}SECRET_TAIL` });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; **bold**");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("SECRET_TAIL");
    expect(html).toContain("…</p>");
    const objective = html.match(/<p dir="auto"[^>]*>(.*?)<\/p>/)?.[1];
    expect(objective?.replaceAll("&lt;", "<").replaceAll("&gt;", ">")).toHaveLength(280);
  });

  it("caps source rows and link labels while retaining the recorded URL count", () => {
    mission.sources = Array.from({ length: 45 }, (_, index) => source(`https://example.com/${index}/${"x".repeat(500)}`, ["citation"]));
    const html = render();
    expect(html.match(/<li\b/g)).toHaveLength(30);
    expect(html).toContain("research.mission.limited");
    expect(html).toContain("&quot;shown&quot;:30,&quot;count&quot;:45");
    expect(html).toContain("research.mission.urls {&quot;count&quot;:45}");
    expect(html).not.toContain(`https://example.com/30/`);
    const label = html.match(/<a [^>]*>(.*?)<\/a>/)?.[1];
    expect(label!.length).toBeLessThanOrEqual(283);
  });

  it("warns when extraction was bounded even if the visible source count is small", () => {
    mission.sourcesTruncated = true;
    expect(render()).toContain("research.mission.truncated");
    mission.sourcesTruncated = false;
    expect(render()).not.toContain("research.mission.truncated");
  });

  it("uses the real helper to keep neighboring unowned activity unknown and unattributed", async () => {
    const actual = await vi.importActual<typeof import("@/lib/research-mission")>("@/lib/research-mission");
    fixture.mission.mockImplementation(actual.researchMission);
    const unrelated: Message = {
      id: "unowned", role: "bot", kind: "text", at: 2,
      text: "See https://example.com/unowned", turnSucceeded: true,
    };
    const html = render({ ...request, requestPending: false }, [request, unrelated]);
    expect(html).toContain("research.mission.status.unknown");
    expect(html).toContain("research.mission.unattributed");
    expect(html).toContain("research.mission.empty");
    expect(html).not.toContain("example.com/unowned");
    expect(html).not.toContain("research.mission.status.responded");
  });

  it("uses the real helper's server-owned terminal metadata, not answer text, for responded", async () => {
    const actual = await vi.importActual<typeof import("@/lib/research-mission")>("@/lib/research-mission");
    fixture.mission.mockImplementation(actual.researchMission);
    const answer: Message = {
      id: "answer", role: "bot", kind: "text", at: 2,
      requestMessageId: request.id, text: "Done: https://example.com/owned",
    };
    const sent = { ...request, requestPending: false };
    expect(render(sent, [sent, answer])).toContain("research.mission.status.unknown");
    const html = render(sent, [sent, { ...answer, turnSucceeded: true }]);
    expect(html).toContain("research.mission.status.responded");
    expect(html).toContain("research.mission.evidence.citation");
    expect(html).toContain("research.mission.disclaimer");
    expect(render(request, [request, { ...answer, turnSucceeded: true }])).toContain("research.mission.status.unknown");
  });

  it("uses the real helper's truncation signal for a transcript with more than 30 URLs", async () => {
    const actual = await vi.importActual<typeof import("@/lib/research-mission")>("@/lib/research-mission");
    fixture.mission.mockImplementation(actual.researchMission);
    const answer: Message = {
      id: "answer", role: "bot", kind: "text", at: 2, requestMessageId: request.id,
      text: Array.from({ length: 35 }, (_, index) => `https://example.com/${index}`).join(" "),
    };
    const html = render(request, [request, answer]);
    expect(html.match(/<li\b/g)).toHaveLength(30);
    expect(html).toContain("research.mission.truncated");
  });

  it("does not render unsafe or malformed URLs as links", () => {
    mission.sources = [source("javascript:alert(1)", ["citation"]), source("not a URL", ["tool-output"])];
    const html = render();
    expect(html).not.toContain("<a ");
    expect(html).toContain("javascript:alert(1)");
  });
});
