import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyFeature } from "./company-feature.ts";
import { markStaleTasks, STALE_TASK_DAYS } from "./company-layer.mjs";
import type { CompanyBoardProject, CompanyBoardState, CompanyBoardTask } from "./company-layer.mjs";
import type { RouteContext } from "./routes/table.ts";

const DAY = 86_400_000;

function openTask(overrides: Record<string, unknown> = {}): CompanyBoardTask {
  const stamp = new Date(Date.now() - 30 * DAY).toISOString();
  return { id: "t1", title: "کار", status: "open", percent: 0, createdAt: stamp, updatedAt: stamp, ...overrides } as CompanyBoardTask;
}

function projectWith(tasks: CompanyBoardTask[]): CompanyBoardProject {
  return { id: "p1", name: "پروژه", goal: "هدف", style: "flat", chiefBotId: "a", category: "", pinned: false, archivedAt: null, members: [], memory: [], files: [], tasks, chats: [] };
}

describe("markStaleTasks", () => {
  it("marks an open task whose conversation and record are both quiet", () => {
    const now = Date.now();
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [projectWith([openTask({ threadId: "room" })])], threads: {} };
    const marked = markStaleTasks(state, { now, staleDays: 7, activity: () => now - 30 * DAY });
    expect(marked.projects[0].tasks[0].stale).toBe(true);
    expect(marked.projects[0].tasks[0].staleDays).toBe(30);
    expect(marked.projects[0].tasks[0].status).toBe("open");
    expect(marked.projects[0].staleCount).toBe(1);
  });

  it("leaves a task alone while its conversation is active", () => {
    const now = Date.now();
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [projectWith([openTask({ threadId: "room" })])], threads: {} };
    const marked = markStaleTasks(state, { now, staleDays: 7, activity: () => now - 60_000 });
    expect(marked.projects[0].tasks[0].stale).toBeUndefined();
    expect(marked.projects[0].staleCount).toBe(0);
  });

  it("leaves a task alone until the threshold is reached", () => {
    const now = Date.now();
    const stamp = new Date(now - 3 * DAY).toISOString();
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [projectWith([openTask({ threadId: "room", createdAt: stamp, updatedAt: stamp })])], threads: {} };
    const marked = markStaleTasks(state, { now, staleDays: 7, activity: () => now - 3 * DAY });
    expect(marked.projects[0].tasks[0].stale).toBeUndefined();
  });

  it("never marks a proposed, done or rejected task", () => {
    const now = Date.now();
    const tasks = ["proposed", "done", "rejected"].map((status, index) => openTask({ id: `t${index}`, status, threadId: "room" }));
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [projectWith(tasks)], threads: {} };
    const marked = markStaleTasks(state, { now, staleDays: 1, activity: () => now - 90 * DAY });
    for (const task of marked.projects[0].tasks) expect(task.stale).toBeUndefined();
    expect(marked.projects[0].staleCount).toBe(0);
  });

  it("falls back to the owner's linked conversation when a task has no timestamp", () => {
    const now = Date.now();
    const project = { ...projectWith([{ id: "t1", title: "کار", status: "open", percent: 0, by: "bot-a" }]), chats: [{ botId: "bot-a", threadId: "room" }] };
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [project], threads: {} };
    const marked = markStaleTasks(state, { now, staleDays: 7, activity: (_threadId: string, botId?: string) => (botId === 'bot-a' ? now - 12 * DAY : undefined) });
    expect(marked.projects[0].tasks[0].stale).toBe(true);
    expect(marked.projects[0].tasks[0].staleDays).toBe(12);
  });

  it("leaves a task alone when neither the task nor its owner's conversation moved", () => {
    const now = Date.now();
    const project = { ...projectWith([{ id: "t1", title: "کار", status: "open", percent: 0, by: "bot-a" }]), chats: [{ botId: "bot-a", threadId: "room" }] };
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [project], threads: {} };
    const marked = markStaleTasks(state, { now, staleDays: 7, activity: (_threadId: string, botId?: string) => (botId === 'bot-a' ? now - 2 * DAY : undefined) });
    expect(marked.projects[0].tasks[0].stale).toBeUndefined();
  });

  it("does not change the stored state", () => {
    const now = Date.now();
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [projectWith([openTask({ threadId: "room" })])], threads: {} };
    markStaleTasks(state, { now, staleDays: 1, activity: () => now - 90 * DAY });
    expect(state.projects[0].tasks[0].stale).toBeUndefined();
    expect(state.projects[0].tasks[0].status).toBe("open");
    expect(state.projects[0].staleCount).toBeUndefined();
  });

  it("uses the default threshold when no override is given", () => {
    const now = Date.now();
    const stamp = new Date(now - (STALE_TASK_DAYS + 1) * DAY).toISOString();
    const state: CompanyBoardState = { schemaVersion: 1, revision: 1, projects: [projectWith([openTask({ threadId: "room", createdAt: stamp, updatedAt: stamp })])], threads: {} };
    expect(markStaleTasks(state, { now, activity: () => now - (STALE_TASK_DAYS + 1) * DAY }).projects[0].tasks[0].stale).toBe(true);
  });
});

function response() {
  return {
    statusCode: 200,
    headers: new Map<string, string>(),
    body: "",
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string) { this.headers.set(name, value); },
    writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.headers.set(name, value); },
    end(body = "") { this.body = body; this.headersSent = true; this.writableEnded = true; },
  };
}

async function call(feature: Awaited<ReturnType<typeof createCompanyFeature>>, path: string, method = "GET", body?: unknown, scopes = ["admin"]) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const url = new URL(`http://localhost${path}`);
  Object.assign(req, { url: `${url.pathname}${url.search}` });
  const res = response();
  await feature.route({
    req,
    res,
    url,
    path: url.pathname,
    method,
    auth: { kind: "loopback", scopes },
    json: (() => undefined) as RouteContext["json"],
    readBody: (() => Promise.resolve(body)) as RouteContext["readBody"],
  } as unknown as RouteContext);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

describe("company board stale task marker", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports a stalled task through the board API without persisting the flag", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const idle = Date.now() - 30 * DAY;
    const native = {
      bot: (id: string) => (id === "a" ? { id } : undefined),
      botByThread: (threadId: string) => (threadId === "room" ? { id: "a" } : undefined),
      taskByThread: (botId: string, threadId: string) => (botId === "a" && threadId === "room" ? { threadId, updatedAt: idle } : undefined),
      groupByThread: () => undefined,
    };
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-stale-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "پروژه", goal: "هدف", chiefBotId: "a" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id as string;
      expect((await call(feature, `/api/company/projects/${projectId}/members`, "POST", { botId: "a", role: "chief" })).status).toBe(200);
      expect((await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "room" })).status).toBe(200);
      const task = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "کار", assigneeBotId: "a", threadId: "room", accept: true, by: "user" });
      expect(task.status, JSON.stringify(task.body)).toBe(201);
      expect(task.body.status).toBe("open");

      // The task was opened a month ago and its conversation has been quiet since.
      const file = join(dataDir, "company-layer.json");
      const stored = JSON.parse(readFileSync(file, "utf8"));
      const stamp = new Date(Date.now() - 30 * DAY).toISOString();
      stored.projects[0].tasks[0].createdAt = stamp;
      stored.projects[0].tasks[0].updatedAt = stamp;
      writeFileSync(file, JSON.stringify(stored));

      const board = await call(feature, "/api/company", "GET");
      expect(board.status).toBe(200);
      expect(board.body.staleDays).toBe(STALE_TASK_DAYS);
      const boardProject = board.body.projects[0];
      expect(boardProject.tasks[0].stale).toBe(true);
      expect(boardProject.staleCount).toBe(1);
      expect(boardProject.progress.total).toBe(1);

      const persisted = JSON.parse(readFileSync(file, "utf8"));
      expect(persisted.projects[0].tasks[0].stale).toBeUndefined();
      expect(persisted.projects[0].tasks[0].status).toBe("open");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("honours a configured threshold", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    vi.stubEnv("OMB_COMPANY_STALE_DAYS", "90");
    const idle = Date.now() - 30 * DAY;
    const native = {
      bot: (id: string) => (id === "a" ? { id } : undefined),
      botByThread: (threadId: string) => (threadId === "room" ? { id: "a" } : undefined),
      taskByThread: (botId: string, threadId: string) => (botId === "a" && threadId === "room" ? { threadId, updatedAt: idle } : undefined),
      groupByThread: () => undefined,
    };
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-stale-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "پروژه", goal: "هدف", chiefBotId: "a" });
      const projectId = created.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/members`, "POST", { botId: "a", role: "chief" });
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "room" });
      await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "کار", assigneeBotId: "a", threadId: "room", accept: true, by: "user" });
      const file = join(dataDir, "company-layer.json");
      const stored = JSON.parse(readFileSync(file, "utf8"));
      const stamp = new Date(Date.now() - 30 * DAY).toISOString();
      stored.projects[0].tasks[0].createdAt = stamp;
      stored.projects[0].tasks[0].updatedAt = stamp;
      writeFileSync(file, JSON.stringify(stored));
      const board = await call(feature, "/api/company", "GET");
      expect(board.body.staleDays).toBe(90);
      expect(board.body.projects[0].tasks[0].stale).toBeUndefined();
      expect(board.body.projects[0].staleCount).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
