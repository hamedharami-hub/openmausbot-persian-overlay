import { createServer, request, type Server, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { createGeminiVoiceRoutes } from "./gemini-voice.ts";
import { PASS } from "./table.ts";

let server: Server;
afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });
async function fixture(configured = true, uploadTimeoutMs = 15_000) {
  const transcribe = vi.fn().mockResolvedValue("سلام hello");
  const cfg = configured ? { instances: { haramipourhamedgemini: { driver: "openai-compat", environment: { GEMINI_API_KEY: "test-secret" } } } } as AppConfig : {} as AppConfig;
  const route = createGeminiVoiceRoutes({ config: () => cfg, transcribe, normalize: async (audio) => audio, uploadTimeoutMs });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const out = await route({ req, res, path: url.pathname, url, method: req.method!, auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: vi.fn() as never,
      json: ((response: ServerResponse, code: number, data: unknown) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(data)); }) as never,
    });
    if (out === PASS) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, transcribe };
}

it("reports status without credentials", async () => {
  const { base } = await fixture();
  const response = await fetch(`${base}/api/gemini-voice/status`);
  expect(await response.json()).toEqual({ configured: true });
});

it("accepts recorded audio and returns editable text without sending a bot message", async () => {
  const { base, transcribe } = await fixture();
  const response = await fetch(`${base}/api/gemini-voice/transcribe?language=fa`, { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: new Uint8Array([1, 2, 3]) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "سلام hello" });
  expect(transcribe.mock.calls[0][1]).toBe("audio/wav");
  expect(transcribe.mock.calls[0][2]).toBe("fa");
});

it("rejects missing configuration, empty audio, invalid MIME and language before spending quota", async () => {
  const { base, transcribe } = await fixture();
  for (const [path, mime, body, status] of [
    ["?language=de", "audio/webm", "abc", 400], ["", "text/plain", "abc", 415], ["", "audio/wav", "", 400],
  ] as const) {
    const response = await fetch(`${base}/api/gemini-voice/transcribe${path}`, { method: "POST", headers: { "content-type": mime }, body });
    expect(response.status).toBe(status);
  }
  expect(transcribe).not.toHaveBeenCalled();
});

it("releases the workspace lock after an upload stalls", async () => {
  const { base, transcribe } = await fixture(true, 100);
  await new Promise<void>((resolve) => {
    const slow = request(`${base}/api/gemini-voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" } });
    slow.on("error", () => resolve());
    slow.write("incomplete recording");
  });
  const response = await fetch(`${base}/api/gemini-voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: "valid fixture" });
  expect(response.status).toBe(200);
  expect(transcribe).toHaveBeenCalledTimes(1);
});

it("requires the configured server-side Gemini credential", async () => {
  const { base, transcribe } = await fixture(false);
  const response = await fetch(`${base}/api/gemini-voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: "abc" });
  expect(response.status).toBe(409);
  expect(transcribe).not.toHaveBeenCalled();
});
