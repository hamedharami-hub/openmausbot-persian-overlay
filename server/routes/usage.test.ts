import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import type { RequestAuth } from "../request-auth.ts";
import type { UsageRow } from "../usage-ledger.ts";
import { json, readBody } from "../harness/http.ts";
import { createUsageRoutes } from "./usage.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const row = (botName: string, threadId: string, trigger: UsageRow["trigger"]): UsageRow => ({
  at: "2026-10-24T01:00:00.000Z", botId: botName.toLowerCase().replaceAll(" ", "-"), botName, threadId,
  instanceId: "openai", driverKind: "openai", model: "test-model", input: 100, output: 20, costUsd: 0.01, trigger,
});

it("limits member usage summaries and CSV exports to visible, account-owned turns", async () => {
  const rows = [
    row("Account A chat", "private-a", { kind: "user", email: "a@example.test" }),
    row("Account B secret", "private-b", { kind: "user", email: "b@example.test" }),
    row("Public conversation", "public-thread", { kind: "user", email: "b@example.test" }),
    row("Public bot follow-up", "public-thread", { kind: "bot", botId: "bot-1" }),
    row("Owner-only work", "private-a", { kind: "owner" }),
  ];
  const auth: RequestAuth = { kind: "session", session: { id: "member", email: "a@example.test", tokenHash: "fixture", label: "member", scopes: ["client"], createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60_000 }, via: "bearer", scopes: ["client"] };
  const routes = [createUsageRoutes({
    dataDir: "unused",
    prices: () => null,
    budget: () => ({ total: 99 } as never),
    currency: () => "USD",
    recorder: { liveTurns: () => [] },
    messages: () => [],
    liveBot: () => null,
    canSee: () => threadId => threadId !== "private-b",
    visibleThread: (_auth, threadId) => threadId !== "private-b",
    readRows: () => rows,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { error: "not found" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const range = "?from=2026-10-24&to=2026-10-24";

  const response = await fetch(`${base}/api/usage${range}&groupBy=user`);
  expect(response.status).toBe(200);
  const body = await response.json() as { groups: Array<{ label: string }>; budget: unknown };
  expect(body.groups.map((group) => group.label)).not.toContain("b@example.test");
  expect(body.groups.map((group) => group.label)).not.toContain("This computer");
  expect(body.budget).toBeNull();
  const csv = await (await fetch(`${base}/api/usage.csv${range}`)).text();
  expect(csv).not.toContain("Account B secret");
  expect(csv).not.toContain("b@example.test");
  expect(csv).not.toContain("Owner-only work");
});
