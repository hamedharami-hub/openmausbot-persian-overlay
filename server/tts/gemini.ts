import { z } from "zod";
import type { Audio, Voice } from "./elevenlabs.ts";

export const DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
export const MODELS = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"] as const;
const API = "https://generativelanguage.googleapis.com/v1beta/interactions";
const responseSchema = z.object({
  output_audio: z.object({ data: z.string().min(1) }).optional(),
  steps: z.array(z.object({
    type: z.string().optional(),
    content: z.array(z.object({ type: z.string().optional(), data: z.string().optional() })).optional(),
  })).optional(),
});

export const VOICES: Voice[] = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"],
  ["Fenrir", "Excitable"], ["Leda", "Youthful"], ["Orus", "Firm"], ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"], ["Enceladus", "Breathy"], ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"], ["Erinome", "Clear"],
  ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"], ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
].map(([id, description]) => ({ id, label: id, description }));

function serviceError(status: number): string {
  if (status === 401 || status === 403) return "Google rejected the Gemini API key. Check it in Settings.";
  if (status === 429) return "Gemini's free-tier limit has been reached. Wait and try again, or check Google AI Studio quotas.";
  if (status === 404) return "Google could not find this Gemini TTS model. Refresh the app or choose another model.";
  return `Gemini speech generation failed (HTTP ${status}). Try again later.`;
}

export async function synthesize(
  text: string,
  voice: string,
  key: string,
  model = DEFAULT_MODEL,
  fetchImpl: typeof fetch = fetch,
): Promise<Audio> {
  if (!key.trim()) throw new Error("Add a Gemini API key in Settings to use Gemini speech.");
  if (!(MODELS as readonly string[]).includes(model)) throw new Error("Choose a supported Gemini speech model.");
  const response = await fetchImpl(API, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ type: "user_input", content: [{ type: "text", text }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: voice || "Kore" }] },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(serviceError(response.status));
  }
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  const data = parsed.success
    ? parsed.data.output_audio?.data ?? parsed.data.steps?.flatMap((step) => step.type === "model_output" ? step.content ?? [] : []).findLast((part) => part.type === "audio")?.data
    : undefined;
  if (!data) throw new Error("Gemini returned no audio. Try again.");
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (!bytes.byteLength || bytes.byteLength > 12_000_000) throw new Error("Gemini returned audio outside the supported size limit.");
  return { bytes, mime: "audio/wav" };
}
