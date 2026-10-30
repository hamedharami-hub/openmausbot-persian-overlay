import { createHash } from "node:crypto";
import type { Audio } from "./elevenlabs.ts";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 64;

type Entry = { audio: Audio; expiresAt: number; touchedAt: number };

/** Bounded process-memory cache only; generated speech is never written to disk. */
export class MemoryAudioCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Audio>>();
  private bytes = 0;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    ttlMs = DEFAULT_TTL_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = () => Date.now(),
  ) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async getOrCreate(key: string, render: () => Promise<Audio>): Promise<Audio> {
    this.expire();
    const found = this.entries.get(key);
    if (found) {
      found.touchedAt = this.now();
      return copy(found.audio);
    }
    const existing = this.pending.get(key);
    if (existing) return copy(await existing);
    const request = render();
    this.pending.set(key, request);
    try {
      const audio = await request;
      if (audio.bytes.byteLength <= this.maxBytes) {
        const stored = copy(audio);
        this.entries.set(key, { audio: stored, expiresAt: this.now() + this.ttlMs, touchedAt: this.now() });
        this.bytes += stored.bytes.byteLength;
        this.evict();
      }
      return copy(audio);
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key, entry);
    }
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = [...this.entries].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
  }

  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.bytes -= entry.audio.bytes.byteLength;
  }
}

/** Digest includes the credential without retaining it, so replacing a key never reuses its old cache namespace. */
export function geminiAudioCacheKey(input: { apiKey: string; model: string; voice: string; text: string }): string {
  return createHash("sha256")
    .update(input.apiKey).update("\0").update(input.model).update("\0").update(input.voice).update("\0").update(input.text)
    .digest("hex");
}

function copy(audio: Audio): Audio {
  return { mime: audio.mime, bytes: new Uint8Array(audio.bytes) };
}
