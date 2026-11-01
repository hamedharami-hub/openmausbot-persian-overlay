import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as bundled from "./company-layer.mjs";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { companyPage } from "./company-page.ts";

interface NativeProjectStore {
  bots?: readonly { id: string; name?: string; section?: string; hidden?: boolean; chiefOfStaff?: boolean; title?: string; threadId?: string }[];
  groups?: readonly { id: string; name?: string; section?: string; dm?: boolean; memberIds: string[]; threadId?: string }[];
  sections?: readonly string[];
  setBotsSection?(botIds: string[], section: string): unknown;
  bot(id: string): { id?: string; section?: string } | unknown;
  botByThread(threadId: string): { id: string; section?: string } | null | undefined;
  taskByThread(botId: string, threadId: string): unknown;
  groupByThread(threadId: string): { memberIds: string[]; section?: string } | undefined;
  /** Epoch ms of the newest message in a thread, when the native store knows it. */
  threadActivity?(threadId: string): number | undefined;
}

/** Days without activity before an open task is marked as stalled. The status is never changed. */
function staleDaysFromEnv(): number | undefined {
  const raw = process.env.OMB_COMPANY_STALE_DAYS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > 365) return undefined;
  return value;
}

export async function createCompanyFeature(native: NativeProjectStore, dataDir: string) {
  const module: typeof bundled = process.env.OMB_COMPANY_MODULE
    ? await import(pathToFileURL(resolve(process.env.OMB_COMPANY_MODULE)).href)
    : bundled;
  const store = module.createStore(join(dataDir, "company-layer.json"));
  /** The newest message time of a linked conversation, so a stalled task can be spotted. */
  const threadActivity = (threadId: string, botId?: string): number | undefined => {
    if (!threadId) return undefined;
    // A task's conversation belongs to a bot, and the bot's own thread is not that conversation.
    if (botId) {
      const task = native.taskByThread(botId, threadId) as { updatedAt?: number } | undefined;
      if (Number.isFinite(task?.updatedAt)) return task?.updatedAt;
    }
    if (typeof native.threadActivity === "function") return native.threadActivity(threadId);
    const group = native.groupByThread(threadId) as { tasks?: readonly { threadId: string; updatedAt?: number }[] } | undefined;
    const groupTask = group?.tasks?.find(candidate => candidate.threadId === threadId);
    return Number.isFinite(groupTask?.updatedAt) ? groupTask?.updatedAt : undefined;
  };
  const staleDays = staleDaysFromEnv();
  const route: RouteHandler = async ctx => {
    if (!(ctx.path === "/company" || ctx.path === "/company/" || ctx.path === "/api/company" || ctx.path.startsWith("/api/company/"))) return PASS;
    if (ctx.method === "GET" && (ctx.path === "/company" || ctx.path === "/company/" || ctx.path === "/api/company/ui") && ctx.auth.scopes.includes("admin")) {
      ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      ctx.res.end(companyPage);
      return;
    }
    const handled = await module.companyHandle(ctx.req, ctx.res, {
      method: ctx.method, path: ctx.path, auth: ctx.auth,
      native,
      threadActivity,
      staleDays,
      ensureSection: (section, botIds) => {
        if (native.setBotsSection && section) native.setBotsSection(botIds, section);
      },
      botExists: id => Boolean(native.bot(id)),
      threadExists: id => Boolean(native.botByThread(id) || native.groupByThread(id)),
      canLinkThread: (botId, threadId) => Boolean(native.taskByThread(botId, threadId) || native.groupByThread(threadId)?.memberIds.includes(botId)),
    }, store, join(dataDir, "bots.json"));
    return handled ? undefined : PASS;
  };
  const prompt = (botId: string, threadId?: string) => {
    const bot = native.bot(botId) as { section?: string } | undefined;
    if (!threadId || !bot) return "";
    const group = native.groupByThread(threadId);
    if (group) {
      if (!group.memberIds.includes(botId)) return "";
    } else if (native.botByThread(threadId)?.id !== botId || !native.taskByThread(botId, threadId)) {
      return "";
    }
    const sectionHint = group?.section || bot.section || "";
    return module.companyLayerPrompt(store, botId, threadId, sectionHint);
  };
  const internalTaskTools = async (input: {
    method: string;
    path: string;
    botId: string;
    threadId: string;
    res: Parameters<RouteHandler>[0]["res"];
    json: Parameters<RouteHandler>[0]["json"];
    readBody(): Promise<unknown>;
    requireActive(): void;
  }): Promise<boolean> => {
    const proposalPath = input.method === "POST" && input.path === "/api/internal/company/proposals";
    const decision = input.method === "POST" ? /^\/api\/internal\/company\/projects\/([^/]+)\/tasks\/([^/]+)\/decision$/.exec(input.path) : null;
    if (!proposalPath && !decision) return false;
    try {
      input.requireActive();
      const group = native.groupByThread(input.threadId);
      const liveDirect = native.botByThread(input.threadId)?.id === input.botId && Boolean(native.taskByThread(input.botId, input.threadId));
      if (!(group?.memberIds.includes(input.botId) || liveDirect)) {
        return input.json(input.res, 403, { error: "This project action requires your live direct conversation or a room you still belong to." }), true;
      }
      const body = await input.readBody();
      if (!body || typeof body !== "object" || Array.isArray(body)) return input.json(input.res, 400, { error: "expected a JSON object" }), true;
      input.requireActive();
      if (proposalPath) {
        if (typeof (body as Record<string, unknown>).requestId !== "string" || !(body as Record<string, unknown>).requestId) {
          return input.json(input.res, 400, { error: "requestId is required so a retry cannot create duplicate work" }), true;
        }
        const result = module.proposeTaskFromBot(store, { ...(body as Record<string, unknown>), botId: input.botId, threadId: input.threadId });
        input.requireActive();
        return input.json(input.res, 201, result), true;
      }
      const result = module.decideTaskAsChief(store, {
        ...(body as Record<string, unknown>), projectId: decision![1], taskId: decision![2], botId: input.botId, threadId: input.threadId,
      });
      input.requireActive();
      return input.json(input.res, 200, result), true;
    } catch (cause) {
      const error = cause as Error & { status?: number };
      if (error.status === 401) return input.json(input.res, 401, { error: error.message || "The internal turn capability has expired." }), true;
      return input.json(input.res, error.status ?? 500, { error: error.status ? error.message : "Project task operation failed." }), true;
    }
  };
  const active = (botId: string, threadId: string) => {
    const bot = native.bot(botId) as { section?: string } | undefined;
    const group = native.groupByThread(threadId);
    if (!bot || (group ? !group.memberIds.includes(botId) : native.botByThread(threadId)?.id !== botId || !native.taskByThread(botId, threadId))) return false;
    const section = (group?.section || bot.section || "").trim();
    return store.load().projects.some(project => project.members.some(member => member.botId === botId) &&
      (project.chats.some(chat => chat.threadId === threadId && chat.botId === botId) ||
        (!project.archivedAt && section && ((project.section || "").trim() === section || (!project.section && project.name.trim() === section)))));
  };
  return { route, prompt, internalTaskTools, active };
}
