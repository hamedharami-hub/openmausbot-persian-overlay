import { expect, it } from "vitest";
import { normalizeVoiceRecording } from "./gemini-voice-audio.ts";
import { pcmToWav } from "./gemini-voice.ts";

it("decodes short audio to 16 kHz mono WAV without contacting Google", async () => {
  const wav = pcmToWav(new Uint8Array(24000 * 2), 24000);
  const normalized = Buffer.from(await normalizeVoiceRecording(wav));
  expect(normalized.readUInt32LE(24)).toBe(16000);
  expect(normalized.length).toBe(32044);
});

it("rejects invalid audio and recordings exceeding the server duration cap", async () => {
  await expect(normalizeVoiceRecording(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  const tooLong = pcmToWav(new Uint8Array(126 * 16000 * 2), 16000);
  await expect(normalizeVoiceRecording(tooLong)).rejects.toThrow();
});
