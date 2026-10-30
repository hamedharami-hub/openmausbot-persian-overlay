import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("serves project routes through the native server and denies client-only sessions", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  try {
    const cli = async (...args: string[]) => await runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
    const api = async (path: string, method = "GET", body?: unknown, token?: string) => {
      const response = await fetch(fixture.info.url + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() as any };
    };

    const bot = (await cli("new-bot", "--name", "Project route fixture")).bot;
    const page = await fetch(fixture.info.url + "/company");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<html lang="fa" dir="rtl">');
    const created = await api("/api/company/projects", "POST", {
      name: "Isolated project", goal: "FIXTURE_ONLY_PROJECT_GOAL", chiefBotId: bot.id,
    });
    expect(created.status).toBe(201);

    const linked = await api(`/api/company/projects/${created.data.id}/chats`, "POST", {
      botId: bot.id, threadId: bot.activeTaskId,
    });
    expect(linked.status).toBe(200);
    const inventory = await api("/api/company");
    expect(inventory.status).toBe(200);
    expect(inventory.data.projects[0]).toMatchObject({ id: created.data.id, name: "Isolated project" });
    expect(inventory.data.projects[0].chats).toContainEqual({ botId: bot.id, threadId: bot.activeTaskId });

    const task = await api(`/api/company/projects/${created.data.id}/tasks`, "POST", {
      title: "Review linked conversation", by: "user", accept: true, threadId: bot.activeTaskId,
    });
    expect(task).toMatchObject({ status: 201, data: { threadId: bot.activeTaskId, status: "open" } });
    const unrelated = await api(`/api/company/projects/${created.data.id}/tasks`, "POST", {
      title: "Reject unrelated conversation", by: "user", threadId: "unlinked-thread",
    });
    expect(unrelated).toMatchObject({ status: 409, data: { error: "task conversation must be linked to this project" } });

    const pairing = await api("/api/auth/pairing", "POST", { scopes: ["client"] });
    expect(pairing.status).toBe(200);
    const paired = await api("/api/auth/pair", "POST", { code: pairing.data.code, label: "Project fixture client" });
    expect(paired.status).toBe(200);
    const clientRead = await api("/api/company", "GET", undefined, paired.data.token);
    expect(clientRead.status).toBe(403);
  } finally {
    await fixture.close();
  }
}, 90_000);

it("keeps an organization fixture durable across two departments, pending work, failures, and empty goals", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  try {
    const cli = async (...args: string[]) => await runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
    const api = async (path: string, method = "GET", body?: unknown, token?: string) => {
      const response = await fetch(fixture.info.url + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() as any };
    };

    const chief = (await cli("new-bot", "--name", "Fixture Chief", "--section", "Research")).bot;
    const specialist = (await cli("new-bot", "--name", "Fixture Specialist", "--section", "Research")).bot;
    const otherDepartment = (await cli("new-bot", "--name", "Fixture Educator", "--section", "Education")).bot;
    const project = await api("/api/company/projects", "POST", {
      name: "Research goal", goal: "Fixture-only collaboration", section: "Research", chiefBotId: chief.id,
    });
    expect(project.status).toBe(201);
    const emptyProject = await api("/api/company/projects", "POST", {
      name: "Empty education goal", section: "Education", chiefBotId: otherDepartment.id,
    });
    expect(emptyProject.status).toBe(201);
    await api(`/api/company/projects/${project.data.id}/members`, "POST", { botId: specialist.id, role: "research specialist" });

    const pending = await api(`/api/company/projects/${project.data.id}/tasks`, "POST", {
      title: "Review source material", by: "bot", requestId: "review-source-once", assigneeBotId: specialist.id,
    });
    expect(pending).toMatchObject({ status: 201, data: { status: "proposed" } });
    const approved = await api(`/api/company/projects/${project.data.id}/tasks/${pending.data.id}/accept`, "POST", { accept: true });
    expect(approved).toMatchObject({ status: 200, data: { status: "open" } });
    const inventory = await api("/api/company");
    const failure = await api(`/api/company/projects/${project.data.id}/tasks/${pending.data.id}/failures`, "POST", {
      failureId: "provider-unavailable-once", reason: "The fixture provider returned an unavailable response.",
      nextAction: "Retry after the fixture recovers.", expectedRevision: inventory.data.revision,
    });
    expect(failure.status).toBe(201);

    const persisted = await api("/api/company");
    expect(persisted.data.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: project.data.id, section: "Research", tasks: [expect.objectContaining({ status: "open", executionFailures: [expect.objectContaining({ id: "provider-unavailable-once" })] })] }),
      expect.objectContaining({ id: emptyProject.data.id, section: "Education", progress: { total: 0, verified: 0, percent: null } }),
    ]));
    const clients = await Promise.all(["Fixture family user A", "Fixture family user B"].map(async label => {
      const pairing = await api("/api/auth/pairing", "POST", { scopes: ["client"] });
      const paired = await api("/api/auth/pair", "POST", { code: pairing.data.code, label });
      return api("/api/company", "GET", undefined, paired.data.token);
    }));
    expect(clients.map(result => result.status)).toEqual([403, 403]);
  } finally {
    await fixture.close();
  }
}, 90_000);
