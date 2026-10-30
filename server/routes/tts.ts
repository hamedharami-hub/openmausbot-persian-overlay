// The voice routes: whether a voice is ready, the provider's voices (searched, or one pasted by ID or link), adding an
// ElevenLabs Voice Library voice to My Voices, and speaking a line. Scopes are keyed by path in server/request-auth.ts.
import type { AppConfig } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";
import * as tts from "../tts/index.ts";
import { toUtterances, VOICE_FIRST_BLOCK_MAX_CHARS } from "../tts/speech-text.ts";
import { geminiAudioCacheKey, MemoryAudioCache } from "../tts/audio-cache.ts";
import { combinePcmWav } from "../tts/wav.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TtsRouteDeps {
  config(): AppConfig;
}

export function createTtsRoutes(deps: TtsRouteDeps): RouteHandler {
  const ttsAudioCache = new MemoryAudioCache();
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (!path.startsWith("/api/tts/")) return PASS;
    const cfg = deps.config();
    if (method === "POST" && path === "/api/tts/prepare") {
      const body = await readBody(req);
      // Replies speak while they are still being written, from text no stored message has scrubbed yet: held secrets
      // are known only here, so they are masked here. The first block is short so the first sound comes soon.
      const text = redactSecretsInText(String(body.text ?? ""));
      return json(res, 200, {
        ready: tts.voiceReady(cfg, typeof body.voiceId === "string" ? body.voiceId : undefined),
        utterances: toUtterances(text, { firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS }),
        cacheNamespace: JSON.stringify([tts.describeVoice(cfg), typeof body.voiceId === "string" ? body.voiceId : ""]),
      });
    }
    if (method === "GET" && path === "/api/tts/voices") {
      try {
        const search = {
          query: url.searchParams.get("q")?.slice(0, 200),
          current: url.searchParams.get("current") ?? undefined,
        };
        return json(res, 200, { voices: await tts.listVoices(cfg, undefined, search) });
      } catch (e) {
        return json(res, 200, { voices: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/voices/add") {
      const body = await readBody(req);
      const id = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value) ? value : "");
      const publicOwnerId = id(body.publicOwnerId);
      const voiceId = id(body.voiceId);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      if (!publicOwnerId || !voiceId || !name) return json(res, 400, { error: "publicOwnerId, voiceId and name required" });
      try {
        return json(res, 200, { voiceId: await tts.addSharedVoice(cfg, publicOwnerId, voiceId, name) });
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/speak") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // A hard ceiling, so an arbitrary local request cannot turn the hosted voice account into an unbounded billable job.
      if (text.length > 500) return json(res, 413, { error: "voice utterances are limited to 500 characters" });
      try {
        const voiceId = typeof body.voiceId === "string" ? body.voiceId : undefined;
        const audio = tts.voiceProvider(cfg) === "gemini" && cfg.gemini?.apiKey
          ? await ttsAudioCache.getOrCreate(geminiAudioCacheKey({ apiKey: cfg.gemini.apiKey, model: cfg.tts?.geminiModel ?? "gemini-3.8-flash-lite-tts", voice: voiceId ?? cfg.tts?.voice ?? "Kore", text }), () => tts.speak(cfg, text, voiceId))
          : await tts.speak(cfg, text, voiceId);
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "cache-control": "no-store",
        });
        res.end(Buffer.from(audio.bytes));
        return;
      } catch (e) {
        if (e instanceof tts.NoVoiceConfigured) return json(res, 409, { error: e.message });
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/download") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      if (text.length > 12_000) return json(res, 413, { error: "speech downloads are limited to 12,000 characters" });
      if (tts.voiceProvider(cfg) !== "gemini") return json(res, 409, { error: "Full-message download is currently available for Gemini speech only." });
      const voiceId = typeof body.voiceId === "string" ? body.voiceId : undefined;
      const utterances = toUtterances(text, { maxChars: 500 });
      if (!utterances.length) return json(res, 400, { error: "no speakable text" });
      try {
        const apiKey = cfg.gemini?.apiKey ?? "";
        const model = cfg.tts?.geminiModel ?? "gemini-3.8-flash-lite-tts";
        const voice = voiceId ?? cfg.tts?.voice ?? "Kore";
        const clips = [];
        for (const utterance of utterances) {
          clips.push(await ttsAudioCache.getOrCreate(
            geminiAudioCacheKey({ apiKey, model, voice, text: utterance }),
            () => tts.speak(cfg, utterance, voiceId),
          ));
        }
        const audio = combinePcmWav(clips);
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "content-disposition": 'attachment; filename="openmausbot-speech.wav"',
          "cache-control": "private, no-store",
        });
        res.end(Buffer.from(audio.bytes));
        return;
      } catch (e) {
        if (e instanceof tts.NoVoiceConfigured) return json(res, 409, { error: e.message });
        return json(res, 502, { error: e instanceof Error ? e.message : "Speech download failed." });
      }
    }

    return PASS;
  };
}
