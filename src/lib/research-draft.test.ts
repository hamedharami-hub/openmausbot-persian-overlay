// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { getDraftResearch, setDraftResearch } from "./research-draft";
import { draftRevision, getDraft, markDraftEdited, recoverFailedComposerSend } from "./drafts";

const research = { mode: "research", depth: "deep", length: "short" } as const;
describe("research draft isolation and recovery", () => {
  it("isolates each draft and clears after sending", () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    setDraftResearch(a, research);
    expect(getDraftResearch(a)).toEqual(research);
    expect(getDraftResearch(b)).toBeNull();
    setDraftResearch(a, null);
    expect(getDraftResearch(a)).toBeNull();
  });
  it("restores the original request options after a failed send", () => {
    const draftId = crypto.randomUUID();
    const sent = { draftId, revision: draftRevision(draftId), sendId: "retry", text: "Check dates", requestText: "Check dates", threadId: "thread", attachments: [], research };
    setDraftResearch(draftId, null);
    expect(recoverFailedComposerSend(sent)).toBe("restored");
    expect(getDraftResearch(draftId)).toEqual(research);
    expect(getDraft(localStorage, draftId)).toBe("Check dates");
  });
  it("does not replace a newer draft's research options on late failure", () => {
    const draftId = crypto.randomUUID();
    const revision = draftRevision(draftId);
    const next = { mode: "report", depth: "standard", length: "long" } as const;
    markDraftEdited(draftId); setDraftResearch(draftId, next);
    expect(recoverFailedComposerSend({ draftId, revision, sendId: "old", text: "old", requestText: "old", threadId: "t", attachments: [], research })).toBe("outbox");
    expect(getDraftResearch(draftId)).toEqual(next);
  });
});
