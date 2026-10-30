import { describe, expect, it } from "vitest";
import { combinePcmWav } from "./wav.ts";

function wav(values: number[]): Uint8Array {
  const bytes = new Uint8Array(44 + values.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + values.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, values.length * 2, true);
  values.forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return bytes;
}

describe("Gemini WAV downloads", () => {
  it("joins PCM samples and writes a valid WAV header", () => {
    const combined = combinePcmWav([{ bytes: wav([1, 2]), mime: "audio/wav" }, { bytes: wav([3]), mime: "audio/wav" }]);
    expect(new DataView(combined.bytes.buffer).getUint32(4, true)).toBe(combined.bytes.length - 8);
    expect(new DataView(combined.bytes.buffer).getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((index) => new DataView(combined.bytes.buffer).getInt16(44 + index * 2, true))).toEqual([1, 2, 3]);
  });

  it("rejects malformed or incompatible audio", () => {
    expect(() => combinePcmWav([{ bytes: new Uint8Array(2), mime: "audio/wav" }])).toThrow(/invalid WAV/);
    expect(() => combinePcmWav([{ bytes: wav([1]), mime: "audio/mpeg" }])).toThrow(/Only Gemini/);
  });
});
