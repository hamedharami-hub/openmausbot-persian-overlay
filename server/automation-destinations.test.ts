import { expect, it, vi } from "vitest";
import { createAutomationDestinations } from "./automation-destinations.ts";
import type { Routine } from "./routines.ts";

it("reports a routine created in a private chat back into that chat instead of the bot's shared main thread", () => {
  const destinations = createAutomationDestinations({
    store: {
      bot: () => ({ id: "bot-1", hidden: false }),
      createTask: vi.fn(() => ({ threadId: "unexpected-new-thread" })),
      taskByThread: () => undefined,
      messagesFor: () => [],
    } as never,
    mainThread: () => "shared-main-thread",
    runs: () => [],
    privateOwner: (threadId) => threadId === "account-a-thread" ? "p_account_a" : undefined,
    cloud: null,
  });
  const routine = {
    id: "routine-1", name: "Private reminder", prompt: "Summarize this chat.", target: "bot", botId: "bot-1",
    runOn: "maus", enabled: false, schedule: { type: "once", at: 1 }, durationMinutes: 30,
    sourceThreadId: "account-a-thread", nextRunAt: null, createdAt: 1, updatedAt: 1,
  } satisfies Routine;

  expect(destinations.routine(routine, false)).toEqual({ threadId: "account-a-thread" });
});
