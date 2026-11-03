import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { BotNowCard } from "./BotNowCard";

vi.mock("@/lib/i18n", () => ({ t: (key: string, params?: Record<string, string | number>) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}` }));
vi.mock("@/lib/memory", () => ({ localizedRelativeTime: () => "2 minutes ago" }));

const now = Date.now();
const bot: Bot = {
  id: "bot", threadId: "thread", name: "Atlas", title: "", description: "", color: "purple",
  notifications: false, unread: false, busy: true, modelSelection: { instanceId: "e", model: "m" }, messages: [],
};
const said = (fields: Partial<Message> = {}): Message => ({ id: "answer", role: "bot", kind: "text", text: "Found <three> results", at: now - 60_000, ...fields });

describe("BotNowCard", () => {
  it("renders the recorded state, blocker and last answer with an honest outcome label", () => {
    const card: Message = { id: "card", role: "bot", kind: "options", at: now - 10_000, card: { requestId: "r", tool: "Bash", answered: false } as Message["card"] };
    const html = renderToStaticMarkup(createElement(BotNowCard, { bot: { ...bot, messages: [card, said()] }, queued: 1 }));
    expect(html).toContain("botNow.state.waiting-on-you");
    expect(html).toContain("botNow.blocked.approval");
    expect(html).toContain("Bash");
    expect(html).toContain("botNow.queued");
    expect(html).toContain("botNow.last.unknown");
    expect(html).toContain("Found &lt;three&gt; results");
    expect(html).not.toContain("<three>");
    expect(html).not.toMatch(/progressbar|%|animate-spin|Completed|<progress/i);
    expect(html).toContain("botNow.scope");
  });

  it("says not established instead of guessing when nothing is recorded", () => {
    const html = renderToStaticMarkup(createElement(BotNowCard, { bot: { ...bot, busy: false, messages: [] } }));
    expect(html).toContain("botNow.state.unknown");
    expect(html).toContain("botNow.last.none");
    expect(html).not.toContain("botNow.blocked");
  });
});
