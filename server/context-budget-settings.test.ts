import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { contextBudgetSettings, readContextBudget, saveContextBudget } from "./context-policy.ts";
import { createContextPolicyRoutes } from "./routes/context-policy.ts";
import type { RouteContext } from "./routes/table.ts";

it("persists isolated overrides and describes where the local target is applied", () => {
  expect(contextBudgetSettings("budget-thread-a", "budget-bot-a")).toMatchObject({
    source: "default", budget: { mode: "balanced" },
    application: "system-prompt-and-compaction-threshold", measurement: "local-estimate", providerHardCap: false,
  });
  saveContextBudget("bot", "budget-bot-a", { mode: "economy" });
  expect(contextBudgetSettings("budget-thread-a", "budget-bot-a").source).toBe("bot");
  saveContextBudget("thread", "budget-thread-a", { mode: "custom", inputTokens: 2048 });
  expect(contextBudgetSettings("budget-thread-a", "budget-bot-a")).toMatchObject({ source: "thread", budget: { mode: "custom", inputTokens: 2048 } });
  expect(contextBudgetSettings("budget-thread-b", "budget-bot-a").budget).toEqual({ mode: "economy" });
  expect(contextBudgetSettings("budget-thread-b", "budget-bot-b").source).toBe("default");
  saveContextBudget("thread", "budget-thread-a", { mode: "inherit" });
  expect(contextBudgetSettings("budget-thread-a", "budget-bot-a").source).toBe("bot");
  for (const invalid of [{ mode: "custom", inputTokens: 0 }, { mode: "custom", inputTokens: 1.5 }, { mode: "balanced", inputTokens: 99 }, { mode: "custom", inputTokens: "2048" }]) {
    expect(() => saveContextBudget("bot", "budget-bot-a", invalid)).toThrow();
  }
  expect(readContextBudget("bot", "budget-bot-a")).toEqual({ mode: "economy" });
  expect(() => saveContextBudget("thread", "../escape", { mode: "full" })).toThrow();
  const file = join(DATA_DIR, "context-budgets", "bot", "budget-bot-a.json");
  writeFileSync(file, "broken");
  expect(() => readContextBudget("bot", "budget-bot-a")).toThrow();
  expect(readFileSync(file, "utf8")).toBe("broken");
});

it("uses native thread authorization before budget reads/writes and protects bot defaults", async () => {
  const route = createContextPolicyRoutes({
    resolve(_kind, _id, threadId) {
      if (threadId !== "route-budget-thread") throw Object.assign(new Error("Conversation not found"), { status: 404 });
      return { threadId, busy: false };
    },
    compact: async () => { throw new Error("Budget settings must not compact"); },
  });
  const call = async (kind: "bots" | "groups", method: string, body: unknown, admin = false) => {
    const result: { status?: number; body?: any } = {};
    const path = `/api/${kind}/route-budget-bot/context`;
    await route({ path, method, url: new URL(`http://localhost${path}?threadId=route-budget-thread`),
      auth: { kind: "loopback", scopes: admin ? ["admin"] : ["client"] },
      readBody: async () => body,
      json: (_res: unknown, status: number, value: unknown) => { result.status = status; result.body = value; },
    } as unknown as RouteContext);
    return result;
  };
  expect((await call("bots", "PATCH", { threadId: "route-budget-thread", budget: { mode: "full" } })).status).toBe(200);
  expect((await call("bots", "PATCH", { threadId: "route-budget-thread", budgetScope: "bot", budget: { mode: "economy" } })).status).toBe(403);
  expect((await call("bots", "PATCH", { threadId: "route-budget-thread", budgetScope: "bot", budget: { mode: "economy" } }, true)).status).toBe(200);
  expect((await call("groups", "PATCH", { threadId: "route-budget-thread", budgetScope: "bot", budget: { mode: "full" } }, true)).status).toBe(403);
  expect((await call("bots", "PATCH", { threadId: "route-budget-thread", budget: { mode: "custom", inputTokens: -1 } })).status).toBe(400);
  await expect(call("bots", "PATCH", { threadId: "foreign-thread", budget: { mode: "full" } }, true)).rejects.toThrow("Conversation not found");
  expect((await call("bots", "GET", null)).body.contextBudget).toMatchObject({
    source: "thread", budget: { mode: "full" }, measurement: "local-estimate", providerHardCap: false,
  });
  expect((await call("bots", "GET", null)).body.canEditBotDefaults).toBe(false);
  expect((await call("bots", "GET", null, true)).body.canEditBotDefaults).toBe(true);
  expect((await call("groups", "GET", null, true)).body.canEditBotDefaults).toBe(false);
});
