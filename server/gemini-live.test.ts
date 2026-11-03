import { describe, expect, it } from "vitest";
import {
  decodeGeminiLiveFrame,
  geminiLiveAudioChunk,
  geminiLiveInstruction,
  geminiLiveSetup,
  geminiLiveText,
  geminiLiveUrl,
  type GeminiLiveSocket,
} from "./gemini-live.ts";

const cfg = { instances: { haramipourhamedgemini: { driver: "openai-compat", environment: { GEMINI_API_KEY: "secret-key" } } } } as never;

describe("Gemini Live protocol", () => {
  it("keeps the key in the URL and out of every message", () => {
    const url = geminiLiveUrl("secret-key");
    expect(url).toContain("key=secret-key");
    for (const message of [geminiLiveSetup("hello"), geminiLiveAudioChunk(new Uint8Array([1, 2])), geminiLiveText("hi")]) {
      expect(message).not.toContain("secret-key");
    }
  });

  it("asks for audio output and both transcriptions", () => {
    const setup = JSON.parse(geminiLiveSetup("be brief"));
    expect(setup.setup.model).toBe("models/gemini-3.8-live");
    expect(setup.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.setup.inputAudioTranscription).toEqual({});
    expect(setup.setup.outputAudioTranscription).toEqual({});
    expect(setup.setup.systemInstruction.parts[0].text).toBe("be brief");
  });

  it("sends 16 kHz PCM as base64", () => {
    const chunk = JSON.parse(geminiLiveAudioChunk(new Uint8Array([1, 2, 3, 4])));
    expect(chunk.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(chunk.realtimeInput.audio.data, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(JSON.parse(geminiLiveText("hi")).realtimeInput.text).toBe("hi");
  });

  it("turns provider frames into browser events and ignores unknown ones", () => {
    expect(decodeGeminiLiveFrame(JSON.stringify({ setupComplete: {} }))).toEqual([{ kind: "ready" }]);
    const audio = decodeGeminiLiveFrame(JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] }, turnComplete: true },
    }));
    expect(audio).toEqual([{ kind: "audio", data: "AAAA", mimeType: "audio/pcm;rate=24000" }, { kind: "turn", complete: true }]);
    expect(decodeGeminiLiveFrame(JSON.stringify({ serverContent: { outputTranscription: { text: "سلام" } } }))).toEqual([{ kind: "caption", text: "سلام", role: "assistant" }]);
    expect(decodeGeminiLiveFrame(JSON.stringify({ serverContent: { inputTranscription: { text: "hi" } } }))).toEqual([{ kind: "caption", text: "hi", role: "user" }]);
    expect(decodeGeminiLiveFrame(JSON.stringify({ serverContent: { interimInputTranscription: { text: "در حال" } } }))).toEqual([{ kind: "caption", text: "در حال", role: "user" }]);
    expect(decodeGeminiLiveFrame(JSON.stringify({ outputTranscription: { text: "سلام" } }))).toEqual([{ kind: "caption", text: "سلام", role: "assistant" }]);
    expect(decodeGeminiLiveFrame("not json")).toEqual([]);
    expect(decodeGeminiLiveFrame(JSON.stringify({ usageMetadata: { totalTokenCount: 3 } }))).toEqual([]);
  });

  it("asks for a spoken answer in the language the person uses", () => {
    const instruction = geminiLiveInstruction("MausBot — weekly report");
    expect(instruction).toContain("MausBot — weekly report");
    expect(instruction.toLowerCase()).toContain("language the person uses");
  });
});

describe("the browser never learns the key", () => {
  it("keeps the credential in the server-side config only", () => {
    expect(JSON.stringify(cfg)).toContain("secret-key");
    const message = geminiLiveSetup("x");
    expect(message).not.toContain("secret-key");
  });
});
