import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MODEL, MODELS, synthesize } from "./gemini.ts";

describe("Gemini TTS", () => {
  it("uses the free-tier Flash-Lite default and decodes audio from the Interactions response", async () => {
    const wav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.from(wav).toString("base64") }] }],
    }), { status: 200 }));
    const audio = await synthesize("سلام دنیا", "Kore", "google-test-key", DEFAULT_MODEL, fetchImpl);
    expect(audio).toEqual({ bytes: wav, mime: "audio/wav" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(new Headers(request?.headers).get("x-goog-api-key")).toBe("google-test-key");
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: "gemini-3.8-flash-lite-tts",
      input: [{ content: [{ text: "سلام دنیا" }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
    expect(MODELS).toContain(DEFAULT_MODEL);
  });

  it("rejects missing keys, unsupported models, and free-tier quota errors without exposing the key", async () => {
    await expect(synthesize("Hi", "Kore", " ")).rejects.toThrow(/Add a Gemini API key/);
    await expect(synthesize("Hi", "Kore", "secret", "not-a-model")).rejects.toThrow(/supported Gemini/);
    const fetchImpl = vi.fn(async () => new Response("private provider detail", { status: 429 }));
    let message = "";
    try { await synthesize("Hi", "Kore", "secret-key", DEFAULT_MODEL, fetchImpl); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toMatch(/free-tier limit/);
    expect(message).not.toContain("secret-key");
  });
});
