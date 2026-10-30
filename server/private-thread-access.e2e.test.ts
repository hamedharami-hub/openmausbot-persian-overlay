import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

it("isolates direct threads across member APIs and live events while preserving owner history and shared groups", async () => {
  const fixture = await launchVerificationServer();
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload as any };
  };
  let ownerEvents: Awaited<ReturnType<typeof openSse>> | undefined;
  let memberEvents: Awaited<ReturnType<typeof openSse>> | undefined;
  try {
    expect((await api("PUT", "/api/config", {
      signIn: { admins: ["owner@example.invalid"], members: ["member@example.invalid", "other@example.invalid"] },
    })).status).toBe(200);
    const ownerPairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const owner = await api("POST", "/api/auth/pair", { code: ownerPairing.body.code, label: "Owner fixture" });
    const memberPairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    const member = await api("POST", "/api/auth/pair", { code: memberPairing.body.code, label: "Member fixture" });
    const otherPairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    const other = await api("POST", "/api/auth/pair", { code: otherPairing.body.code, label: "Second member fixture" });
    expect(owner.status).toBe(200);
    expect(member.status).toBe(200);
    expect(other.status).toBe(200);

    const upload = await fetch(`${fixture.info.url}/api/attachments?uploadId=11111111-1111-4111-8111-111111111111`, {
      method: "POST",
      headers: { "content-type": "image/png", authorization: `Bearer ${member.body.token}` },
      body: new Uint8Array(PNG),
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { path: string };
    const attachmentName = uploaded.path.split(/[\\/]/).pop()!;
    expect((await fetch(`${fixture.info.url}/api/attachments/${attachmentName}`, {
      headers: { authorization: `Bearer ${member.body.token}` },
    })).status).toBe(200);
    expect((await fetch(`${fixture.info.url}/api/attachments/${attachmentName}`, {
      headers: { authorization: `Bearer ${other.body.token}` },
    })).status).toBe(404);
    const reusedUpload = await fetch(`${fixture.info.url}/api/attachments?uploadId=11111111-1111-4111-8111-111111111111`, {
      method: "POST",
      headers: { "content-type": "image/png", authorization: `Bearer ${other.body.token}` },
      body: new Uint8Array(PNG),
    });
    expect(reusedUpload.status).toBe(409);
    expect((await fetch(`${fixture.info.url}/api/attachments/${attachmentName}`, {
      headers: { authorization: `Bearer ${member.body.token}` },
    })).status).toBe(200);
    expect((await fetch(`${fixture.info.url}/api/attachments/${attachmentName}`, {
      headers: { authorization: `Bearer ${other.body.token}` },
    })).status).toBe(404);
    const fileUpload = await fetch(`${fixture.info.url}/api/files?name=resume.pdf&uploadId=22222222-2222-4222-8222-222222222222`, {
      method: "POST",
      headers: { "content-type": "application/pdf", authorization: `Bearer ${member.body.token}` },
      body: "%PDF-1.7\nPRIVATE_RESUME\n%%EOF",
    });
    expect(fileUpload.status).toBe(201);
    const uploadedFile = await fileUpload.json() as { path: string; name: string };

    const { bot } = await control("new-bot", "--name", "Private thread boundary fixture") as { bot: { id: string; activeTaskId: string } };
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Owner private conversation" }, owner.body.token);
    expect(created.status).toBe(201);
    const threadId = created.body.task.threadId as string;
    const privateRoutine = await api("POST", "/api/routines", {
      name: "Private thread routine", prompt: "Summarize only this conversation.", botId: bot.id,
      resultsThreadId: threadId, enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 },
    }, owner.body.token);
    expect(privateRoutine.status).toBe(201);
    expect((await api("GET", "/api/routines", undefined, member.body.token)).body.routines
      .some((routine: any) => routine.id === privateRoutine.body.routine.id)).toBe(false);
    const crossAccountRoutine = await api("POST", "/api/routines", {
      name: "Cross-account routine", prompt: "Do not access another account's conversation.", botId: bot.id,
      resultsThreadId: threadId, enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 },
    }, member.body.token);
    expect(crossAccountRoutine.status).toBe(404);
    const legacy = await api("GET", `/api/threads/${bot.activeTaskId}/messages`, undefined, member.body.token);
    expect(legacy.status).toBe(404);

    ownerEvents = await openSse(`${fixture.info.url}/api/events`, { authorization: `Bearer ${owner.body.token}` });
    memberEvents = await openSse(`${fixture.info.url}/api/events`, { authorization: `Bearer ${member.body.token}` });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "PRIVATE_THREAD_SENTINEL", threadId }, owner.body.token)).status).toBe(202);
    await ownerEvents.until((frame) => frame.kind === "message" && frame.threadId === threadId && frame.message?.text === "PRIVATE_THREAD_SENTINEL");
    await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");

    expect((await api("GET", `/api/threads/${threadId}/messages`, undefined, member.body.token)).status).toBe(404);
    expect((await api("GET", `/api/threads/${threadId}/export`, undefined, member.body.token)).status).toBe(404);
    expect((await api("POST", `/api/bots/${bot.id}/tasks/${threadId}`, {}, member.body.token)).status).toBe(404);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "cross-account write", threadId }, member.body.token)).status).toBe(404);
    const attemptedDelete = await api("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: [threadId] }, member.body.token);
    expect(attemptedDelete.status).toBe(200);
    expect(attemptedDelete.body.deleted).toEqual([]);
    expect(attemptedDelete.body.refused).toEqual([{ threadId, reason: "not-found" }]);
    expect((await api("GET", `/api/threads/${threadId}/messages`, undefined, owner.body.token)).status).toBe(200);
    const memberBots = await api("GET", "/api/bots?messages=0", undefined, member.body.token);
    expect(memberBots.status).toBe(200);
    const visibleBot = memberBots.body.bots.find((candidate: any) => candidate.id === bot.id);
    expect(visibleBot.tasks.some((task: any) => task.threadId === threadId)).toBe(false);
    const memberChat = await api("GET", "/api/bots?messages=20", undefined, member.body.token);
    const scopedChat = memberChat.body.bots.find((candidate: any) => candidate.id === bot.id);
    expect(scopedChat.threadId).not.toBe(bot.activeTaskId);
    expect(scopedChat.tasks.some((task: any) => task.threadId === scopedChat.threadId)).toBe(true);
    expect((await api("GET", `/api/threads/${scopedChat.threadId}/messages`, undefined, member.body.token)).status).toBe(200);
    const memberChatAgain = await api("GET", "/api/bots?messages=0", undefined, member.body.token);
    expect(memberChatAgain.body.bots.find((candidate: any) => candidate.id === bot.id).threadId).toBe(scopedChat.threadId);
    expect(JSON.stringify(scopedChat)).not.toContain("PRIVATE_THREAD_SENTINEL");
    const catalog = await api("GET", "/api/instances", undefined, member.body.token);
    expect(catalog.status).toBe(200);
    expect(catalog.body.instances.length).toBeGreaterThan(0);
    for (const engine of catalog.body.instances) {
      expect(engine).not.toHaveProperty("cli");
      expect(engine).not.toHaveProperty("authentication");
      expect(engine.snapshot).not.toHaveProperty("account");
    }
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${scopedChat.threadId}`, {
      modelSelection: scopedChat.modelSelection, updateBotDefault: true,
    }, member.body.token)).status).toBe(403);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${scopedChat.threadId}`, {
      approvalMode: "full",
    }, member.body.token)).status).toBe(403);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${scopedChat.threadId}`, {
      modelSelection: scopedChat.modelSelection, updateBotDefault: false,
    }, member.body.token)).status).toBe(200);

    const memberSend = await api("POST", `/api/bots/${bot.id}/messages`, {
      text: `MEMBER_PRIVATE_SENTINEL\n\n<attached-file path="${uploadedFile.path}" name="${uploadedFile.name}" />`, threadId: scopedChat.threadId,
    }, member.body.token);
    expect(memberSend.status).toBe(202);
    const privateMessages = await api("GET", `/api/threads/${scopedChat.threadId}/messages`, undefined, member.body.token);
    const privateFileMessage = privateMessages.body.messages.find((message: any) => message.role === "user" && message.text?.includes("MEMBER_PRIVATE_SENTINEL"));
    expect(privateFileMessage).toBeTruthy();
    expect((await api("POST", `/api/threads/${scopedChat.threadId}/messages/${privateFileMessage.id}/file`, { path: uploadedFile.path }, member.body.token)).status).toBe(200);
    expect((await api("POST", `/api/threads/${scopedChat.threadId}/messages/${privateFileMessage.id}/file`, { path: uploadedFile.path }, other.body.token)).status).toBe(404);
    expect((await api("GET", `/api/threads/${scopedChat.threadId}/messages`, undefined, other.body.token)).status).toBe(404);
    const otherChat = await api("GET", "/api/bots?messages=0", undefined, other.body.token);
    const otherThreadId = otherChat.body.bots.find((candidate: any) => candidate.id === bot.id).threadId;
    expect(otherThreadId).toBeTruthy();
    expect(otherThreadId).not.toBe(scopedChat.threadId);
    expect((await api("GET", `/api/threads/${otherThreadId}/messages`, undefined, other.body.token)).status).toBe(200);
    expect((await api("GET", `/api/search?q=PRIVATE_THREAD_SENTINEL`, undefined, member.body.token)).body.hits).toEqual([]);
    const leaked = await memberEvents.until(
      (frame) => frame.kind === "message" && frame.threadId === threadId,
      350,
    ).then(() => true, () => false);
    expect(leaked).toBe(false);

    const { channel } = await control("new-channel", "--name", "Shared group boundary fixture", "--members", bot.id) as { channel: { id: string; activeTaskId: string } };
    expect((await api("GET", `/api/threads/${channel.activeTaskId}/messages`, undefined, member.body.token)).status).toBe(200);
    expect((await api("POST", `/api/groups/${channel.id}/messages`, {
      text: `Share this image with the group: /api/attachments/${attachmentName}\n\n<attached-file path="${uploadedFile.path}" name="${uploadedFile.name}" />`,
    }, member.body.token)).status).toBe(202);
    // The upload reference is now in an explicitly shared room; the cache must lose its earlier empty result.
    expect((await fetch(`${fixture.info.url}/api/attachments/${attachmentName}`, {
      headers: { authorization: `Bearer ${other.body.token}` },
    })).status).toBe(200);
    const groupMessages = await api("GET", `/api/threads/${channel.activeTaskId}/messages`, undefined, other.body.token);
    const groupFileMessage = groupMessages.body.messages.find((message: any) => message.role === "user" && message.text?.includes(uploadedFile.path));
    expect(groupFileMessage).toBeTruthy();
    expect((await api("POST", `/api/threads/${channel.activeTaskId}/messages/${groupFileMessage.id}/file`, { path: uploadedFile.path }, other.body.token)).status).toBe(200);
  } finally {
    ownerEvents?.close();
    memberEvents?.close();
    await fixture.close();
  }
}, 120_000);
