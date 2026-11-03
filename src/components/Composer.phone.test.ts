// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  liveCall: null as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-gemini-configured", () => ({ useGeminiVoiceConfigured: () => true }));
vi.mock("./GeminiLiveConversation", () => ({ GeminiLiveConversation: () => createElement("button", { "data-gemini-live": "" }, "Live") }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: (props: Record<string, unknown>) => {
  fixture.groupCall = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [bot.id, peer.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [],
};

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const plus = () => container.querySelector<HTMLElement>("[data-composer-plus]")?.closest("button") ?? null;
const menu = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const item = (key: string) => document.body.querySelector<HTMLButtonElement>(`[data-menu-key="${key}"]`);
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
function openPlus() {
  click(plus());
  expect(menu()).not.toBeNull();
}

beforeEach(() => {
  fixture.advanced = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 767.98px"), addEventListener() {}, removeEventListener() {} }));
  fixture.liveCall = null;
  setCallMode("turns");
  fixture.call = null;
  fixture.groupCall = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of [`bot:${bot.id}:${bot.threadId}`, `group:${room.id}:${room.threadId}`]) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the phone composer", () => {
  it("keeps + inside the single pill without a separate ring or built-in call", () => {
    render({ bot });
    expect(plus()).not.toBeNull();
    expect(plus()?.closest("[data-composer-row]")).not.toBeNull();
    expect(plus()?.closest('[data-tour="composer"]')?.className).toContain("rounded-[26px]");
    expect(plus()?.closest('[data-tour="composer"]')?.className).toContain("[&_[data-composer-plus]]:ring-0");
    expect(container.querySelector("textarea")?.hasAttribute("placeholder")).toBe(false);
    expect(fixture.call).toBeNull();
    expect(fixture.groupCall).toBeNull();
    expect(container.querySelector("[data-gemini-live]")).not.toBeNull();
  });

  it("keeps attachment and send available inside the phone pill", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello phone", attachments: [] });
    render({ bot });
    openPlus();
    click(item("attach"));
    expect(picker).toHaveBeenCalledOnce();
    click(container.querySelector('button[aria-label="Send message"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "hello phone" }));
    expect(container.querySelector("textarea")!.value).toBe("");
  });

  it("moves Advanced mode's row of buttons into the +", () => {
    fixture.advanced = true;
    render({ bot });
    expect(container.querySelector('button[aria-label="Attach a file"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Ask for approval for"]')).toBeNull();
    expect(container.querySelector('[data-testid="place-chip"]')).toBeNull();
    expect(fixture.call).toBeNull();
    expect(plus()?.closest("[data-composer-row]")).not.toBeNull();
    openPlus();
    const keys = [...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"));
    expect(keys).toEqual(expect.arrayContaining(["attach", "place", "approval"]));
    expect(item("place")?.textContent).toContain("Works on");
    expect(item("call:turns")).toBeNull();
    expect(item("call:live")).toBeNull();
  });

  it("keeps Advanced mode's buttons in a row on a wider screen", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: !query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
    fixture.advanced = true;
    render({ bot });
    expect(container.querySelector('button[aria-label="Attach a file"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="place-chip"]')).not.toBeNull();
    expect(fixture.call).toBeNull();
  });
});
