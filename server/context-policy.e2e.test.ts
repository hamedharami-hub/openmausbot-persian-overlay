import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("persists scoped context policy and importance for a paired chat client, then compacts without deleting history", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [];
  try {
    const cli = async (...args: string[]) => await runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as any;
    const api = async (path: string, method = "GET", body?: unknown, token?: string) => {
      const response = await fetch(session.info.url + path, { method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json() as any;
      evidence.push({ path, method, status: response.status });
      return { status: response.status, data };
    };
    const bot = (await cli("new-bot", "--name", "Context policy fixture")).bot;
    const sibling = (await cli("new-bot", "--name", "Separate context")).bot;
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { reply: "Acknowledged" } }));
    const pairing = await api("/api/auth/pairing", "POST", { scopes: ["client"] });
    expect(pairing.status).toBe(200);
    const paired = await api("/api/auth/pair", "POST", { code: pairing.data.code, label: "Context-only fixture client" });
    expect(paired.status).toBe(200);
    const token = paired.data.token;
    const created = await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Client-owned context fixture" }, token);
    expect(created.status).toBe(201);
    const threadId = created.data.task.threadId as string;
    const otherPairing = await api("/api/auth/pairing", "POST", { scopes: ["client"] });
    const otherPaired = await api("/api/auth/pair", "POST", { code: otherPairing.data.code, label: "Other context fixture client" });
    expect(otherPaired.status).toBe(200);
    const otherThread = await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Other account context fixture" }, otherPaired.data.token);
    expect(otherThread.status).toBe(201);
    const otherThreadId = otherThread.data.task.threadId as string;
    const policy = { automatic: false, category: "work", guidance: "Retain deadlines and cancelled actions", maxBytes: 2048 };
    const endpoint = `/api/bots/${bot.id}/context`;
    expect((await api(endpoint, "PATCH", { threadId, policy }, token)).status).toBe(200);
    expect((await api(`${endpoint}?threadId=${threadId}`, "GET", undefined, token)).data.policy).toEqual(policy);
    expect((await api(endpoint, "PATCH", { threadId, budgetScope: "thread", budget: { mode: "custom", inputTokens: 1 } }, token)).status).toBe(200);
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", "DO_NOT_SEND_OVER_BUDGET");
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const overBudgetMessages = (await api(`/api/threads/${threadId}/messages`)).data.messages as any[];
    expect(overBudgetMessages.at(-1)?.tool?.name).toContain("conversation turn was blocked before dispatch");
    expect(existsSync(join(session.info.dataDir, "room-plan.json.evidence.jsonl"))).toBe(false);
    expect((await api(endpoint, "PATCH", { threadId, budgetScope: "thread", budget: { mode: "custom", inputTokens: 4_096 } }, token)).status).toBe(200);
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", "X".repeat(25_000));
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const longRequestMessages = (await api(`/api/threads/${threadId}/messages`)).data.messages as any[];
    expect(longRequestMessages.at(-1)?.tool?.name).toContain("conversation turn was blocked before dispatch");
    expect(existsSync(join(session.info.dataDir, "room-plan.json.evidence.jsonl"))).toBe(false);
    expect((await api(endpoint, "PATCH", { threadId, budgetScope: "thread", budget: { mode: "inherit" } }, token)).status).toBe(200);
    expect((await api(endpoint, "PATCH", { threadId: sibling.activeTaskId, policy }, token)).status).toBe(404);
    expect((await api(endpoint, "PATCH", { threadId: otherThreadId, policy }, token)).status).toBe(404);
    expect((await api(`/api/bots/${bot.id}/context`, "PATCH", { threadId, policy }, otherPaired.data.token)).status).toBe(404);
    expect((await api(endpoint, "PATCH", { threadId, policy: { ...policy, maxBytes: 999999 } }, token)).status).toBe(400);
    expect((await api(`/api/bots/${sibling.id}/context?threadId=${sibling.activeTaskId}`, "GET", undefined, token)).status).toBe(404);
    for (const text of ["FIRST_SOURCE project deadline May 11", "CORRECTION cancel sending; inspect only", "Latest request: retain the plan"]) {
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    }
    const messages = (await api(`/api/threads/${threadId}/messages`)).data.messages as any[];
    const source = messages.find(message => message.text?.includes("FIRST_SOURCE"));
    expect(source).toBeTruthy();
    expect((await api(`/api/threads/${threadId}/messages/${source.id}/important`, "POST", { important: true }, token)).status).toBe(200);
    const marked = await api(`/api/threads/${threadId}/important`, "GET", undefined, token);
    expect(marked.status).toBe(200);
    expect(marked.data.total).toBe(1);
    expect(marked.data.messages[0]).toMatchObject({ id: source.id, text: expect.stringContaining("FIRST_SOURCE") });
    expect((await api(`/api/threads/${sibling.activeTaskId}/messages/${source.id}/important`, "POST", { important: true }, token)).status).toBe(404);
    expect((await api(endpoint, "POST", { threadId }, token)).status).toBe(202);
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const after = (await api(`/api/threads/${threadId}/messages`)).data.messages as any[];
    const record = after.findLast(message => message.kind === "compaction");
    expect(record).toBeTruthy();
    expect(Buffer.byteLength(record.compaction.summary)).toBeLessThanOrEqual(2048);
    expect(record.compaction.summary).toContain("FIRST_SOURCE");
    expect(record.compaction.summary).toContain("CORRECTION");
    expect(after.filter(message => message.kind !== "compaction").map(message => message.id)).toEqual(messages.map(message => message.id));
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Continue using the retained plan");
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const turns = readFileSync(join(session.info.dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const nextTurn = turns.at(-1);
    expect(nextTurn.resumed).toBe(false);
    expect(String(nextTurn.prompt.message.content)).toContain("Earlier conversation summary");
    expect(String(nextTurn.prompt.message.content)).toContain("CORRECTION");
    expect((await api(`/api/threads/${threadId}/important`, "GET", undefined, token)).data.messages[0].id).toBe(source.id);
    expect((await api(`/api/threads/${threadId}/messages/${source.id}/important`, "POST", { important: false }, token)).status).toBe(200);
    expect((await api(`/api/threads/${threadId}/important`, "GET", undefined, token)).data.total).toBe(0);
    writeFileSync(`${session.info.logPath}.context-policy.json`, JSON.stringify({ status: "passed", requests: evidence }, null, 2));
    console.info(`Context policy evidence: ${session.info.logPath}.context-policy.json`);
  } finally { await session.close(); }
}, 90_000);
