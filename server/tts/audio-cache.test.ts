import { describe, expect, it } from "vitest";
import { geminiAudioCacheKey, MemoryAudioCache } from "./audio-cache.ts";

describe("temporary speech cache", () => {
  it("deduplicates concurrent renders and returns copy-on-read data", async () => {
    const cache = new MemoryAudioCache();
    let renders = 0;
    let release!: (value: { bytes: Uint8Array; mime: string }) => void;
    const render = () => { renders += 1; return new Promise<{ bytes: Uint8Array; mime: string }>((resolve) => { release = resolve; }); };
    const first = cache.getOrCreate("same", render);
    const second = cache.getOrCreate("same", render);
    release({ bytes: new Uint8Array([1, 2]), mime: "audio/wav" });
    const a = await first;
    const b = await second;
    expect(renders).toBe(1);
    a.bytes[0] = 9;
    expect(b.bytes[0]).toBe(1);
    expect((await cache.getOrCreate("same", render)).bytes[0]).toBe(1);
  });

  it("expires entries and bounds memory by bytes", async () => {
    let now = 100;
    const cache = new MemoryAudioCache(10, 2, 2, () => now);
    let renders = 0;
    const render = async () => ({ bytes: new Uint8Array([++renders]), mime: "audio/wav" });
    await cache.getOrCreate("a", render);
    now = 111;
    await cache.getOrCreate("a", render);
    expect(renders).toBe(2);
    await cache.getOrCreate("b", async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/wav" }));
    await cache.getOrCreate("b", render);
    expect(renders).toBe(3);
  });

  it("does not expose API keys in cache keys", () => {
    const key = geminiAudioCacheKey({ apiKey: "secret-key", model: "lite", voice: "Kore", text: "hi" });
    expect(key).not.toContain("secret-key");
    expect(key).toHaveLength(64);
    expect(key).not.toBe(geminiAudioCacheKey({ apiKey: "other-key", model: "lite", voice: "Kore", text: "hi" }));
  });
});
