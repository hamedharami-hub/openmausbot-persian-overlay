import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import type { AppConfig } from "../config.ts";
import { createGeminiLiveRoutes } from "./gemini-live.ts";
import { createUpgrades } from "./upgrades.ts";

class FakeUpstream {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

async function fixture(configured = true) {
  const upstream = new FakeUpstream();
  const upgrades = createUpgrades();
  const cfg = configured
    ? { instances: { haramipourhamedgemini: { driver: "openai-compat", environment: { GEMINI_API_KEY: "secret-key" } } } } as AppConfig
    : {} as AppConfig;
  const route = createGeminiLiveRoutes({
    config: () => cfg,
    upgrades,
    subject: (threadId) => `subject:${threadId ?? "none"}`,
    openSocket: () => upstream as never,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const out = await route({
      req, res, path: url.pathname, url, method: req.method!, auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((response, code, data) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(data)); }) as never,
      readBody: vi.fn() as never,
    });
    if (out !== undefined) { res.writeHead(404); res.end(); }
  });
  upgrades.attach(server, async (req, res) => {
    const pending = upgrades.pending(req);
    if (!pending) { res.writeHead(400).end(); return; }
    const out = await route({
      req, res, path: new URL(req.url ?? "/", "http://localhost").pathname, url: new URL(req.url ?? "/", "http://localhost"),
      method: req.method!, auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((response, code, data) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(data)); }) as never,
      readBody: vi.fn() as never,
    });
    if (out !== undefined) { res.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, upstream, port, url: `ws://127.0.0.1:${port}/api/gemini-live/conversation` };
}

describe("Gemini Live conversation route", () => {
  it("answers a plain request with the upgrade requirement and never a key", async () => {
    const { server } = await fixture();
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/gemini-live/conversation`);
    expect(response.status).toBe(426);
    expect(await response.text()).not.toContain("secret-key");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("relays setup, audio and captions between the browser and Gemini", async () => {
    const { server, upstream, url } = await fixture();
    const client = new WebSocket(url);
    const events: unknown[] = [];
    client.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => client.on("open", () => resolve()));
    upstream.open();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(JSON.parse(upstream.sent[0]!).setup.model).toBe("models/gemini-3.8-live");
    expect(JSON.parse(upstream.sent[0]!).setup.systemInstruction.parts[0].text).toContain("subject:none");

    upstream.emit({ setupComplete: {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.send(Buffer.from([1, 2, 3, 4]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const forwarded = JSON.parse(upstream.sent.at(-1)!);
    expect(forwarded.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");

    upstream.emit({ outputTranscription: { text: "سلام" } });
    upstream.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] } } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual(expect.arrayContaining([{ kind: "ready" }, { kind: "caption", text: "سلام", role: "assistant" }, { kind: "audio", data: "AAAA", mimeType: "audio/pcm;rate=24000" }]));
    expect(JSON.stringify(events)).not.toContain("secret-key");
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses without the server-side credential", async () => {
    const { server } = await fixture(false);
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/gemini-live/conversation`);
    expect(response.status).toBe(409);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
