import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot, WireGroup } from "../shared/wire.ts";

it("blocks the main group conversation turn before provider dispatch when required system context exceeds its thread budget", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as any };
  };

  try {
    const bot = (await cli("new-bot", "--name", "Budgeted group member")).bot as WireBot & { activeTaskId: string };
    const group = (await cli("new-channel", "--name", "Budget gate", "--members", bot.id)).channel as WireGroup & { activeTaskId: string };
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { reply: "This must never reach the provider." } }));

    const pairing = await api("/api/auth/pairing", "POST", { scopes: ["client"] });
    expect(pairing.status).toBe(200);
    const paired = await api("/api/auth/pair", "POST", { code: pairing.data.code, label: "Group context budget fixture" });
    expect(paired.status).toBe(200);
    const token = paired.data.token as string;
    const budget = await api(`/api/groups/${group.id}/context`, "PATCH", {
      threadId: group.activeTaskId,
      budgetScope: "thread",
      budget: { mode: "custom", inputTokens: 1 },
    }, token);
    expect(budget.status).toBe(200);

    await cli("send-channel", "--channel", group.id, "--text", `@${bot.name} respond briefly`);
    expect(await cli("wait", "--channel", group.id, "--timeout", "30")).toMatchObject({ status: "failed" });
    const messages = await api(`/api/threads/${group.activeTaskId}/messages`);
    expect(messages.data.messages.at(-1)?.tool?.name).toContain("conversation turn was blocked before dispatch");
    expect(existsSync(join(dataDir, "room-plan.json.evidence.jsonl"))).toBe(false);
    const largerBudget = await api(`/api/groups/${group.id}/context`, "PATCH", {
      threadId: group.activeTaskId,
      budgetScope: "thread",
      budget: { mode: "custom", inputTokens: 4_096 },
    }, token);
    expect(largerBudget.status).toBe(200);
    await cli("send-channel", "--channel", group.id, "--text", "G".repeat(25_000));
    expect(await cli("wait", "--channel", group.id, "--timeout", "30")).toMatchObject({ status: "failed" });
    const longRequest = await api(`/api/threads/${group.activeTaskId}/messages`);
    expect(longRequest.data.messages.at(-1)?.tool?.name).toContain("conversation turn was blocked before dispatch");
    expect(existsSync(join(dataDir, "room-plan.json.evidence.jsonl"))).toBe(false);
  } finally {
    await session.close();
  }
}, 60_000);
