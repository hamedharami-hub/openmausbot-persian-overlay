import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_MODEL_FALLBACKS } from "../../shared/model-fallback.ts";
import type { ModelSelection, ProviderInstance } from "../contracts.ts";
import { DATA_DIR } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, toWireTask, type BotRecord } from "../store.ts";
import { createTaskRoutes, type TaskRouteDeps } from "./tasks.ts";
import type { RouteContext } from "./table.ts";

const primary: ModelSelection = { instanceId: "primary", model: "chat-model" };
const available = new Set(["primary:chat-model", "backup:fast", "backup:deep", "other:reasoner"]);

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function routeFixture(options: { busy?: boolean } = {}) {
  const store = new Store(() => primary);
  const bot = store.createBot({ name: "Ada" });
  const threadId = bot.threadId;
  const deps = {
    store,
    cloudHome: false,
    desktopManaged: false,
    hostedWorkspace: false,
    hostedFullAccessRefusal: "not allowed",
    hostedModels: null,
    routines: () => ({ isActiveThread: () => false }),
    coordinator: { cancelDirect: () => {} },
    handoffs: { forget: () => {} },
    skillReview: { dropThread: () => {} },
    threadStarters: { set: () => {} },
    phoneSecretSubmissions: { hasBot: () => false, hasThread: () => false },
    titleRegenerations: new Set<string>(),
    directTurnGenerationByThread: new Map<string, string>(),
    actorKey: () => "owner",
    cloudOwnerSession: () => true,
    cloudThreadRefusal: () => null,
    sharedWorkspaceFullAccessEnabled: () => false,
    supportsApprovalMode: () => true,
    threadBusy: () => options.busy === true,
    publicBot: (value: BotRecord) => value,
    wireBot: (value: BotRecord) => value,
    wireTask: toWireTask,
    pageSize: () => undefined,
    messagePage: () => ({ messages: [] }),
    checkedModelSelection: (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false as const, status: 400, error: "model is malformed" };
      const selection = raw as ModelSelection;
      return available.has(`${selection.instanceId}:${selection.model}`)
        ? { ok: true as const, selection }
        : { ok: false as const, status: 400, error: "model is unavailable" };
    },
    checkedTaskModelSwitch: () => ({ ok: true as const }),
    threadTitleGate: (_value: Pick<BotRecord, "modelSelection">) => ({ ok: false as const, refusal: "unused" }),
    generateThreadTitle: async (_provider: ProviderInstance, _text: string) => null,
    settleDirectFollowup: () => {},
    clearTurnDigestState: () => {},
    revokeInternalCapabilitiesForThread: () => {},
    stagedSkillCleanupsForThread: () => [],
    rejectDeletedThreadSkillStages: () => {},
  } as unknown as TaskRouteDeps;
  const handler = createTaskRoutes(deps);
  const patch = async (body: unknown) => {
    const sent: Array<{ status: number; body: any }> = [];
    await handler({
      req: { headers: {} } as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/bots/${bot.id}/tasks/${threadId}`),
      path: `/api/bots/${bot.id}/tasks/${threadId}`,
      method: "PATCH",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    return sent[0]!;
  };
  return { store, bot, threadId, patch };
}

describe("per-thread fallback chains", () => {
  it("saves a validated thread override and restores inheritance with null", async () => {
    const { store, bot, threadId, patch } = routeFixture();
    const botChain = [{ instanceId: "backup", model: "fast" }];
    store.patchBot(bot.id, { fallback: botChain });
    const own = [{ instanceId: "other", model: "reasoner" }];

    const saved = await patch({ fallback: own });
    expect(saved.status).toBe(200);
    expect(saved.body.task.fallback).toEqual(own);
    expect(store.projectBotForTask(bot.id, threadId)?.fallback).toEqual(own);

    const inherited = await patch({ fallback: null });
    expect(inherited.status).toBe(200);
    expect(inherited.body.task.fallback).toBeUndefined();
    expect(store.projectBotForTask(bot.id, threadId)?.fallback).toEqual(botChain);
  });

  it("rejects duplicate, primary, unavailable, oversized, and busy-thread chains without writing", async () => {
    const { store, bot, threadId, patch } = routeFixture();
    const invalid = [
      [{ instanceId: "backup", model: "fast" }, { instanceId: "backup", model: "fast" }],
      [{ instanceId: "primary", model: "chat-model" }],
      [{ instanceId: "unknown", model: "nope" }],
      Array.from({ length: MAX_MODEL_FALLBACKS + 1 }, (_, index) => ({ instanceId: "other", model: `m${index}` })),
    ];
    for (const fallback of invalid) expect((await patch({ fallback })).status).toBe(400);
    expect(store.taskByThread(bot.id, threadId)?.fallback).toBeUndefined();

    const busy = routeFixture({ busy: true });
    expect((await busy.patch({ fallback: [{ instanceId: "backup", model: "fast" }] })).status).toBe(409);
    expect(busy.store.taskByThread(busy.bot.id, busy.threadId)?.fallback).toBeUndefined();
  });
});
