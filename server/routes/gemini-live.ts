// A Gemini Live conversation: the browser speaks to this server over a WebSocket, and the server speaks to
// Gemini Live. The key never leaves the server, and the browser never learns it.
import { WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "../config.ts";
import { isSameOrigin } from "../request-auth.ts";
import type { Upgrades } from "./upgrades.ts";
import {
  decodeGeminiLiveFrame,
  geminiLiveAudioChunk,
  geminiLiveInstruction,
  geminiLiveKey,
  geminiLiveSetup,
  geminiLiveText,
  geminiLiveUrl,
  MAX_LIVE_CHUNK_BYTES,
  type GeminiLiveSocket,
  type LiveEvent,
} from "../gemini-live.ts";
import { PASS, type RouteHandler } from "./table.ts";

const PATH = /^\/api\/gemini-live\/conversation$/;
const SETUP_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** A WebSocket frame arrives as text, a Buffer, an ArrayBuffer or a Blob, depending on the client. */
async function frameText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
  if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function") {
    return Buffer.from(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()).toString();
  }
  return null;
}

export interface GeminiLiveRouteDeps {
  config(): AppConfig;
  upgrades: Upgrades;
  /** The subject the conversation is about; empty text means the general assistant. */
  subject(threadId: string | undefined): string;
  openSocket(url: string): GeminiLiveSocket;
}

interface Conversation {
  socket: GeminiLiveSocket;
  setupDone: boolean;
  lastActivity: number;
}

export function createGeminiLiveRoutes(deps: GeminiLiveRouteDeps): RouteHandler {
  deps.upgrades.route((path) => PATH.test(path));
  const conversations = new Map<string, Conversation>();

  return async ({ req, res, path, method, auth, json }) => {
    if (!PATH.test(path)) return PASS;
    const key = geminiLiveKey(deps.config());
    if (!key) return json(res, 409, { error: "Configure haramipourhamedgemini before starting a live conversation." });
    const pending = deps.upgrades.pending(req);
    if (method !== "GET" || !pending) return json(res, 426, { error: "WebSocket upgrade required" });
    if (!isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
    if (!auth.scopes.includes("client") && !auth.scopes.includes("admin")) return json(res, 403, { error: "forbidden" });

    const threadId = new URL(req.url ?? "", "http://localhost").searchParams.get("threadId") ?? undefined;
    const instruction = geminiLiveInstruction(deps.subject(threadId));
    const upstream = deps.openSocket(geminiLiveUrl(key));

    pending.release();
    const browser = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
    browser.handleUpgrade(req, pending.socket, pending.head, (client: WebSocket) => {
      const send = (event: LiveEvent) => {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
      };
      const conversation: Conversation = { socket: upstream, setupDone: false, lastActivity: Date.now() };
      conversations.set(String(client), conversation);

      const finish = (reason: string) => {
        conversations.delete(String(client));
        send({ kind: "closed", reason });
        try { upstream.close(1000, reason); } catch { /* already gone */ }
        try { client.close(1000, reason); } catch { /* already gone */ }
      };

      const setupTimer = setTimeout(() => {
        if (conversation.setupDone) return;
        send({ kind: "error", message: "Gemini Live did not answer in time." });
        finish("setup timeout");
      }, SETUP_TIMEOUT_MS);
      setupTimer.unref();

      upstream.onopen = () => {
        try { upstream.send(geminiLiveSetup(instruction)); }
        catch { send({ kind: "error", message: "Could not start the Gemini Live session." }); finish("setup failed"); }
      };
      upstream.onmessage = (event) => {
        void (async () => {
          const raw = await frameText(event.data);
          if (raw === null) return;
          for (const live of decodeGeminiLiveFrame(raw)) {
            if (live.kind === "ready") { conversation.setupDone = true; clearTimeout(setupTimer); }
            conversation.lastActivity = Date.now();
            send(live);
          }
        })().catch(() => send({ kind: "error", message: "Could not read the Gemini Live frame." }));
      };
      upstream.onerror = () => {
        send({ kind: "error", message: "The Gemini Live connection failed." });
        finish("upstream error");
      };
      upstream.onclose = (event) => {
        if (conversation.setupDone) finish(`upstream closed (${event.code})`);
        else { clearTimeout(setupTimer); send({ kind: "error", message: "Gemini Live closed the session." }); finish("upstream closed"); }
      };

      client.on("message", (data: Buffer, isBinary: boolean) => {
        conversation.lastActivity = Date.now();
        if (!conversation.setupDone) return;
        try {
          if (isBinary) {
            // Binary frames are PCM16 microphone audio.
            upstream.send(geminiLiveAudioChunk(data));
            return;
          }
          // Text frames are JSON envelopes, so audio can never be mistaken for words.
          const envelope = JSON.parse(data.toString()) as { type?: string; text?: string };
          if (envelope.type === "text" && typeof envelope.text === "string") upstream.send(geminiLiveText(envelope.text));
        } catch {
          send({ kind: "error", message: "Could not forward the message." });
        }
      });
      client.on("close", () => finish("browser closed"));
      client.on("error", () => finish("browser error"));
    });
    res.detachSocket(pending.socket);

    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, conversation] of conversations) {
        if (now - conversation.lastActivity > IDLE_TIMEOUT_MS) {
          conversations.delete(id);
          try { conversation.socket.close(1000, "idle"); } catch { /* already gone */ }
        }
      }
    }, 60_000);
    sweep.unref();
    return;
  };
}

export function geminiLiveMaxChunk(): number {
  return MAX_LIVE_CHUNK_BYTES;
}
