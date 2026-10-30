import { describe, expect, it, vi } from "vitest";

import { buildGeminiLiveSetup, createGeminiLiveToken, GEMINI_LIVE_MODEL } from "./gemini-live.ts";

const bot = { name: "Nora", title: "Assistant", description: "Helpful" };

describe("Gemini Live setup and ephemeral credentials", () => {
  it("sets up audio, Persian-capable voice selection, history-only context, and a narrow agent handoff", () => {
    const setup = buildGeminiLiveSetup({ bot, history: [{ role: "user", text: "سلام" }, { role: "assistant", text: "سلام، چطور کمک کنم؟" }], voice: "Aoede", cloudHome: false });
    expect(setup.model).toBe(GEMINI_LIVE_MODEL);
    expect(setup.generationConfig).toMatchObject({ responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } });
    expect(setup.historyConfig).toEqual({ initialHistoryInClientContent: true });
    expect(setup.initialTurns.map((turn) => turn.role)).toEqual(["user", "model"]);
    expect(setup.tools[0]?.functionDeclarations.map((tool) => tool.name)).toEqual(["delegate_to_openmausbot"]);
    expect(JSON.stringify(setup)).not.toContain("API key");
  });

  it("creates one-use, short-lived tokens and keeps the API key in the server request header", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ name: "ephemeral-token" }), { status: 200 }));
    const session = await createGeminiLiveToken({ apiKey: "server-only-google-key", bot, history: [], voice: "Kore", cloudHome: false, now: 0, fetchImpl });
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(new Headers(request?.headers).get("x-goog-api-key")).toBe("server-only-google-key");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      uses: 1,
      expireTime: "1970-01-01T00:30:00.000Z",
      newSessionExpireTime: "1970-01-01T00:01:00.000Z",
      liveConnectConstraints: { model: GEMINI_LIVE_MODEL, config: { sessionResumption: {}, responseModalities: ["AUDIO"] } },
    });
    expect(session.token).toBe("ephemeral-token");
    expect(JSON.stringify(session)).not.toContain("server-only-google-key");
  });

  it("returns safe errors for missing, rejected, and rate-limited credentials", async () => {
    await expect(createGeminiLiveToken({ apiKey: " ", bot, history: [], voice: "Kore", cloudHome: false })).rejects.toThrow(/Add a Gemini API key/);
    const rejected = vi.fn(async () => new Response("secret error body", { status: 401 }));
    await expect(createGeminiLiveToken({ apiKey: "secret", bot, history: [], voice: "Kore", cloudHome: false, fetchImpl: rejected })).rejects.toThrow(/Google rejected/);
    const limited = vi.fn(async () => new Response("secret error body", { status: 429 }));
    await expect(createGeminiLiveToken({ apiKey: "secret", bot, history: [], voice: "Kore", cloudHome: false, fetchImpl: limited })).rejects.toThrow(/usage limit/);
  });
});
