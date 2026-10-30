import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot, WireGroup } from "../shared/wire.ts";

it("records each Everyone responder outcome and keeps Auto limited to its selected fallback without a router", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const planPath = join(dataDir, "room-plan.json");
  const evidencePath = `${planPath}.evidence.jsonl`;

  try {
    const first = (await cli("new-bot", "--name", "First responder")).bot as WireBot;
    const second = (await cli("new-bot", "--name", "Second responder")).bot as WireBot;
    const everyone = (await api("/api/groups", "POST", {
      name: "Everyone integrity",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group as WireGroup;

    writeFileSync(planPath, JSON.stringify({
      [first.id]: { failWith: "Fixture provider failure for first responder" },
      [second.id]: { reply: "SECOND-EVERYONE-RESULT: completed" },
    }));
    expect((await api(`/api/groups/${everyone.id}/messages`, "POST", { text: "Please provide a status update." })).status).toBe(202);
    expect(await cli("wait", "--channel", everyone.id, "--timeout", "45")).toMatchObject({ status: "settled" });

    const firstMessages = (await api(`/api/threads/${everyone.threadId}/messages?limit=300`)).body.messages as any[];
    expect(firstMessages.some(message => message.from?.botId === first.id && message.kind === "activity" && message.tool?.ok === false)).toBe(true);
    expect(firstMessages.some(message => message.from?.botId === second.id && message.kind === "text" && message.text?.includes("SECOND-EVERYONE-RESULT"))).toBe(true);
    expect(existsSync(evidencePath)).toBe(true);
    const everyoneEvidence = readFileSync(evidencePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(everyoneEvidence.filter((row: any) => [first.id, second.id].includes(row.botId)).map((row: any) => row.botId))
      .toEqual([first.id, second.id]);

    const automatic = (await api("/api/groups", "POST", {
      name: "Auto integrity",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "auto" } },
    })).body.group as WireGroup;
    writeFileSync(planPath, JSON.stringify({
      [first.id]: { reply: "FIRST-AUTO-FALLBACK: selected" },
      [second.id]: { reply: "SECOND-AUTO-UNSELECTED: must not run" },
    }));
    const beforeAuto = everyoneEvidence.length;
    expect((await api(`/api/groups/${automatic.id}/messages`, "POST", { text: "Check the latest status." })).status).toBe(202);
    expect(await cli("wait", "--channel", automatic.id, "--timeout", "45")).toMatchObject({ status: "settled" });
    const autoMessages = (await api(`/api/threads/${automatic.threadId}/messages?limit=300`)).body.messages as any[];
    expect(autoMessages.some(message => message.from?.botId === first.id && message.kind === "text" && message.text?.includes("FIRST-AUTO-FALLBACK"))).toBe(true);
    expect(autoMessages.some(message => message.from?.botId === second.id && message.kind === "text")).toBe(false);
    const allEvidence = readFileSync(evidencePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(allEvidence.slice(beforeAuto).filter((row: any) => [first.id, second.id].includes(row.botId)).map((row: any) => row.botId))
      .toEqual([first.id]);
  } finally {
    await fixture.close();
  }
}, 90_000);

it("calls all three Everyone members with their own effective model and preserves every outcome after a failure", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const planPath = join(dataDir, "room-plan.json");
  const evidencePath = `${planPath}.evidence.jsonl`;

  try {
    const members = [
      (await cli("new-bot", "--name", "Three responder one")).bot as WireBot,
      (await cli("new-bot", "--name", "Three responder two")).bot as WireBot,
      (await cli("new-bot", "--name", "Three responder three")).bot as WireBot,
    ];
    const selections = [
      { instanceId: "claude", model: "claude-sonnet-5" },
      { instanceId: "claude", model: "claude-opus-5-5" },
      { instanceId: "claude", model: "claude-haiku-4-5" },
    ];
    for (const [index, member] of members.entries()) {
      const changed = await api(`/api/bots/${member.id}`, "PATCH", { modelSelection: selections[index] });
      expect(changed.status).toBe(200);
      expect(changed.body.bot.modelSelection).toMatchObject(selections[index]);
    }
    const group = (await api("/api/groups", "POST", {
      name: "Three member Everyone integrity",
      memberIds: members.map(member => member.id),
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group as WireGroup;

    writeFileSync(planPath, JSON.stringify({
      [members[0]!.id]: { failWith: "Fixture provider failure for member one" },
      [members[1]!.id]: { reply: "THREE-EVERYONE-SECOND: completed" },
      [members[2]!.id]: { reply: "THREE-EVERYONE-THIRD: completed" },
    }));
    expect((await api(`/api/groups/${group.id}/messages`, "POST", { text: "Report one result per selected member." })).status).toBe(202);
    expect(await cli("wait", "--channel", group.id, "--timeout", "45")).toMatchObject({ status: "settled" });

    const messages = (await api(`/api/threads/${group.threadId}/messages?limit=300`)).body.messages as any[];
    expect(messages.some(message => message.from?.botId === members[0]!.id && message.kind === "activity" && message.tool?.ok === false)).toBe(true);
    expect(messages.some(message => message.from?.botId === members[1]!.id && message.kind === "text" && message.text?.includes("THREE-EVERYONE-SECOND"))).toBe(true);
    expect(messages.some(message => message.from?.botId === members[2]!.id && message.kind === "text" && message.text?.includes("THREE-EVERYONE-THIRD"))).toBe(true);

    expect(existsSync(evidencePath)).toBe(true);
    const evidence = readFileSync(evidencePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const groupEvidence = evidence.filter((row: any) => row.threadId === group.threadId);
    expect(groupEvidence).toHaveLength(3);
    expect(groupEvidence.map((row: any) => row.botId).sort()).toEqual(members.map(member => member.id).sort());
    expect(Object.fromEntries(groupEvidence.map((row: any) => [row.botId, row.model]))).toEqual(Object.fromEntries(
      members.map((member, index) => [member.id, selections[index]!.model]),
    ));
    const incidentEvidence = evidence.filter((row: any) =>
      row.threadId !== group.threadId && JSON.stringify(row.prompt).includes("[Incident report from OpenMausBot"),
    );
    expect(incidentEvidence).toHaveLength(1);
    expect(members.some(member => member.id === incidentEvidence[0]!.botId)).toBe(false);
  } finally {
    await fixture.close();
  }
}, 90_000);
