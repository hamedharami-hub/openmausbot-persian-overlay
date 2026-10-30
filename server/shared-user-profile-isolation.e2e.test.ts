import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

it("keeps the installation profile out of another account's direct and group prompts", async () => {
  const fixture = await launchVerificationServer();
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const sentSystem = () => (JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string }).systemPrompt;
  try {
    const saved = await api("PUT", "/api/config", {
      signIn: { admins: ["owner@example.invalid"], members: ["member@example.invalid"] },
      profile: { name: "OWNER_NAME_GUARD", aboutMe: "OWNER_CONTEXT_GUARD" },
    });
    expect(saved.status).toBe(200);

    const adminPairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const admin = await api("POST", "/api/auth/pair", { code: adminPairing.body.code, label: "Owner fixture" });
    const memberPairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    const member = await api("POST", "/api/auth/pair", { code: memberPairing.body.code, label: "Member fixture" });
    expect(admin.status).toBe(200);
    expect(member.status).toBe(200);
    const memberConfig = await api("GET", "/api/config", undefined, member.body.token);
    expect(memberConfig.body.profile).toEqual({ name: "", email: "" });
    expect(JSON.stringify(memberConfig.body)).not.toContain("OWNER_CONTEXT_GUARD");
    expect(JSON.stringify(memberConfig.body)).not.toContain("OWNER_NAME_GUARD");
    expect((await api("GET", "/api/config", undefined, admin.body.token)).body.profile).toMatchObject({ name: "OWNER_NAME_GUARD", aboutMe: "OWNER_CONTEXT_GUARD" });
    expect((await api("GET", "/api/me/profile", undefined, member.body.token)).body.profile).toEqual({ name: "", aboutMe: "", modelFavorites: [] });
    expect((await api("GET", "/api/me/profile", undefined, admin.body.token)).body.profile).toMatchObject({ name: "OWNER_NAME_GUARD", aboutMe: "OWNER_CONTEXT_GUARD" });
    const memberProfile = await api("PUT", "/api/me/profile", {
      profile: { aboutMe: "MEMBER_CONTEXT_GUARD", modelFavorites: [{ instanceId: "member-provider", model: "member-model" }] },
    }, member.body.token);
    expect(memberProfile.status).toBe(200);
    expect(memberProfile.body.profile.aboutMe).toBe("MEMBER_CONTEXT_GUARD");
    expect(memberProfile.body.profile.modelFavorites).toEqual([{ instanceId: "member-provider", model: "member-model" }]);
    expect((await api("GET", "/api/me/profile", undefined, admin.body.token)).body.profile.aboutMe).toBe("OWNER_CONTEXT_GUARD");
    expect((await api("GET", "/api/me/profile", undefined, admin.body.token)).body.profile.modelFavorites).toEqual([]);

    writeFileSync(join(fixture.info.dataDir, "profile-learned.json"), JSON.stringify({
      learned: [{ id: "owner-learned-guard", text: "OWNER_LEARNED_GUARD", line: "- learned owner fact", botId: "fixture-bot", botName: "Fixture", at: Date.now() }],
      removed: [],
    }));
    expect((await api("GET", "/api/profile/learned", undefined, admin.body.token)).body.learned).toHaveLength(1);
    expect(await api("GET", "/api/profile/learned", undefined, member.body.token)).toMatchObject({ status: 200, body: { learned: [] } });
    expect((await api("POST", "/api/profile/learned/owner-learned-guard/remove", {}, member.body.token)).status).toBe(404);

    const { bot } = await control("new-bot", "--name", "Profile isolation fixture") as { bot: { id: string; activeTaskId: string } };
    const ownerSend = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Owner turn", threadId: bot.activeTaskId }, admin.body.token);
    expect(ownerSend.status).toBe(202);
    expect(await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).toContain("OWNER_CONTEXT_GUARD");

    const memberBots = await api("GET", "/api/bots?messages=0", undefined, member.body.token);
    const memberThreadId = memberBots.body.bots.find((candidate: any) => candidate.id === bot.id)?.threadId as string | undefined;
    expect(memberThreadId).toBeTruthy();
    expect(memberThreadId).not.toBe(bot.activeTaskId);
    const memberSend = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Member direct turn", threadId: memberThreadId }, member.body.token);
    expect(memberSend.status).toBe(202);
    expect(await control("wait", "--bot", bot.id, "--task", memberThreadId!, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).not.toContain("OWNER_CONTEXT_GUARD");
    expect(sentSystem()).not.toContain("OWNER_NAME_GUARD");
    expect(sentSystem()).toContain("MEMBER_CONTEXT_GUARD");

    const { channel } = await control("new-channel", "--name", "Profile isolation room", "--members", bot.id) as { channel: { id: string; activeTaskId: string } };
    const roomSend = await api("POST", `/api/groups/${channel.id}/messages`, { text: "Member group turn" }, member.body.token);
    expect(roomSend.status).toBe(202);
    expect(await control("wait", "--channel", channel.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).not.toContain("OWNER_CONTEXT_GUARD");
    expect(sentSystem()).not.toContain("OWNER_NAME_GUARD");
    // A room is shared; one participant's private profile must not become room context.
    expect(sentSystem()).not.toContain("MEMBER_CONTEXT_GUARD");
    expect(sentSystem()).not.toContain("hello from fake claude");

    const ownerEvents = await openSse(`${fixture.info.url}/api/events`, { authorization: `Bearer ${admin.body.token}` });
    const memberEvents = await openSse(`${fixture.info.url}/api/events`, { authorization: `Bearer ${member.body.token}` });
    try {
      expect((await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 12 } }, admin.body.token)).status).toBe(200);
      const [ownerConfig, memberConfig] = await Promise.all([
        ownerEvents.until((frame) => frame.kind === "config"),
        memberEvents.until((frame) => frame.kind === "config"),
      ]);
      expect(ownerConfig.profile).toMatchObject({ name: "OWNER_NAME_GUARD", aboutMe: "OWNER_CONTEXT_GUARD" });
      expect(JSON.stringify(memberConfig)).not.toContain("OWNER_NAME_GUARD");
      expect(JSON.stringify(memberConfig)).not.toContain("OWNER_CONTEXT_GUARD");
    } finally {
      ownerEvents.close();
      memberEvents.close();
    }
  } finally {
    await fixture.close();
  }
}, 120_000);
