import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { researchMission } from "./research-mission";
const request: Message = { id: "request", role: "user", kind: "text", text: "Find current evidence", at: 1, research: { mode: "research", depth: "deep", length: "short" } };
const response = (fields: Partial<Message> = {}): Message => ({ id: "response", role: "bot", kind: "text", requestMessageId: request.id, at: 2, ...fields });

describe("research mission receipts", () => {
  it("never infers completion from prose, neighboring messages, or missing ownership", () => {
    const modelClaim = response({ text: "Verified 100 pages. All done! https://example.org/claim", requestMessageId: undefined, turnSucceeded: true });
    const mission = researchMission(request, [request, modelClaim]);
    expect(mission.status).toBe("unknown"); expect(mission.sources).toEqual([]);
    expect(mission.toolCount).toBe(0); expect(mission.hasUnattributedActivity).toBe(true);
  });
  it("uses request lifecycle metadata rather than model claims", () => {
    const terminal = response({ turnSucceeded: true, turnTerminal: true });
    expect(researchMission({ ...request, requestPending: true }, [terminal]).status).toBe("pending");
    expect(researchMission({ ...request, requestPending: false }, [terminal]).status).toBe("responded");
    expect(researchMission(request, [terminal]).status).toBe("unknown");
    expect(researchMission(request, [response({ turnSucceeded: false })]).status).toBe("failed");
    expect(researchMission({ ...request, requestCancelled: true, requestPending: true }, [terminal]).status).toBe("cancelled");
    expect(researchMission({ ...request, id: "optimistic-one" }, []).status).toBe("sending");
  });
  it("separates reply mentions, successful tool references and failed attempts", () => {
    const rows = [request,
      response({ text: "See [source](https://example.org/a?utm_source=search#part)." }),
      response({ id: "tool", kind: "activity", tool: { name: "some-tool", ok: true, output: "https://example.org/a" } }),
      response({ id: "failure", kind: "activity", tool: { name: "fetch", ok: false, input: "https://example.net/missing", output: "https://example.net/error" } }),
      response({ id: "other", requestMessageId: "other-request", text: "https://example.com/not-ours" }),
    ];
    const mission = researchMission(request, rows);
    expect(mission.sources).toHaveLength(2);
    expect(mission.sources[0]!.mentions.map((m) => m.kind)).toEqual(["citation", "tool-output"]);
    expect(mission.sources[1]!.mentions[0]!.kind).toBe("failed-attempt");
    expect(mission.toolCount).toBe(2); expect(mission.failedToolCount).toBe(1); expect(mission.outputCount).toBe(1);
    expect(mission.sources.some((s) => s.mentions.some((m) => (m.kind as string) === "read"))).toBe(false);
  });
  it("rejects credential-bearing or internal URLs and ignores webhook prose", () => {
    const mission = researchMission(request, [request, response({ text: "http://localhost/a http://127.0.0.1/a http://10.0.0.1/a https://user:pass@example.org/ https://example.org/?api_key=secret javascript:alert(1) https://example.org/safe" }), response({ id: "webhook", webhookPost: true, text: "https://example.net/untrusted" })]);
    expect(mission.sources.map((s) => s.url)).toEqual(["https://example.org/safe"]);
  });
  it("bounds source count and signals truncation instead of reporting full coverage", () => {
    const text = Array.from({ length: 100 }, (_, i) => `https://example.org/page/${i}`).join(" ");
    const mission = researchMission(request, [response({ text })]);
    expect(mission.sources).toHaveLength(30); expect(mission.sourcesTruncated).toBe(true);
  });
  it("ignores unowned rows from older requests and does not attribute the next request", () => {
    const next = { ...request, id: "next" };
    expect(researchMission(request, [request, next, response({ requestMessageId: undefined })]).hasUnattributedActivity).toBe(false);
  });
});
