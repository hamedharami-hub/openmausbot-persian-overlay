import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { ModelSelection, WireBot, WireGroup } from "../shared/wire.ts";

it("uses independent group member models without changing the bot or another group's model", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  const { url, dataDir } = fixture.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const planPath = join(dataDir, "room-plan.json");
  const ready = join(dataDir, "group-model-ready");
  const gate = join(dataDir, "group-model-release");
  try {
    const codexDump = join(dataDir, "fake-codex-dump.json");
    const codex = (await api("/api/instances")).body.instances.find((instance: any) => instance.instanceId === "codex");
    const bot = (await cli("new-bot", "--name", "Shared model member")).bot as WireBot;
    const first: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5" };
    const second: ModelSelection = { instanceId: "codex", model: codex.models.default };
    const make = async (name: string) => (await api("/api/groups", "POST", {
      name, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group as WireGroup;
    const a = await make("Scoped model A");
    const b = await make("Scoped model B");
    expect((await api(`/api/groups/${a.id}`, "PATCH", { memberModels: { [bot.id]: first } })).status).toBe(200);
    expect((await api(`/api/groups/${b.id}`, "PATCH", { memberModels: { [bot.id]: second } })).status).toBe(200);
    expect((await api(`/api/groups/${a.id}`, "PATCH", { memberModels: { stranger: first } })).status).toBe(400);
    expect((await api(`/api/groups/${a.id}`, "PATCH", { memberModels: { [bot.id]: { ...first, model: "not-in-catalog" } } })).status).toBe(400);
    expect((await api(`/api/groups/${a.id}`, "PATCH", { memberModels: { [bot.id]: { ...first, instanceId: "missing-provider" } } })).status).toBe(400);
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { byPrompt: [
      { promptIncludes: "GROUP-MODEL-A", plan: { readyFile: ready, gateFile: gate, reply: "A completed" } },
      { promptIncludes: "GROUP-MODEL-B", plan: { reply: "B completed" } },
    ], reply: "Direct default completed" } }));
    expect((await api(`/api/groups/${a.id}/messages`, "POST", { text: "GROUP-MODEL-A: report your model result." })).status).toBe(202);
    await expect.poll(() => existsSync(ready), { timeout: 20_000 }).toBe(true);
    expect((await api(`/api/groups/${a.id}`, "PATCH", { memberModels: {} })).status).toBe(409);
    writeFileSync(gate, "release");
    expect(await cli("wait", "--channel", a.id, "--timeout", "45")).toMatchObject({ status: "settled" });
    expect((await api(`/api/groups/${b.id}/messages`, "POST", { text: "GROUP-MODEL-B: report your model result." })).status).toBe(202);
    const groupBResult = await cli("wait", "--channel", b.id, "--timeout", "45");
    expect(groupBResult, JSON.stringify(groupBResult, null, 2)).toMatchObject({ status: "settled" });
    expect((await api(`/api/bots/${bot.id}/messages`, "POST", { text: "DIRECT-MODEL-DEFAULT: report your result." })).status).toBe(202);
    expect(await cli("wait", "--bot", bot.id, "--timeout", "45")).toMatchObject({ status: "settled" });
    const evidence = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(evidence.filter((row: any) => row.threadId === a.threadId).map((row: any) => row.model)).toEqual([first.model]);
    const codexTurn = JSON.parse(readFileSync(codexDump, "utf8")) as { calls: Array<{ method: string; params: any }> };
    expect(codexTurn.calls.filter((call) => call.method === "thread/start").map((call) => call.params.model)).toEqual([second.model]);
    const current = (await api("/api/bots?messages=0")).body.bots.find((entry: WireBot) => entry.id === bot.id) as WireBot;
    expect(current.modelSelection).toEqual(bot.modelSelection);
    const direct = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[] };
    expect(direct.argv[direct.argv.indexOf("--model") + 1]).toBe(bot.modelSelection.model);
    const saved = JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8")) as WireGroup[];
    expect(saved.find((group) => group.id === a.id)?.memberModels?.[bot.id]).toEqual(first);
    expect(saved.find((group) => group.id === b.id)?.memberModels?.[bot.id]).toEqual(second);
    expect((await api(`/api/groups/${a.id}`, "PATCH", { memberModels: null })).status).toBe(200);
    const afterClear = (await api("/api/bots?messages=0")).body.groups.find((group: WireGroup) => group.id === b.id) as WireGroup;
    expect(afterClear.memberModels?.[bot.id]).toEqual(second);
  } finally {
    writeFileSync(gate, "cleanup");
    await fixture.close();
  }
}, 90_000);
