import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyFeature } from "./company-feature.ts";
import type { RouteContext } from "./routes/table.ts";

const native = {
  bot: (id: string) => ["a", "b", "c"].includes(id) ? { id } : undefined,
  botByThread: (threadId: string) => threadId === "direct-a" ? { id: "a" } : undefined,
  taskByThread: (botId: string, threadId: string) => botId === "a" && threadId === "direct-a" ? { threadId } : undefined,
  groupByThread: (threadId: string) => threadId === "shared-room" ? { memberIds: ["a", "b"] } : undefined,
};

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
  return { status: res.statusCode, headers: res.headers, body: res.headers.get("content-type")?.startsWith("text/html") ? res.body : res.body ? JSON.parse(res.body) : undefined };
}

describe("company feature adapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps project context scoped to authorized project members and linked native threads", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-feature-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      expect((await call(feature, "/api/company", "GET", undefined, ["client"])).status).toBe(403);

      const created = await call(feature, "/api/company/projects", "POST", { name: "Shared research", goal: "Keep separate", chiefBotId: "a" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const projectId = created.body.id as string;
      expect((await call(feature, `/api/company/projects/${projectId}/members`, "POST", { botId: "b" })).status).toBe(200);
      expect((await call(feature, `/api/company/projects/${projectId}/members`, "POST", { botId: "c" })).status).toBe(200);
      expect((await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "shared-room" })).status).toBe(200);
      expect((await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "b", threadId: "shared-room" })).status).toBe(200);
      expect((await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "c", threadId: "shared-room" })).status).toBe(404);

      expect(feature.prompt("a", "shared-room")).toContain("Project focus: Shared research");
      expect(feature.active("a", "shared-room")).toBe(true);
      expect(feature.active("c", "shared-room")).toBe(false);
      expect(feature.active("a", "direct-a")).toBe(false);
      expect(feature.prompt("b", "shared-room")).toContain("Project focus: Shared research");
      expect(feature.prompt("c", "shared-room")).not.toContain("Project focus: Shared research");
      expect(feature.prompt("a", "direct-a")).not.toContain("Project focus: Shared research");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("serves the standalone board under the native authenticated route", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-project-url-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const page = await call(feature, "/api/company/ui?project=project-123");
      expect(page.status).toBe(200);
      expect(page.body).toContain('<html lang="fa" dir="rtl">');
      expect(page.body).toContain("/api/company");
      expect(page.headers.has("location")).toBe(false);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect((await call(feature, "/api/company/ui", "GET", undefined, ["client"])).status).toBe(403);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not promise that project roles can bypass native peer coordination or approvals", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-rights-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Honest hierarchy", chiefBotId: "a" });
      const projectId = created.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "direct-a" });
      const prompt = feature.prompt("a", "direct-a");
      expect(prompt).toContain("project role does not itself send assignments or authorize a handoff");
      expect(prompt).toContain("native coordination route");
      expect(prompt).toContain("cannot remove that requirement");
      expect(prompt).not.toContain("direct members without asking");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps proposed shared memory out of agent context until an admin approves it", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-memory-approval-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const project = await call(feature, "/api/company/projects", "POST", { name: "Approved memory", chiefBotId: "a" });
      const projectId = project.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "direct-a" });
      await call(feature, "/api/company/threads/direct-a", "PUT", {
        summary: { decisions: "SAVED_DECISION", tasks: "SAVED_OPEN_TASK", facts: "SAVED_FACT" },
      });
      const proposal = await call(feature, `/api/company/projects/${projectId}/memory`, "POST", { text: "APPROVED_SHARED_FACT", by: "a" });
      expect(proposal).toMatchObject({ status: 201, body: { status: "proposed", by: "a" } });
      expect(feature.prompt("a", "direct-a")).not.toContain("APPROVED_SHARED_FACT");
      expect(await call(feature, `/api/company/projects/${projectId}/memory/${proposal.body.id}`, "POST", { approve: true })).toMatchObject({ status: 200, body: { status: "approved" } });
      expect(feature.prompt("a", "direct-a")).toContain("APPROVED_SHARED_FACT");
      const rejected = await call(feature, `/api/company/projects/${projectId}/memory`, "POST", { text: "REJECTED_SHARED_FACT", by: "b" });
      await call(feature, `/api/company/projects/${projectId}/memory/${rejected.body.id}`, "POST", { approve: false });
      expect(feature.prompt("a", "direct-a")).not.toContain("REJECTED_SHARED_FACT");
      expect((await call(feature, "/api/company", "GET", undefined, ["client"])).status).toBe(403);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("lets a linked member propose a task and only the linked chief decide it without starting work", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-chief-task-decision-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Review gate", chiefBotId: "a" });
      const projectId = created.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/members`, "POST", { botId: "b" });
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "direct-a" });
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "b", threadId: "shared-room" });

      const callInternal = async (botId: string, threadId: string, path: string, body: unknown) => {
        const res = response();
        const handled = await feature.internalTaskTools({
          method: "POST", path, botId, threadId, res: res as unknown as RouteContext["res"],
          json: ((_res, status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); }) as RouteContext["json"],
          readBody: async () => body,
          requireActive: () => undefined,
        });
        return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
      };

      const proposalPath = "/api/internal/company/proposals";
      const first = await callInternal("b", "shared-room", proposalPath, { title: "Review evidence", requestId: "review-evidence-once", botId: "a", threadId: "direct-a" });
      expect(first).toMatchObject({ handled: true, status: 201, body: { task: { status: "proposed", by: "b" } } });
      const proposalId = first.body.task.id as string;
      expect(first.body.task).not.toHaveProperty("botId");
      const duplicate = await callInternal("b", "shared-room", proposalPath, { title: "Review evidence", requestId: "review-evidence-once" });
      expect(duplicate.body.task.id).toBe(proposalId);
      expect(duplicate.body.revision).toBe(first.body.revision);

      const decisionPath = `/api/internal/company/projects/${projectId}/tasks/${proposalId}/decision`;
      const memberDecision = await callInternal("b", "shared-room", decisionPath, { expectedRevision: duplicate.body.revision, accept: true });
      expect(memberDecision).toMatchObject({ handled: true, status: 403 });
      const unlinkedChief = await callInternal("a", "unlinked-chief-thread", decisionPath, { expectedRevision: duplicate.body.revision, accept: true });
      expect(unlinkedChief).toMatchObject({ handled: true, status: 403 });
      const stale = await callInternal("a", "direct-a", decisionPath, { expectedRevision: duplicate.body.revision - 1, accept: true });
      expect(stale).toMatchObject({ handled: true, status: 409 });
      expect(feature.prompt("a", "direct-a")).toContain("Pending proposals:");
      const accepted = await callInternal("a", "direct-a", decisionPath, { expectedRevision: duplicate.body.revision, accept: true });
      expect(accepted).toMatchObject({ handled: true, status: 200, body: { task: { id: proposalId, status: "open" } } });
      expect(accepted.body.task.assigneeBotId).toBeUndefined();
      expect(feature.prompt("a", "direct-a")).toContain("Acceptance adds a task to the project board only");
      expect((await call(feature, "/api/company")).body.projects[0].tasks).toHaveLength(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps thread notes scoped separately from approved project memory", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-memory-scope-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const project = await call(feature, "/api/company/projects", "POST", { name: "Layered memory", chiefBotId: "a" });
      const projectId = project.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "direct-a" });
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "shared-room" });
      const memory = await call(feature, `/api/company/projects/${projectId}/memory`, "POST", { text: "PROJECT_SCOPE_MEMORY", by: "a" });
      await call(feature, `/api/company/projects/${projectId}/memory/${memory.body.id}`, "POST", { approve: true });
      await call(feature, "/api/company/threads/direct-a", "PUT", { notes: "THREAD_SCOPE_NOTE" });

      const directPrompt = feature.prompt("a", "direct-a");
      const groupPrompt = feature.prompt("a", "shared-room");
      const unrelatedPrompt = feature.prompt("a", "unlinked-thread");
      expect(directPrompt).toContain("This chat's own notes: THREAD_SCOPE_NOTE");
      expect(directPrompt).toContain("Approved project memory: PROJECT_SCOPE_MEMORY");
      expect(groupPrompt).not.toContain("THREAD_SCOPE_NOTE");
      expect(groupPrompt).toContain("Approved project memory: PROJECT_SCOPE_MEMORY");
      expect(unrelatedPrompt).not.toContain("PROJECT_SCOPE_MEMORY");
      expect(unrelatedPrompt).not.toContain("THREAD_SCOPE_NOTE");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reuses bounded project goal, open work, and verified results as saved context", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-saved-context-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const project = await call(feature, "/api/company/projects", "POST", { name: "Saved context", goal: "PROJECT_GOAL_EVIDENCE", chiefBotId: "a" });
      const projectId = project.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId: "a", threadId: "direct-a" });
      await call(feature, "/api/company/threads/direct-a", "PUT", {
        summary: { decisions: "SAVED_DECISION", tasks: "SAVED_OPEN_TASK", facts: "SAVED_FACT" },
      });
      const proposed = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "Verified outcome" });
      const taskId = proposed.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true });
      const current = await call(feature, "/api/company");
      await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", {
        status: "done", result: "VERIFIED_RESULT_EVIDENCE", expectedRevision: current.body.revision,
      });
      await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/verify`, "POST", {});

      const prompt = feature.prompt("a", "direct-a");
      expect(prompt).toContain("Goal: PROJECT_GOAL_EVIDENCE");
      expect(prompt).toContain("decisions: SAVED_DECISION");
      expect(prompt).toContain("tasks: SAVED_OPEN_TASK");
      expect(prompt).toContain("Project task summary");
      expect(prompt).toContain("verified result: VERIFIED_RESULT_EVIDENCE");
      expect(feature.prompt("a", "unlinked-thread")).not.toContain("VERIFIED_RESULT_EVIDENCE");
      expect((await call(feature, "/api/company")).body.projects[0].tasks[0]).toMatchObject({
        status: "done", verified: true, result: "VERIFIED_RESULT_EVIDENCE",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps completed project tasks terminal while allowing an idempotent done retry", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-task-terminal-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Task lifecycle" });
      const projectId = created.body.id as string;
      const proposed = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "Finish the task" });
      const taskId = proposed.body.id as string;
      expect((await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true })).status).toBe(200);
      const beforeDone = await call(feature, "/api/company");
      const done = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", { status: "done", expectedRevision: beforeDone.body.revision });
      expect(done).toMatchObject({ status: 200, body: { status: "done", percent: 100 } });

      const afterDone = await call(feature, "/api/company");
      const reopen = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", { status: "open", expectedRevision: afterDone.body.revision });
      expect(reopen.status).toBe(409);
      const retry = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", { status: "done", expectedRevision: afterDone.body.revision });
      expect(retry).toMatchObject({ status: 200, body: { status: "done", percent: 100 } });
      expect((await call(feature, "/api/company")).body.revision).toBe(afterDone.body.revision);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps duplicate project task acceptance idempotent", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-task-accept-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Task acceptance" });
      const projectId = created.body.id as string;
      const proposed = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "Accept once" });
      const taskId = proposed.body.id as string;
      const beforeAccept = await call(feature, "/api/company");
      const accepted = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true, expectedRevision: beforeAccept.body.revision });
      expect(accepted).toMatchObject({ status: 200, body: { status: "open" } });
      const afterAccept = await call(feature, "/api/company");
      const retry = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true, expectedRevision: afterAccept.body.revision });
      expect(retry).toMatchObject({ status: 200, body: { status: "open" } });
      expect((await call(feature, "/api/company")).body.revision).toBe(afterAccept.body.revision);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps bot-authored tasks as proposals even when the request asks to accept them", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-bot-task-proposal-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const project = await call(feature, "/api/company/projects", "POST", { name: "Explicit task decision" });
      const projectId = project.body.id as string;
      const proposal = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", {
        title: "Review before work starts", by: "bot", accept: true, percent: 100,
      });
      expect(proposal).toMatchObject({ status: 201, body: { status: "proposed", percent: 0 } });
      expect((await call(feature, "/api/company")).body.projects[0].progress).toMatchObject({ total: 0, verified: 0, percent: null });
      const accepted = await call(feature, `/api/company/projects/${projectId}/tasks/${proposal.body.id}/accept`, "POST", { accept: true });
      expect(accepted).toMatchObject({ status: 200, body: { status: "open", percent: 0 } });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("creates only one task for a repeated request id", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-task-request-id-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Task request identity" });
      const projectId = created.body.id as string;
      const body = { title: "Send one proposal", requestId: "proposal-once", by: "bot" };
      const first = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", body);
      const retry = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", body);
      expect(retry.body.id).toBe(first.body.id);
      expect((await call(feature, "/api/company")).body.projects[0].tasks).toHaveLength(1);
      expect(await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { ...body, title: "A different request" })).toMatchObject({ status: 409, body: { error: "requestId already used for a different task" } });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records failed execution attempts without completing the task and preserves them across retries", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-task-failure-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Failure history" });
      const projectId = created.body.id as string;
      const proposed = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "Keep attempt history" });
      const taskId = proposed.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true });
      const inventory = await call(feature, "/api/company");
      const failure = { failureId: "attempt-one", reason: "Provider quota exhausted", blockedKind: "quota", nextAction: "Retry after quota reset", expectedRevision: inventory.body.revision };
      expect(await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/failures`, "POST", { ...failure, failureId: "bad-kind", blockedKind: "not-a-category" })).toMatchObject({ status: 400, body: { error: "blockedKind is not supported" } });
      const recorded = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/failures`, "POST", failure);
      expect(recorded).toMatchObject({ status: 201, body: { id: "attempt-one", reason: "Provider quota exhausted", blockedKind: "quota" } });
      const afterFailure = await call(feature, "/api/company");
      expect(afterFailure.body.projects[0].tasks[0]).toMatchObject({ status: "open", blockedKind: "quota", executionFailures: [{ id: "attempt-one", reason: "Provider quota exhausted", blockedKind: "quota" }] });
      expect(afterFailure.body.projects[0].progress).toMatchObject({ total: 1, verified: 0, percent: 0 });
      expect(afterFailure.body.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "execution_failed", taskId, projectId, actor: expect.any(String) })]));

      const restarted = await createCompanyFeature(native, dataDir);
      expect((await call(restarted, "/api/company")).body.projects[0].tasks[0]).toMatchObject({ blockedKind: "quota", executionFailures: [{ id: "attempt-one", blockedKind: "quota" }] });

      const retried = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/failures`, "POST", failure);
      expect(retried.status).toBe(201);
      const reused = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/failures`, "POST", { ...failure, reason: "Different failure" });
      expect(reused).toMatchObject({ status: 409, body: { error: "failureId already used for different failure details" } });
      const reclassified = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/failures`, "POST", { ...failure, blockedKind: "tool_error" });
      expect(reclassified).toMatchObject({ status: 409, body: { error: "failureId already used for different failure details" } });
      expect((await call(feature, "/api/company")).body.projects[0].tasks[0].executionFailures).toHaveLength(1);
      const reopened = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", { reopen: true, expectedRevision: afterFailure.body.revision });
      expect(reopened.status).toBe(200);
      expect((await call(feature, "/api/company")).body.projects[0].tasks[0].executionFailures).toHaveLength(1);
      const current = await call(feature, "/api/company");
      const secondAttempt = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/failures`, "POST", { ...failure, failureId: "attempt-two", reason: "Retry also failed", expectedRevision: current.body.revision });
      expect(secondAttempt.status).toBe(201);
      expect((await call(feature, "/api/company")).body.projects[0].tasks[0].executionFailures).toHaveLength(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([-1, 101, "50", null])("rejects invalid project task progress %s", async percent => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-task-progress-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Task progress" });
      const projectId = created.body.id as string;
      const proposed = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "Keep progress bounded" });
      const taskId = proposed.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true });
      const result = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", { percent });
      expect(result.status).toBe(400);
      expect((await call(feature, "/api/company")).body.projects[0].tasks[0].percent).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects stale project task updates with 409 without changing progress", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-task-revision-"));
    try {
      const feature = await createCompanyFeature(native, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Task revision" });
      const projectId = created.body.id as string;
      const staleRevision = (await call(feature, "/api/company")).body.revision as number;
      const proposed = await call(feature, `/api/company/projects/${projectId}/tasks`, "POST", { title: "Reject stale write" });
      const taskId = proposed.body.id as string;
      const currentRevision = (await call(feature, "/api/company")).body.revision as number;
      await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}/accept`, "POST", { accept: true, expectedRevision: currentRevision });

      const stale = await call(feature, `/api/company/projects/${projectId}/tasks/${taskId}`, "PATCH", { percent: 75, expectedRevision: staleRevision });
      expect(stale).toMatchObject({ status: 409, body: { error: "Project data changed. Reload before saving." } });
      expect((await call(feature, "/api/company")).body.projects[0].tasks[0]).toMatchObject({ status: "open", percent: 0 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("withdraws group context immediately when a native member is removed, without changing project data", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-roster-"));
    let members = ["a", "b"];
    const changingNative = { ...native, groupByThread: (threadId: string) => threadId === "shared-room" ? { memberIds: members } : undefined };
    try {
      const feature = await createCompanyFeature(changingNative, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Private project", chiefBotId: "a" });
      const projectId = created.body.id as string;
      await call(feature, `/api/company/projects/${projectId}/members`, "POST", { botId: "b" });
      for (const botId of members) await call(feature, `/api/company/projects/${projectId}/chats`, "POST", { botId, threadId: "shared-room" });
      await call(feature, "/api/company/threads/shared-room", "PUT", { notes: "PRIVATE_THREAD_NOTE" });
      expect(feature.prompt("a", "shared-room")).toContain("PRIVATE_THREAD_NOTE");
      const file = join(dataDir, "company-layer.json");
      const original = readFileSync(file, "utf8");

      members = ["b"];
      expect(feature.prompt("a", "shared-room")).toBe("");
      expect(feature.prompt("b", "shared-room")).toContain("Project focus: Private project");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("withdraws context after a native thread is deleted or changes owner, without changing saved links", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-thread-"));
    let owner: string | undefined = "a";
    const changingNative = {
      ...native,
      botByThread: (threadId: string) => threadId === "direct-a" && owner ? { id: owner } : undefined,
      taskByThread: (botId: string, threadId: string) => threadId === "direct-a" && botId === "a" ? { threadId } : undefined,
    };
    try {
      const feature = await createCompanyFeature(changingNative, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Direct project", chiefBotId: "a" });
      await call(feature, `/api/company/projects/${created.body.id}/chats`, "POST", { botId: "a", threadId: "direct-a" });
      await call(feature, "/api/company/threads/direct-a", "PUT", { notes: "PRIVATE_DIRECT_NOTE" });
      expect(feature.prompt("a", "direct-a")).toContain("PRIVATE_DIRECT_NOTE");
      const file = join(dataDir, "company-layer.json");
      const original = readFileSync(file, "utf8");

      owner = "b";
      expect(feature.prompt("a", "direct-a")).toBe("");
      owner = undefined;
      expect(feature.prompt("a", "direct-a")).toBe("");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("withdraws context after a native group or bot disappears", async () => {
    vi.stubEnv("OMB_COMPANY_MODULE", "");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-company-deleted-"));
    let groupExists = true;
    let botExists = true;
    const changingNative = {
      ...native,
      bot: (id: string) => botExists ? native.bot(id) : undefined,
      groupByThread: (threadId: string) => groupExists ? native.groupByThread(threadId) : undefined,
    };
    try {
      const feature = await createCompanyFeature(changingNative, dataDir);
      const created = await call(feature, "/api/company/projects", "POST", { name: "Group project", chiefBotId: "a" });
      await call(feature, `/api/company/projects/${created.body.id}/chats`, "POST", { botId: "a", threadId: "shared-room" });
      expect(feature.prompt("a", "shared-room")).toContain("Project focus:");
      groupExists = false;
      expect(feature.prompt("a", "shared-room")).toBe("");
      groupExists = true;
      botExists = false;
      expect(feature.prompt("a", "shared-room")).toBe("");
      expect(feature.prompt("a")).toBe("");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
