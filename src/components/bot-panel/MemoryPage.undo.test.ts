// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ team: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.team ? { team: { id: "t", name: "Acme" } } : {} }, dispatch: vi.fn() }) };
});

const { MemoryPage } = await import("./pages");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "scout", threadId: "t1", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: { instanceId: "x", model: "x" } } as unknown as Bot;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls: string[] = [];
let text = "# Memory\n- 2026-09-25 · from chat \"Launch\" · Prefers morning calls\n";
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.team = false;
  calls.length = 0;
  text = "# Memory\n- 2026-09-25 · from chat \"Launch\" · Prefers morning calls\n";
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (method === "PUT") {
      const body = JSON.parse(String(init!.body)) as { text: string };
      text = body.text;
      return reply(200, { ok: true, path: "MEMORY.md", text, hash: `h${text.length}`, exists: true, overview: {},
        entry: { id: "entry-1", at: Date.now(), botId: bot.id, path: "MEMORY.md", actor: "person", via: "ui", kind: "edited",
          beforeHash: "a", afterHash: `h${text.length}`, diff: "", added: 0, removed: 1, canRevert: true } });
    }
    if (method === "POST" && url.pathname.endsWith("/revert")) {
      text = "# Memory\n- 2026-09-25 · from chat \"Launch\" · Prefers morning calls\n";
      return reply(200, { path: "MEMORY.md", text, hash: `h${text.length}`, exists: true, overview: {} });
    }
    return reply(200, { path: "MEMORY.md", text, hash: `h${text.length}`, exists: true });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

it("offers one-click undo after forgetting a note, then restores it from the journal", async () => {
  await act(async () => root.render(createElement(MemoryPage, { bot, derived: {} as never })));
  await settle();
  expect(host.textContent).toContain("Prefers morning calls");
  await act(async () => host.querySelector<HTMLButtonElement>("[data-memory-note] button")!.click());
  await settle();
  expect(host.textContent).not.toContain("Prefers morning calls");
  const undo = host.querySelector<HTMLElement>("[data-memory-undo] button");
  expect(undo).not.toBeNull();
  await act(async () => undo!.click());
  await settle();
  expect(calls).toContain("POST /api/bots/scout/memory/journal/entry-1/revert");
  expect(host.textContent).toContain("Prefers morning calls");
  expect(host.querySelector("[data-memory-undo]")).toBeNull();
});
