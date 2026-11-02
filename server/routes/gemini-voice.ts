import type { AppConfig } from "../config.ts";
import { AUDIO_TYPES, geminiVoiceKey, MAX_AUDIO_BYTES, transcribeGemini, type VoiceLanguage } from "../gemini-voice.ts";
import { normalizeVoiceRecording } from "../gemini-voice-audio.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createGeminiVoiceRoutes(deps: { config(): AppConfig; transcribe?: typeof transcribeGemini; normalize?: typeof normalizeVoiceRecording; uploadTimeoutMs?: number }): RouteHandler {
  let busy = false;
  return async ({ req, res, url, path, method, json }) => {
    if (!path.startsWith("/api/gemini-voice/")) return PASS;
    const key = geminiVoiceKey(deps.config());
    if (method === "GET" && path === "/api/gemini-voice/status") {
      return json(res, 200, { configured: Boolean(key) });
    }
    if (method !== "POST" || path !== "/api/gemini-voice/transcribe") return PASS;
    if (!key) return json(res, 409, { error: "Configure haramipourhamedgemini before using voice input." });
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(mime)) return json(res, 415, { error: "Unsupported audio type." });
    const language = url.searchParams.get("language") ?? "auto";
    if (!["auto", "fa", "en"].includes(language)) return json(res, 400, { error: "Language must be auto, fa or en." });
    if (Number(req.headers["content-length"] ?? 0) > MAX_AUDIO_BYTES) return json(res, 413, { error: "Audio is limited to 8 MB." });
    if (busy) return json(res, 429, { error: "Another recording is being transcribed. Please try again shortly." });
    busy = true;
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnected);
    const uploadTimer = setTimeout(() => req.destroy(new Error("Audio upload timed out")), deps.uploadTimeoutMs ?? 15_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_AUDIO_BYTES) return json(res, 413, { error: "Audio is limited to 8 MB." });
        chunks.push(bytes);
      }
      clearTimeout(uploadTimer);
      if (!size) return json(res, 400, { error: "Recording is empty." });
      let audio: Uint8Array;
      try {
        audio = await (deps.normalize ?? normalizeVoiceRecording)(Buffer.concat(chunks), controller.signal);
      } catch {
        if (!controller.signal.aborted) return json(res, 400, { error: "Audio is invalid or longer than two minutes." });
        return;
      }
      const text = await (deps.transcribe ?? transcribeGemini)(audio, "audio/wav", language as VoiceLanguage, key, undefined, controller.signal);
      if (!controller.signal.aborted) return json(res, 200, { text });
    } catch {
      if (!controller.signal.aborted && !res.destroyed) return json(res, 502, { error: "Could not transcribe audio with Gemini. Check quota/access or retry." });
    } finally {
      clearTimeout(uploadTimer);
      res.off("close", disconnected);
      busy = false;
    }
  };
}
