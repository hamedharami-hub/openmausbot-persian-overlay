import { spawn } from "node:child_process";
import { pcmToWav } from "./gemini-voice.ts";

// Five seconds of tolerance covers MediaRecorder's delayed final chunk.
const MAX_PCM_BYTES = 125 * 16000 * 2;

export function normalizeVoiceRecording(input: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "pipe",
      "-i", "pipe:0", "-t", "126", "-vn", "-sn", "-dn", "-threads", "1",
      "-filter_threads", "1", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ], { stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Invalid audio, recording too long, or audio decoder unavailable."));
    };
    const timeout = setTimeout(fail, 15_000);
    signal?.addEventListener("abort", fail, { once: true });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (bytes: Buffer) => {
      if (settled) return;
      total += bytes.length;
      if (total > MAX_PCM_BYTES) { fail(); return; }
      chunks.push(bytes);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", fail);
      if (settled) return;
      settled = true;
      if (code !== 0 || !total) { reject(new Error("Invalid audio recording.")); return; }
      resolve(pcmToWav(Buffer.concat(chunks), 16000));
    });
    if (signal?.aborted) fail();
    else child.stdin.end(input);
  });
}
