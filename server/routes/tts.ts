// The voice routes: whether a voice is ready, the provider's voices (searched, or one pasted by ID or link), adding an
// ElevenLabs Voice Library voice to My Voices, and speaking a line. Scopes are keyed by path in server/request-auth.ts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import { DATA_DIR } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";
import * as tts from "../tts/index.ts";
import { toUtterances, VOICE_FIRST_BLOCK_MAX_CHARS } from "../tts/speech-text.ts";
import { PASS, type RouteHandler } from "./table.ts";

const TTS_CACHE_TTL_MS = 12 * 3600 * 1000; // 12 hours
const MAX_MEM_CACHE_ITEMS = 250;
const memCache = new Map<string, { mime: string; bytes: Uint8Array; ts: number }>();

function ttsCacheDir(): string {
  const dir = join(DATA_DIR, "tts-cache");
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  return dir;
}

function ttsCacheKey(cfg: AppConfig, text: string, voiceId?: string): string {
  const provider = tts.voiceProvider(cfg);
  const voice = voiceId || cfg.tts?.voice || (provider === "gemini" ? "Kore" : "default");
  return createHash("sha256").update(`${provider}:${voice}:${text}`).digest("hex");
}

function readCachedTts(key: string): { mime: string; bytes: Uint8Array } | null {
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem) {
    if (now - mem.ts <= TTS_CACHE_TTL_MS) return { mime: mem.mime, bytes: mem.bytes };
    memCache.delete(key);
  }
  try {
    const dir = ttsCacheDir();
    const metaPath = join(dir, `${key}.json`);
    const binPath = join(dir, `${key}.bin`);
    if (!existsSync(metaPath) || !existsSync(binPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { mime: string; ts: number };
    if (now - meta.ts > TTS_CACHE_TTL_MS) {
      try { unlinkSync(metaPath); unlinkSync(binPath); } catch { /* ignore */ }
      return null;
    }
    const bytes = new Uint8Array(readFileSync(binPath));
    memCache.set(key, { mime: meta.mime, bytes, ts: meta.ts });
    return { mime: meta.mime, bytes };
  } catch {
    return null;
  }
}

function writeCachedTts(key: string, audio: { mime: string; bytes: Uint8Array }): void {
  const now = Date.now();
  if (memCache.size >= MAX_MEM_CACHE_ITEMS) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(key, { mime: audio.mime, bytes: audio.bytes, ts: now });
  try {
    const dir = ttsCacheDir();
    writeFileSync(join(dir, `${key}.bin`), Buffer.from(audio.bytes));
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ mime: audio.mime, ts: now }));
    // Occasional sweep of expired files
    if (Math.random() < 0.05) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        try {
          if (now - statSync(p).mtimeMs > TTS_CACHE_TTL_MS) unlinkSync(p);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

export interface TtsRouteDeps {
  config(): AppConfig;
}

export function createTtsRoutes(deps: TtsRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (!path.startsWith("/api/tts/")) return PASS;
    const cfg = deps.config();
    if (method === "POST" && path === "/api/tts/prepare") {
      const body = await readBody(req);
      // Replies speak while they are still being written, from text no stored message has scrubbed yet: held secrets
      // are known only here, so they are masked here. The first block is short so the first sound comes soon.
      const text = redactSecretsInText(String(body.text ?? ""));
      const provider = tts.voiceProvider(cfg);
      const utterances = provider === "gemini"
        ? toUtterances(text, { minChars: 2400, maxChars: 2800 })
        : toUtterances(text, { firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS });
      return json(res, 200, {
        ready: tts.voiceReady(cfg, typeof body.voiceId === "string" ? body.voiceId : undefined),
        utterances,
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
      const maxChars = tts.voiceProvider(cfg) === "gemini" ? 8000 : 500;
      // A hard ceiling, so an arbitrary local request cannot turn the hosted voice account into an unbounded billable job.
      if (text.length > maxChars) return json(res, 413, { error: `voice utterances are limited to ${maxChars} characters` });
      try {
        const voiceId = typeof body.voiceId === "string" ? body.voiceId : undefined;
        const cacheKey = ttsCacheKey(cfg, text, voiceId);
        let audio = readCachedTts(cacheKey);
        if (!audio) {
          audio = await tts.speak(cfg, text, voiceId);
          writeCachedTts(cacheKey, audio);
        }
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "cache-control": "private, max-age=43200",
        });
        res.end(Buffer.from(audio.bytes));
        return;
      } catch (e) {
        if (e instanceof tts.NoVoiceConfigured) return json(res, 409, { error: e.message });
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return PASS;
  };
}
