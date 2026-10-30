// The OpenAI key is never read or written here; without one a start answers 409 `needsKey`. A phone can never send device-revoked.
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LiveSettings } from "../../shared/wire.ts";
import { LiveSessionError, MAX_SDP_BYTES } from "../live-call.ts";
import { LiveCallBusyError, type LiveCallController } from "../live-call-controller.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface LiveRouteDeps {
  calls: Pick<LiveCallController, "start" | "end" | "current" | "deviceRevoked">;
  resolveTarget(botId: string, threadId: string | undefined): { botId: string; botName: string; threadId: string } | null;
  threadVisible?(auth: RequestAuth, threadId: string): boolean;
  settings(): LiveSettings;
  saveSettings(patch: { provider?: "openai" | "gemini"; voice?: string; geminiVoice?: string; readTypedReplies?: boolean; idleMinutes?: number }): Promise<LiveSettings>;
  geminiToken?(input: { auth: RequestAuth; botId: string; botName: string; threadId: string }): Promise<{ token: string; setup: Record<string, unknown>; initialTurns: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> }>;
  delegate?(input: { auth: RequestAuth; botId: string; threadId: string; text: string }): Promise<{ accepted: boolean; queued?: boolean }>;
}

const id = z.string().regex(/^[\w-]{1,120}$/);
const sessionBody = z.object({
  botId: id,
  threadId: id.optional(),
  // Not trimmed: the SDP offer goes to OpenAI byte for byte.
  sdp: z.string().min(1).refine((sdp) => Buffer.byteLength(sdp) <= MAX_SDP_BYTES),
  client: z.enum(["desktop", "web", "ios", "android"]),
}).strict();
const endBody = z.object({ callId: z.string().min(1).max(120) }).strict();
// Strict, so `key` is refused rather than ignored: the key is saved only through the credential store or PUT /api/config.
const settingsBody = z.object({
  provider: z.enum(["openai", "gemini"]).optional(),
  voice: z.string().trim().max(40).regex(/^[a-z]*$/).optional(),
  geminiVoice: z.string().trim().max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional(),
  readTypedReplies: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(60).optional(),
}).strict();
const geminiTargetBody = z.object({ botId: id, threadId: id.optional() }).strict();
const geminiEndBody = z.object({ callId: z.string().regex(/^gemini-[\w-]{1,120}$/) }).strict();
const geminiDelegateBody = z.object({ callId: z.string().regex(/^gemini-[\w-]{1,120}$/), botId: id, threadId: id, text: z.string().trim().min(1).max(3_000) }).strict();

const DEVICE_ID = /^[\w-]{1,128}$/;

/** The companion sends its own id for the phone that authenticated, never one the phone chose. */
function companionDevice(req: IncomingMessage): string | undefined {
  if (req.headers["x-openmausbot-companion"] !== "1") return undefined;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}

async function bodyOf(req: IncomingMessage, readBody: RouteContext["readBody"]): Promise<unknown> {
  try {
    return await readBody(req);
  } catch {
    return undefined;
  }
}

export function createLiveRoutes(deps: LiveRouteDeps): RouteHandler {
  let geminiLease: { callId: string; botId: string; threadId: string; expiresAt: number } | null = null;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/live/")) return PASS;

    if (method === "POST" && path === "/api/live/session") {
      const parsed = sessionBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The call request was not valid." });
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      if (deps.threadVisible && !deps.threadVisible(auth, target.threadId)) return json(res, 404, { error: "That bot or chat does not exist." });
      try {
        const device = companionDevice(req);
        const { call, sdp } = await deps.calls.start({ auth, ...(device ? { device } : {}), ...target, client: parsed.data.client, sdp: parsed.data.sdp });
        return json(res, 201, { call, transport: { type: "webrtc", sdp } });
      } catch (error) {
        if (error instanceof LiveCallBusyError) return json(res, 409, { error: error.message, activeCall: error.call });
        if (error instanceof LiveSessionError) {
          return json(res, error.status, error.status === 409 ? { error: error.message, needsKey: true } : { error: error.message });
        }
        throw error;
      }
    }

    if (method === "POST" && path === "/api/live/gemini/token") {
      const parsed = geminiTargetBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The Gemini Live request was not valid." });
      if (!deps.geminiToken) return json(res, 501, { error: "Gemini Live is not available in this server build." });
      if (deps.settings().provider !== "gemini") return json(res, 409, { error: "Choose Gemini in Live settings before starting a Gemini call." });
      if (deps.calls.current()) return json(res, 409, { error: "Another Live call is already running." });
      if (geminiLease && geminiLease.expiresAt <= Date.now()) geminiLease = null;
      if (geminiLease) return json(res, 409, { error: "Another Gemini Live call is already running." });
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      if (deps.threadVisible && !deps.threadVisible(auth, target.threadId)) return json(res, 404, { error: "That bot or chat does not exist." });
      // Reserve before awaiting Google so two concurrent token requests cannot both create sessions.
      const callId = `gemini-${randomUUID()}`;
      geminiLease = { callId, botId: target.botId, threadId: target.threadId, expiresAt: Date.now() + 60_000 };
      try {
        const session = await deps.geminiToken({ auth, ...target });
        if (geminiLease?.callId !== callId) return json(res, 409, { error: "The Gemini Live session expired before it could start." });
        geminiLease.expiresAt = Date.now() + 15 * 60_000;
        return json(res, 200, { ...session, callId, idleMinutes: deps.settings().idleMinutes });
      } catch (error) {
        if (geminiLease?.callId === callId) geminiLease = null;
        if (error instanceof LiveSessionError) return json(res, error.status, { error: error.message, ...(error.status === 409 ? { needsKey: true } : {}) });
        throw error;
      }
    }

    if (method === "POST" && path === "/api/live/gemini/end") {
      const parsed = geminiEndBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The Gemini Live end request was not valid." });
      if (!geminiLease || geminiLease.callId !== parsed.data.callId) return json(res, 404, { error: "That Gemini Live call is no longer running." });
      if (deps.threadVisible && !deps.threadVisible(auth, geminiLease.threadId)) return json(res, 404, { error: "That Gemini Live call is no longer running." });
      geminiLease = null;
      return json(res, 200, { ended: true });
    }

    if (method === "POST" && path === "/api/live/gemini/delegate") {
      const parsed = geminiDelegateBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The delegated request was not valid." });
      if (!deps.delegate) return json(res, 501, { error: "Agent handoff is not available in this server build." });
      if (!geminiLease || geminiLease.callId !== parsed.data.callId || geminiLease.expiresAt <= Date.now() || geminiLease.botId !== parsed.data.botId || geminiLease.threadId !== parsed.data.threadId) {
        return json(res, 409, { error: "The Gemini Live session is no longer active." });
      }
      const target = deps.resolveTarget(parsed.data.botId, parsed.data.threadId);
      if (!target) return json(res, 404, { error: "That bot or chat does not exist." });
      if (deps.threadVisible && !deps.threadVisible(auth, target.threadId)) return json(res, 404, { error: "That bot or chat does not exist." });
      try {
        return json(res, 200, await deps.delegate({ auth, botId: target.botId, threadId: target.threadId, text: parsed.data.text }));
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500;
        return json(res, status, { error: status === 401 ? "The sign-in that started this call has ended." : "The task could not be handed to the agent." });
      }
    }

    if (method === "POST" && path === "/api/live/call/end") {
      const parsed = endBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) return json(res, 400, { error: "The request was not valid." });
      const current = deps.calls.current();
      if (current && deps.threadVisible && !deps.threadVisible(auth, current.threadId)) return json(res, 404, { error: "That call is not running." });
      const call = await deps.calls.end(parsed.data.callId);
      return call ? json(res, 200, { call }) : json(res, 404, { error: "That call is not running." });
    }

    if (method === "GET" && path === "/api/live/call") {
      const call = deps.calls.current();
      return json(res, 200, { call: call && (!deps.threadVisible || deps.threadVisible(auth, call.threadId)) ? call : null });
    }

    if (method === "POST" && path === "/api/live/device-revoked") {
      if (req.headers["x-openmausbot-companion"] !== "1") return json(res, 403, { error: "Only the phone companion can report an unpaired phone." });
      const device = companionDevice(req);
      if (!device) return json(res, 400, { error: "The unpaired phone was not named." });
      return json(res, 200, { call: deps.calls.deviceRevoked(device) });
    }

    if (method === "PATCH" && path === "/api/live/settings") {
      const parsed = settingsBody.safeParse(await bodyOf(req, readBody));
      if (!parsed.success) {
        return json(res, 400, { error: "Those Live settings are not valid." });
      }
      if (!Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
      return json(res, 200, { live: await deps.saveSettings(parsed.data) });
    }

    return PASS;
  };
}
