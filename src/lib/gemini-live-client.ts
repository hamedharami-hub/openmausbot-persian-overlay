import type { LiveEvent } from "../../server/gemini-live.ts";

export const LIVE_IN_RATE = 16000;
export const LIVE_OUT_RATE = 24000;

export interface GeminiLiveClientOptions {
  url: string;
  threadId?: string;
  voice?: string;
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
  interrupt(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

/**
 * A live conversation with Gemini: the microphone is streamed as 16 kHz PCM over one WebSocket,
 * and Gemini's 24 kHz reply is played back as it arrives.
 */
export function openGeminiLiveConversation(options: GeminiLiveClientOptions): GeminiLiveSession {
  const socketFactory = options.createSocket ?? (() => new WebSocket(options.url));
  const parts: string[] = [];
  if (options.threadId) parts.push(`threadId=${encodeURIComponent(options.threadId)}`);
  if (options.voice) parts.push(`voice=${encodeURIComponent(options.voice)}`);
  const query = parts.join("&");
  const url = query
    ? `${options.url}${options.url.includes("?") ? "&" : "?"}${query}`
    : options.url;
  const socket = socketFactory(url);
  const state = options.onStateChange;
  const ownsContext = !options.audioContext;
  let context: AudioContext | null = options.audioContext ?? (typeof AudioContext === "undefined" ? null : new AudioContext());
  if (context) void context.resume().catch(() => {});
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let closed = false;
  let ready = false;
  let muted = false;
  let nextPlaybackTime = 0;
  const playing = new Set<AudioBufferSourceNode>();

  const stopPlayback = () => {
    for (const node of playing) {
      node.onended = null;
      try { node.stop(); } catch { /* already ended */ }
      node.disconnect();
    }
    playing.clear();
    nextPlaybackTime = 0;
  };

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
    playing.add(sourceNode);
    sourceNode.onended = () => { playing.delete(sourceNode); sourceNode.disconnect(); };
    const start = Math.max(ctx.currentTime + 0.02, nextPlaybackTime);
    nextPlaybackTime = start + buffer.duration;
    void ctx.resume().catch(() => {});
    sourceNode.start(start);
  };

  const stopMicrophone = () => {
    if (processor) processor.onaudioprocess = null;
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
    stopPlayback();
    if (ownsContext && context) void context.close().catch(() => {});
    try { socket.close(1000, "client closed"); } catch { /* already closed */ }
    state?.("closed");
  };

  socket.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") return;
    let parsed: LiveEvent;
    try { parsed = JSON.parse(event.data) as LiveEvent; } catch { return; }
    if (parsed.kind === "ready") { ready = true; state?.("live"); return; }
    if (parsed.kind === "audio") {
      try {
        play(parsed.data, parsed.mimeType);
        options.onEvent(parsed);
      } catch {
        options.onEvent({ kind: "error", message: "Audio playback failed." });
        close();
        state?.("error");
      }
      return;
    }
    if (parsed.kind === "interrupted") stopPlayback();
    if (parsed.kind === "error") { close(); state?.("error"); }
    options.onEvent(parsed);
  });
  socket.addEventListener("error", () => { if (!closed) { close(); state?.("error"); } });
  socket.addEventListener("close", close);

  const startMicrophone = async () => {
    const media = options.media ?? navigator.mediaDevices;
    const mic = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (closed) { mic.getTracks().forEach((track) => track.stop()); return; }
    stream = mic;
    const ctx = context ?? (context = new AudioContext());
    await ctx.resume();
    if (closed) return;
    source = ctx.createMediaStreamSource(mic);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (closed || !ready || muted || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 128 * 1024) return;
      // Echo & self-interruption guard: While Gemini audio is actively queued or playing,
      // do not stream microphone input to Gemini. This prevents speaker audio from being picked up
      // by the microphone and triggering Gemini's Voice Activity Detection to cut off the answer.
      const isSpeaking = playing.size > 0 || (nextPlaybackTime > 0 && ctx.currentTime < nextPlaybackTime + 0.15);
      if (isSpeaking) return;
      const samples = downsampleTo16k(event.inputBuffer.getChannelData(0), ctx.sampleRate);
      socket.send(pcm16ToBytes(samples));
    };
    source.connect(processor);
    // Connect processor through a zero-gain node so onaudioprocess fires reliably across all browsers,
    // while completely preventing the raw microphone stream from being piped into the speakers.
    const silentGain = typeof ctx.createGain === "function" ? ctx.createGain() : null;
    if (silentGain) {
      silentGain.gain.value = 0;
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
    } else {
      processor.connect(ctx.destination);
    }
  };

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => { state?.("connecting"); resolve(); }, { once: true });
    socket.addEventListener("error", () => reject(new Error("The live conversation could not start.")), { once: true });
  });
  opened.then(() => { if (!closed) return startMicrophone(); }).catch(() => { if (!closed) { close(); state?.("error"); } });

  return {
    close,
    send(text: string) {
      // Text travels as a JSON envelope; audio travels as binary frames, so the server never guesses.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "text", text }));
    },
    interrupt() {
      stopPlayback();
    },
    setMuted(next: boolean) {
      muted = Boolean(next);
    },
    isMuted() {
      return muted;
    },
  };
}
