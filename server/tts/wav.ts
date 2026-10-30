import type { Audio } from "./elevenlabs.ts";

type WavParts = { pcm: Uint8Array; channels: number; sampleRate: number; bitsPerSample: number; format: number };

function parseWav(bytes: Uint8Array): WavParts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Gemini returned an invalid WAV file.");
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let pcm: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error("Gemini returned a truncated WAV file.");
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bitsPerSample = view.getUint16(start + 14, true);
    } else if (id === "data") {
      pcm = bytes.slice(start, start + size);
    }
    offset = start + size + (size & 1);
  }
  if (format !== 1 || channels < 1 || channels > 2 || bitsPerSample !== 16 || !sampleRate || !pcm || pcm.length % (channels * 2)) {
    throw new Error("Gemini returned an unsupported WAV encoding; download is unavailable for this clip.");
  }
  return { pcm, channels, sampleRate, bitsPerSample, format };
}

export function combinePcmWav(clips: Audio[]): Audio {
  if (!clips.length || clips.some((clip) => clip.mime !== "audio/wav")) throw new Error("Only Gemini WAV clips can be joined for download.");
  const parsed = clips.map((clip) => parseWav(clip.bytes));
  const first = parsed[0]!;
  if (parsed.some((part) => part.channels !== first.channels || part.sampleRate !== first.sampleRate || part.bitsPerSample !== first.bitsPerSample)) {
    throw new Error("Gemini returned audio clips with incompatible WAV formats.");
  }
  const dataSize = parsed.reduce((sum, part) => sum + part.pcm.length, 0);
  if (dataSize > 0xffff_ffff - 36) throw new Error("The generated audio is too large to download as one WAV file.");
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, first.format, true);
  view.setUint16(22, first.channels, true); view.setUint32(24, first.sampleRate, true);
  const blockAlign = first.channels * first.bitsPerSample / 8;
  view.setUint32(28, first.sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, first.bitsPerSample, true);
  writeAscii(bytes, 36, "data"); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const part of parsed) { bytes.set(part.pcm, offset); offset += part.pcm.length; }
  return { bytes, mime: "audio/wav" };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function writeAscii(bytes: Uint8Array, offset: number, text: string): void { for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i); }
