import type { LiveEvent } from "../../server/gemini-live.ts";

export const LIVE_IN_RATE = 16000;
export const LIVE_OUT_RATE = 24000;

export interface GeminiLiveClientOptions {
  url: string;
  threadId?: string;
  onEvent(event: LiveEvent): void;
  onStateChange?(state: "connecting" | "live" | "closed" | "error"): void;
  createSocket?(url: string): WebSocket;
  media?: MediaDevices;
  audioContext?: AudioContext;
}

/** The browser sends PCM16 little-endian at 16 kHz; Gemini resamples anything else, but 16 kHz is exact. */
export function downsampleTo16k(channel: Float32Array, rate: number): Int16Array {
  if (rate === LIVE_IN_RATE) return floatToPcm16(channel);
  const ratio = rate / LIVE_IN_RATE;
  const outLength = Math.max(1, Math.floor(channel.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(channel.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += channel[j] ?? 0;
    out[i] = floatToPcm16Value((sum / Math.max(1, end - start)) as number);
  }
  return out;
}

export function floatToPcm16Value(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped * 32767);
}

export function floatToPcm16(channel: Float32Array): Int16Array {
  const out = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i++) out[i] = floatToPcm16Value(channel[i] ?? 0);
  return out;
}

export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

export interface GeminiLiveSession {
  close(): void;
  send(text: string): void;
}

/**
 * A live conversation with Gemini: the microphone is streamed as 16 kHz PCM over one WebSocket,
 * and Gemini's 24 kHz reply is played back as it arrives.
 */
export function openGeminiLiveConversation(options: GeminiLiveClientOptions): GeminiLiveSession {
  const socketFactory = options.createSocket ?? (() => new WebSocket(options.url));
  const url = options.threadId
    ? `${options.url}${options.url.includes("?") ? "&" : "?"}threadId=${encodeURIComponent(options.threadId)}`
    : options.url;
  const socket = socketFactory(url);
  const state = options.onStateChange;
  let context: AudioContext | null = options.audioContext ?? null;
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let closed = false;

  const play = (base64: string, mimeType: string) => {
    const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? LIVE_OUT_RATE);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const samples = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) samples[i] = view[i]! / 32768;
    const ctx = context ?? (context = new AudioContext());
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const sourceNode = ctx.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(ctx.destination);
    void ctx.resume();
    sourceNode.start();
  };

  const stopMicrophone = () => {
    processor?.disconnect();
    processor = null;
    source?.disconnect();
    source = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    stopMicrophone();
    try { socket.close(1000, "client closed"); } catch { /* already closed */ }
    state?.("closed");
  };

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let parsed: LiveEvent;
    try { parsed = JSON.parse(event.data) as LiveEvent; } catch { return; }
    if (parsed.kind === "ready") { state?.("live"); return; }
    if (parsed.kind === "audio") { play(parsed.data, parsed.mimeType); return; }
    if (parsed.kind === "error") { state?.("error"); }
    options.onEvent(parsed);
  });
  socket.addEventListener("error", () => { if (!closed) state?.("error"); });
  socket.addEventListener("close", () => { if (!closed) { closed = true; stopMicrophone(); state?.("closed"); } });

  const startMicrophone = async () => {
    const media = options.media ?? navigator.mediaDevices;
    const mic = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    stream = mic;
    const ctx = context ?? (context = new AudioContext({ sampleRate: LIVE_IN_RATE }));
    source = ctx.createMediaStreamSource(mic);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const samples = downsampleTo16k(event.inputBuffer.getChannelData(0), ctx.sampleRate);
      socket.send(pcm16ToBytes(samples));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
  };

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => { state?.("connecting"); resolve(); }, { once: true });
    socket.addEventListener("error", () => reject(new Error("The live conversation could not start.")), { once: true });
  });
  opened.then(() => startMicrophone()).catch(() => { state?.("error"); close(); });

  return {
    close,
    send(text: string) {
      // Text travels as a JSON envelope; audio travels as binary frames, so the server never guesses.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "text", text }));
    },
  };
}
