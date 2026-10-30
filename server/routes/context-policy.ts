import { contextPolicySchema, readContextPolicy, saveContextPolicy } from "../context-policy.ts";
import { contextBudgetSettings, saveContextBudget } from "../context-policy.ts";
import { contextBudgetSchema } from "../../shared/context-budget.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Message } from "../store.ts";

export function createMessageImportanceRoutes(deps: {
  mark(threadId: string, messageId: string, important: boolean, auth: RequestAuth): Message;
  list(threadId: string, auth: RequestAuth): { messages: Pick<Message, "id" | "text" | "role" | "at">[]; total: number };
}): RouteHandler {
  return async ({ req, res, path, method, auth, readBody, json }) => {
    const list = path.match(/^\/api\/threads\/([\w-]+)\/important$/);
    if (list && method === "GET") return json(res, 200, deps.list(list[1]!, auth));
    const m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/important$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    if (typeof body?.important !== "boolean") return json(res, 400, { error: "important must be a boolean" });
    return json(res, 200, { message: deps.mark(m[1], m[2], body.important, auth) });
  };
}

export function createContextPolicyRoutes(deps: {
  resolve(kind: "bots" | "groups", id: string, threadId: unknown, auth: RequestAuth, write: boolean): { threadId: string; summary?: string; busy: boolean };
  compact(kind: "bots" | "groups", id: string, threadId: string, auth: RequestAuth): Promise<void>;
  threadVisible?(auth: RequestAuth, threadId: string): boolean;
}): RouteHandler {
  return async ({ req, res, path, method, url, auth, readBody, json }) => {
    const m = path.match(/^\/api\/(bots|groups)\/([\w-]+)\/context$/);
    if (!m || !["GET", "PATCH", "POST"].includes(method)) return PASS;
    const body = method === "GET" ? null : await readBody(req);
    const threadId = body?.threadId ?? url.searchParams.get("threadId");
    if (typeof threadId !== "string" || !/^[\w-]{1,128}$/.test(threadId)) return json(res, 400, { error: "A conversation threadId is required" });
    if (deps.threadVisible && !deps.threadVisible(auth, threadId)) return json(res, 404, { error: "no such conversation" });
    const kind = m[1] as "bots" | "groups";
    const target = deps.resolve(kind, m[2], threadId, auth, method !== "GET");
    if (method === "PATCH") {
      if (body?.budget !== undefined) {
        if (body.policy !== undefined) return json(res, 400, { error: "Save summary and budget settings separately" });
        const scope = body.budgetScope ?? "thread";
        if (scope !== "thread" && scope !== "bot") return json(res, 400, { error: "Invalid budget scope" });
        if (scope === "bot" && (kind !== "bots" || !auth.scopes.includes("admin"))) return json(res, 403, { error: "Bot defaults require owner access to a bot conversation" });
        const parsed = contextBudgetSchema.safeParse(body.budget);
        if (!parsed.success) return json(res, 400, { error: "Invalid context budget settings" });
        saveContextBudget(scope, scope === "thread" ? target.threadId : m[2], parsed.data);
        return json(res, 200, { contextBudget: contextBudgetSettings(target.threadId, kind === "bots" ? m[2] : undefined) });
      }
      const parsed = contextPolicySchema.safeParse(body?.policy);
      if (!parsed.success) return json(res, 400, { error: "Invalid summary settings" });
      return json(res, 200, { policy: saveContextPolicy(target.threadId, parsed.data) });
    }
    if (method === "POST") {
      if (target.busy) return json(res, 409, { error: "Wait for the conversation to finish before summarizing" });
      await deps.compact(kind, m[2], target.threadId, auth);
      return json(res, 202, { ok: true });
    }
    return json(res, 200, { policy: readContextPolicy(target.threadId), summary: target.summary ?? "", busy: target.busy,
      canEditBotDefaults: kind === "bots" && auth.scopes.includes("admin"),
      contextBudget: contextBudgetSettings(target.threadId, kind === "bots" ? m[2] : undefined) });
  };
}
