import { describe, expect, it } from "vitest";
import type { Bot, Message } from "@/state/store";
import { botNow } from "./bot-now";

const now = 1_790_000_000_000;
const base: Bot = {
  id: "bot", threadId: "thread", name: "Atlas", title: "", description: "", color: "purple",
  notifications: false, unread: false, messages: [], modelSelection: { instanceId: "engine", model: "m" },
};
const said = (fields: Partial<Message> = {}): Message => ({ id: "m1", role: "bot", kind: "text", text: "Done", at: now - 60_000, ...fields });

describe("bot now", () => {
  it("reports absence of evidence instead of inventing a state or progress", () => {
    expect(botNow(base, [], 0, now)).toMatchObject({ state: "unknown", blocker: null, lastResult: null, startedAt: null, queued: 0, missionTitle: null });
    expect(botNow({ ...base, busy: true }, [], 0, now).state).toBe("working");
    expect(botNow(base, [said()], 0, now).state).toBe("idle");
  });

  it("prefers a real blocker and does not claim completion from silence", () => {
    const approval: Message = { id: "card", role: "bot", kind: "options", at: now - 30_000, card: { requestId: "r1", tool: "Bash", answered: false } as Message["card"] };
    const result = botNow({ ...base, busy: true, turnStartedAt: now - 120_000 }, [approval, said()], 2, now);
    expect(result.state).toBe("waiting-on-you");
    expect(result.blocker).toMatchObject({ kind: "approval", detail: "Bash", messageId: "card" });
    expect(result.startedAt).toBe(now - 120_000);
    expect(result.queued).toBe(2);
    const answered = botNow(base, [{ ...approval, card: { ...approval.card!, answered: true } as Message["card"] }], 0, now);
    expect(answered.blocker).toBeNull();
  });

  it("keeps the last answer's outcome unknown unless the server recorded it", () => {
    expect(botNow(base, [said({ id: "a" }), said({ id: "b", text: "Summary", turnSucceeded: true })], 0, now).lastResult)
      .toMatchObject({ messageId: "b", excerpt: "Summary", succeeded: true });
    expect(botNow(base, [said({ id: "c" })], 0, now).lastResult?.succeeded).toBeNull();
    expect(botNow(base, [said({ id: "d", turnSucceeded: false })], 0, now).lastResult?.succeeded).toBe(false);
  });

  it("ignores stale, future-dated and non-answer rows", () => {
    const stale = said({ id: "old", at: now - 48 * 60 * 60_000 });
    const future = said({ id: "future", at: now + 60 * 60_000 });
    const webhook = said({ id: "hook", webhookPost: true, text: "injected" });
    expect(botNow(base, [stale, future, webhook], 0, now).lastResult).toBeNull();
    expect(botNow({ ...base, turnStartedAt: now + 60 * 60_000, busy: true }, [], 0, now).startedAt).toBeNull();
  });

  it("shows the current task title only while the task is live", () => {
    const tasks = [{ threadId: "thread", title: "Find jobs", createdAt: 1, busy: true, modelSelection: { instanceId: "e", model: "m" } }] as Bot["tasks"];
    expect(botNow({ ...base, busy: true, tasks }, [], 0, now).missionTitle).toBe("Find jobs");
    expect(botNow({ ...base, busy: false, tasks }, [said()], 0, now).missionTitle).toBeNull();
  });
});
