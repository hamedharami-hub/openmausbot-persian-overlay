import { describe, expect, it } from "vitest";
import type { Message } from "./store.ts";
import { roomSummaryHistory } from "./room-summary.ts";

const row = (id: string, fields: Partial<Message> = {}): Message => ({ id, at: 1, role: "user", kind: "text", text: `Message ${id}`, ...fields });

describe("room summary history", () => {
  it("retains recent lines outside the fold and marks important older sources", () => {
    const messages = Array.from({ length: 9 }, (_, i) => row(String(i), i === 0 ? { important: true } : {}));
    const fold = roomSummaryHistory(messages)!;
    expect(fold.history).toHaveLength(6);
    expect(fold.history[0]).toMatchObject({ id: "0", important: true });
    expect(fold.foldedThroughId).toBe("5");
    expect(fold.firstKeptId).toBe("6");
  });

  it("uses the previous valid summary instead of folding represented source lines again", () => {
    const messages = [row("old"), row("kept1"), row("kept2"), row("summary", { kind: "compaction", text: undefined,
      compaction: { summary: "Earlier facts", firstKeptId: "kept1", foldedThroughId: "old", tokensBefore: 100, by: "person" } }), row("new")];
    const fold = roomSummaryHistory(messages)!;
    expect(fold.history.map(entry => entry.id)).toEqual(["summary", "kept1"]);
    expect(fold.history[0]!.text).toBe("Earlier facts");
  });

  it("ignores a stale summary whose anchor disappeared", () => {
    const messages = [row("summary", { kind: "compaction", text: undefined,
      compaction: { summary: "STALE", firstKeptId: "gone", foldedThroughId: "gone", tokensBefore: 100, by: "person" } }), row("a"), row("b"), row("c")];
    const fold = roomSummaryHistory(messages)!;
    expect(fold.history.map(entry => entry.id)).toEqual(["a"]);
    expect(fold.history.some(entry => entry.text.includes("STALE"))).toBe(false);
  });

  it("preserves native teammate result text rather than folding an empty activity line", () => {
    const messages = [row("result", { role: "bot", kind: "activity", text: undefined, roomRequest: { id: "r1", phase: "result" } }), row("b"), row("c")];
    const fold = roomSummaryHistory(messages, request => `Verified result for ${request}`)!;
    expect(fold.history[0]!.text).toBe("Verified result for r1");
  });

  it("does not replace a short conversation with an empty summary", () => {
    expect(roomSummaryHistory([row("a"), row("b")])).toBeNull();
  });
});
