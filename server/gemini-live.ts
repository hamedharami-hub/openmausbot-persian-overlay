import type { AppConfig } from "./config.ts";

export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const LIVE_AUDIO_IN_RATE = 16000;
export const LIVE_AUDIO_OUT_RATE = 24000;
export const MAX_LIVE_CHUNK_BYTES = 64 * 1024;

export type LiveEvent =
  | { kind: "ready" }
  | { kind: "caption"; text: string; role: "user" | "assistant" }
  | { kind: "audio"; data: string; mimeType: string }
  | { kind: "turn"; complete: boolean }
  | { kind: "closed"; reason: string }
  | { kind: "error"; message: string };

export interface GeminiLiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export function geminiLiveKey(cfg: AppConfig): string | undefined {
  return cfg.instances?.haramipourhamedgemini?.environment?.GEMINI_API_KEY?.trim() || undefined;
}

/** The key travels in the URL query, never in a message, so a transcript can never carry it. */
export function geminiLiveUrl(key: string): string {
  return `${GEMINI_LIVE_URL}?key=${encodeURIComponent(key)}`;
}

export function geminiLiveSetup(instruction: string): string {
  return JSON.stringify({
    setup: {
      model: `models/${GEMINI_LIVE_MODEL}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: instruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
}

export function geminiLiveAudioChunk(pcm: Uint8Array): string {
  return JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm).toString("base64"), mimeType: `audio/pcm;rate=${LIVE_AUDIO_IN_RATE}` } } });
}

export function geminiLiveText(text: string): string {
  return JSON.stringify({ realtimeInput: { text } });
}

/** Turns one server frame into the events the browser needs. Unknown frames are ignored, never guessed at. */
export function decodeGeminiLiveFrame(raw: string): LiveEvent[] {
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw) as Record<string, unknown>; }
  catch { return []; }
  const events: LiveEvent[] = [];
  if (data.setupComplete) events.push({ kind: "ready" });
  const serverContent = data.serverContent as { modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> }; turnComplete?: boolean } | undefined;
  for (const part of serverContent?.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) events.push({ kind: "audio", data: part.inlineData.data, mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000" });
  }
  if (serverContent?.turnComplete) events.push({ kind: "turn", complete: true });
  const output = data.outputTranscription as { text?: string } | undefined;
  if (output?.text) events.push({ kind: "caption", text: output.text, role: "assistant" });
  const input = data.inputTranscription as { text?: string } | undefined;
  if (input?.text) events.push({ kind: "caption", text: input.text, role: "user" });
  return events;
}

/** The Live API speaks Persian and English; the instruction keeps both in their own language. */
export function geminiLiveInstruction(subject: string): string {
  return [
    "You are a live voice assistant speaking with a person in Persian or English.",
    "Reply in the language the person uses. Never translate unless asked.",
    `You are talking about: ${subject}.`,
    "Keep spoken answers short and natural, without markdown or lists.",
  ].join(" ");
}
