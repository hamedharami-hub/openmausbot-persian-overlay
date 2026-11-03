import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("injects research only into the requested turn and retains original user text", async () => {
  const session = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: session.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", session.info.url]) as any;
    evidence.push({ args, result });
    return result;
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ path, body, result });
    return result;
  };
  try {
    const created = await control(["new-bot", "--name", "Research fixture"]);
    const bot = { ...created.bot, threadId: created.bot.activeTaskId };
    expect(bot.id).toBeTruthy();
    const path = `/api/bots/${bot.id}/messages`;
    const research = { mode: "verify", depth: "deep", length: "short" };
    expect((await post("/api/groups/fixture/messages", { text: "group request", research })).status).toBe(400);
    const send = { text: "Check a synthetic current claim", threadId: bot.threadId, sendId: "research-fixture-0001", research };
    const accepted = await post(path, send);
    expect(accepted.status).toBe(202);
    expect(accepted.body.message).toMatchObject({ text: send.text, research });
    expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20"])).status).toBe("settled");
    const dumpPath = join(session.info.dataDir, "fake-claude-dump.json");
    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(JSON.stringify(dump.prompt)).toContain("<research-request>");
    expect(JSON.stringify(dump.prompt)).toContain("Open and read relevant pages");
    expect(dump.systemPrompt).not.toContain("<research-request>");
    evidence.push({ promptHadGuidance: true, systemHadGuidance: false });
    expect((await post(path, { ...send, research: { ...research, length: "long" } })).status).toBe(409);
    expect((await post(path, { text: "ordinary next request", threadId: bot.threadId })).status).toBe(202);
    expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20"])).status).toBe("settled");
    const next = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(JSON.stringify(next.prompt)).not.toContain("<research-request>");
    evidence.push({ nextPromptHadGuidance: false });
    const edit = { text: "Check the revised synthetic claim", threadId: bot.threadId, sendId: "research-edit-000001" };
    const edited = await post(`${path}/${accepted.body.message.id}/edit`, edit);
    expect(edited.status).toBe(202);
    expect(edited.body.message).toMatchObject({ text: edit.text, research });
    expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20"])).status).toBe("settled");
    expect(JSON.stringify(JSON.parse(readFileSync(dumpPath, "utf8")).prompt)).toContain("<research-request>");
    expect((await post(`${path}/${accepted.body.message.id}/edit`, edit)).status).toBe(202);
    evidence.push({ editedRequestRetainedGuidance: true, editRetryMatched: true });
    await control(["messages", "--bot", bot.id, "--task", bot.threadId, "--limit", "10"]);
  } finally {
    writeFileSync(`${session.info.logPath}.research.json`, JSON.stringify(evidence, null, 2));
    console.log(`Research fixture log: ${session.info.logPath}`);
    await session.close();
  }
}, 60_000);
