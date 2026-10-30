import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("hides context-policy routes for bots and groups outside a paired member's visibility", async () => {
  const session = await launchVerificationServer();
  const { url } = session.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  try {
    const bot = (await cli("new-bot", "--name", "Private context fixture")).bot as { id: string; activeTaskId: string };
    const group = (await cli("new-channel", "--name", "Private context room", "--members", bot.id)).channel as { id: string; activeTaskId: string };
    expect((await api(`/api/bots/${bot.id}`, "PATCH", { visibility: "admins" })).status).toBe(200);

    const pairing = await api("/api/auth/pairing", "POST", { scopes: ["client"] });
    expect(pairing.status).toBe(200);
    const paired = await api("/api/auth/pair", "POST", { code: pairing.body.code, label: "Hidden context fixture" });
    expect(paired.status).toBe(200);
    const token = paired.body.token as string;

    const requests: Array<[string, string, unknown?]> = [
      ["GET", `/api/bots/${bot.id}/context?threadId=${bot.activeTaskId}`],
      ["PATCH", `/api/bots/${bot.id}/context`, { threadId: bot.activeTaskId, budgetScope: "thread", budget: { mode: "full" } }],
      ["POST", `/api/bots/${bot.id}/context`, { threadId: bot.activeTaskId }],
      ["GET", `/api/groups/${group.id}/context?threadId=${group.activeTaskId}`],
      ["PATCH", `/api/groups/${group.id}/context`, { threadId: group.activeTaskId, budgetScope: "thread", budget: { mode: "full" } }],
      ["POST", `/api/groups/${group.id}/context`, { threadId: group.activeTaskId }],
    ];
    for (const [method, path, body] of requests) {
      const result = await api(path, method, body, token);
      expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain(bot.id);
      expect(JSON.stringify(result.body)).not.toContain(group.id);
    }
  } finally {
    await session.close();
  }
}, 60_000);
