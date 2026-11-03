// Audio comes from the harness, which holds the voice keys: the renderer never sees them or calls a voice provider.

import { localSystemVoiceActive, remoteSystemVoice, resolveLocalSystemVoice } from "@/lib/local-voice";
import { recordBlockTiming, recordPrepared, recordSpeakEnter } from "../voice-latency-probe";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

export interface PlaybackDetails {
  paused: boolean;
  rate: number;
  currentTime: number;
  duration: number;
  blockIndex: number;
  totalBlocks: number;
  canDownload: boolean;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

/** One spoken reply, fed block by block: blocks come from the committed
 * splitter (`/api/tts/prepare`), the caller decides when each one is closed,
 * and `end` settles after the last queued block has played. */
export interface SpeechStream {
  /** Queue one utterance block; empty blocks are dropped. */
  push(block: string): void;
  /** No further blocks; resolves when everything queued has played. */
  end(): Promise<void>;
  /** Split text through the server's committed splitter; rejects like `speak`. */
  prepare(text: string): Promise<string[]>;
  /** Adopt the completed reply's message id: the snapshot and the probe
   * records carry it from here on. */
  identify(messageId: string | undefined): void;
  /** Tear down this stream's audio, but only while it is still the speaker's
   * current stream: a superseded stream must not silence its successor. */
  cancel(): void;
  /** Surface a fatal error and kill the stream. */
  fail(error: string): void;
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };
const PREFETCH_WINDOW = 3;
const CLIENT_CACHE_TTL_MS = 12 * 3600 * 1000;
const CLIENT_CACHE_MAX = 150;

export function mergeAudioBlobs(blobs: Blob[]): Blob {
  if (blobs.length === 0) return new Blob([], { type: "audio/wav" });
  if (blobs.length === 1) return blobs[0]!;
  const mime = blobs[0]!.type || "audio/wav";
  return new Blob(blobs, { type: mime });
}

export async function mergeWavOrAudioBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) return new Blob([], { type: "audio/wav" });
  if (blobs.length === 1) return blobs[0]!;
  try {
    const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
    const views = buffers.map((b) => new Uint8Array(b));
    const allWav = views.every(
      (v) =>
        v.byteLength >= 44 &&
        v[0] === 0x52 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x46 && // RIFF
        v[8] === 0x57 && v[9] === 0x41 && v[10] === 0x56 && v[11] === 0x45, // WAVE
    );
    if (allWav) {
      const pcmParts = views.map((v) => v.subarray(44));
      const totalPcm = pcmParts.reduce((acc, p) => acc + p.byteLength, 0);
      const out = new Uint8Array(44 + totalPcm);
      out.set(views[0]!.subarray(0, 44), 0);
      const dv = new DataView(out.buffer);
      dv.setUint32(4, 36 + totalPcm, true);
      dv.setUint32(40, totalPcm, true);
      let offset = 44;
      for (const p of pcmParts) {
        out.set(p, offset);
        offset += p.byteLength;
      }
      return new Blob([out], { type: "audio/wav" });
    }
  } catch { /* fall through */ }
  return new Blob(blobs, { type: blobs[0]!.type || "audio/mpeg" });
}

const DEFAULT_PLAYBACK: PlaybackDetails = {
  paused: false,
  rate: 1,
  currentTime: 0,
  duration: 0,
  blockIndex: 0,
  totalBlocks: 0,
  canDownload: false,
};

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private playback: PlaybackDetails = DEFAULT_PLAYBACK;
  private playbackWatchers = new Set<(p: PlaybackDetails) => void>();
  private blobCache = new Map<string, { blob: Blob; ts: number }>();
  private ratePref = 1;
  private activeBlobs: Blob[] = [];
  private activeUtterances: string[] = [];
  private activeVoiceId: string | undefined = undefined;
  private navRequest: { targetBlock: number; offsetSec?: number } | null = null;
  private activeBlockControl: { currentIndex: () => number; total: () => number } | null = null;
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  private localUtterance: SpeechSynthesisUtterance | null = null;
  private settleLocalSpeech: ((finished: boolean) => void) | null = null;
  /** Identity is the claim object, not the callback, so an older release cannot clear a newer claim. */
  private externalClaim: { pause: () => void } | null = null;

  private getCachedBlob(key: string): Blob | null {
    const entry = this.blobCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CLIENT_CACHE_TTL_MS) {
      this.blobCache.delete(key);
      return null;
    }
    return entry.blob;
  }

  private setCachedBlob(key: string, blob: Blob): void {
    if (this.blobCache.size >= CLIENT_CACHE_MAX) {
      const oldest = this.blobCache.keys().next().value;
      if (oldest) this.blobCache.delete(oldest);
    }
    this.blobCache.set(key, { blob, ts: Date.now() });
  }

  clearCache(): void {
    this.blobCache.clear();
  }

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  subscribePlayback(fn: (p: PlaybackDetails) => void): () => void {
    this.playbackWatchers.add(fn);
    fn(this.playback);
    return () => this.playbackWatchers.delete(fn);
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  get playbackState(): PlaybackDetails {
    return this.playback;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of Array.from(this.watchers)) watcher(next);
  }

  private setPlayback(patch: Partial<PlaybackDetails>) {
    this.playback = { ...this.playback, ...patch };
    for (const watcher of Array.from(this.playbackWatchers)) watcher(this.playback);
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  isPaused(messageId?: string): boolean {
    if (this.snapshot.status !== "speaking") return false;
    if (messageId && this.snapshot.messageId !== messageId) return false;
    return this.playback.paused;
  }

  pause(): void {
    if (this.snapshot.status !== "speaking" || !this.audio) return;
    this.audio.pause();
    this.setPlayback({ paused: true, currentTime: this.audio.currentTime || 0 });
  }

  resume(): void {
    if (this.snapshot.status !== "speaking" || !this.audio) return;
    this.setPlayback({ paused: false });
    void this.audio.play().catch(() => {});
  }

  togglePause(): void {
    if (this.playback.paused) this.resume();
    else this.pause();
  }

  setRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(2.5, rate));
    this.ratePref = clamped;
    if (this.audio) {
      try { this.audio.playbackRate = clamped; } catch { /* ignore */ }
    }
    this.setPlayback({ rate: clamped });
  }

  seek(seconds: number): void {
    if (!this.audio) return;
    const dur = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    const next = Math.max(0, dur > 0 ? Math.min(dur, seconds) : seconds);
    try { this.audio.currentTime = next; } catch { /* ignore */ }
    this.setPlayback({ currentTime: next });
  }

  skip(deltaSeconds: number): void {
    if (!this.audio) return;
    const cur = this.audio.currentTime || 0;
    const dur = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    const target = cur + deltaSeconds;
    const ctrl = this.activeBlockControl;
    if (target < 0 && ctrl && ctrl.currentIndex() > 0 && this.settlePlayback) {
      this.navRequest = { targetBlock: ctrl.currentIndex() - 1, offsetSec: -1 };
      this.settlePlayback(true);
      return;
    }
    if (dur > 0 && target >= dur && ctrl && ctrl.currentIndex() + 1 < ctrl.total() && this.settlePlayback) {
      this.navRequest = { targetBlock: ctrl.currentIndex() + 1, offsetSec: 0 };
      this.settlePlayback(true);
      return;
    }
    this.seek(target);
  }

  jumpToBlock(blockIndex: number): void {
    const ctrl = this.activeBlockControl;
    if (!ctrl || !this.settlePlayback) return;
    const clamped = Math.max(0, Math.min(ctrl.total() - 1, blockIndex));
    this.navRequest = { targetBlock: clamped, offsetSec: 0 };
    this.settlePlayback(true);
  }

  async downloadCurrentAudio(filenamePrefix = "openmausbot-voice"): Promise<boolean> {
    if ((!this.activeBlobs.length && !this.activeUtterances.length) || typeof document === "undefined") return false;
    const blobs: Blob[] = [];
    const total = Math.max(this.activeUtterances.length, this.activeBlobs.length);
    for (let i = 0; i < total; i++) {
      const existing = this.activeBlobs[i];
      if (existing) {
        blobs.push(existing);
        continue;
      }
      const utterance = this.activeUtterances[i];
      if (!utterance) continue;
      const cacheKey = `${this.activeVoiceId ?? ""}:${utterance}`;
      const cached = this.getCachedBlob(cacheKey);
      if (cached) {
        this.activeBlobs[i] = cached;
        blobs.push(cached);
        continue;
      }
      try {
        const fetched = await this.render(utterance, this.activeVoiceId, new AbortController().signal);
        this.setCachedBlob(cacheKey, fetched);
        this.activeBlobs[i] = fetched;
        blobs.push(fetched);
      } catch {
        // skip failed block if any
      }
    }
    if (!blobs.length) return false;
    const merged = await mergeWavOrAudioBlobs(blobs);
    const ext = merged.type.includes("wav") ? "wav" : "mp3";
    const url = URL.createObjectURL(merged);
    try {
      const a = document.createElement("a");
      a.href = url;
      const msgPart = this.snapshot.messageId ? `-${this.snapshot.messageId.slice(0, 8)}` : "";
      a.download = `${filenamePrefix}${msgPart}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  stop() {
    this.token += 1;
    this.navRequest = null;
    this.activeBlockControl = null;
    this.activeBlobs = [];
    this.activeUtterances = [];
    this.activeVoiceId = undefined;
    const external = this.externalClaim;
    this.externalClaim = null;
    external?.pause();
    this.request?.abort();
    this.request = null;
    this.settleLocalSpeech?.(false);
    this.settleLocalSpeech = null;
    this.localUtterance = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    // Pausing or removing an <audio> source does not reliably fire `ended` or `error`.
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
    this.setPlayback({ ...DEFAULT_PLAYBACK, rate: this.ratePref });
  }

  claimExternalVoice(pause: () => void): () => void {
    this.stop();
    const claim = { pause };
    this.externalClaim = claim;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.externalClaim === claim) this.externalClaim = null;
    };
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const stream = this.begin(opts);
    let utterances: string[];
    try {
      utterances = await stream.prepare(text);
    } catch (e) {
      stream.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    for (const utterance of utterances) stream.push(utterance);
    await stream.end();
  }

  begin(opts: SpeakOptions = {}): SpeechStream {
    recordSpeakEnter(opts.messageId);
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    return localSystemVoiceActive()
      ? this.localStream(opts, live, controller)
      : this.networkStream(opts, live, controller);
  }

  /** The completed frame's message id must reach the snapshot and the probe
   * records, which read `opts.messageId` when they fire. */
  private adoptMessageId(opts: SpeakOptions, live: () => boolean, messageId: string | undefined): void {
    opts.messageId = messageId;
    if (live() && this.snapshot.status !== "idle") this.set({ ...this.snapshot, messageId });
  }

  /** The system voice has no splitter round trip: one utterance per block, the
   * whole text for a completed reply, so streaming degrades to speaking at the
   * authoritative frame. */
  private localStream(opts: SpeakOptions, live: () => boolean, controller: AbortController): SpeechStream {
    let chain: Promise<void> = Promise.resolve();
    let closed = false;
    let pushed = false;
    return {
      push: (block) => {
        if (closed || !block || !live()) return;
        pushed = true;
        chain = chain.then(() => (live() ? this.speakWithLocalSystem(block, opts, live) : undefined));
      },
      end: async () => {
        closed = true;
        await chain;
        if (!pushed && live()) this.set(IDLE);
        if (this.request === controller) this.request = null;
      },
      prepare: async (text) => [text],
      identify: (messageId) => this.adoptMessageId(opts, live, messageId),
      cancel: () => { if (live()) this.stop(); },
      fail: (error) => {
        closed = true;
        if (live()) {
          controller.abort();
          this.set({ ...IDLE, error });
        }
        if (this.request === controller) this.request = null;
      },
    };
  }

  private networkStream(opts: SpeakOptions, live: () => boolean, controller: AbortController): SpeechStream {
    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const pending: string[] = [];
    let closed = false;
    let finished = false;
    let running = false;
    let wake: (() => void) | null = null;
    let settleDrained: () => void = () => {};
    const drained = new Promise<void>((resolve) => { settleDrained = resolve; });
    const finish = () => {
      if (finished) return;
      finished = true;
      closed = true;
      wake?.();
      settleDrained();
    };
    const render = (utterance: string, block: number): Promise<Rendered> => {
      recordBlockTiming(opts.messageId, block, "renderStart");
      const cacheKey = `${opts.voiceId ?? ""}:${utterance}`;
      const cached = this.getCachedBlob(cacheKey);
      if (cached) {
        recordBlockTiming(opts.messageId, block, "renderDone");
        return Promise.resolve({ blob: cached });
      }
      return this.render(utterance, opts.voiceId, controller.signal).then(
        (blob) => {
          this.setCachedBlob(cacheKey, blob);
          recordBlockTiming(opts.messageId, block, "renderDone");
          return { blob };
        },
        (error: unknown) => ({ error }),
      );
    };
    const run = async (): Promise<void> => {
      const inFlight = new Map<number, Promise<Rendered>>();
      const resolvedBlobs = new Map<number, Blob>();
      let index = 0;
      let playedAll = false;
      this.activeBlobs = [];
      this.activeUtterances = pending;
      this.activeVoiceId = opts.voiceId;
      this.activeBlockControl = {
        currentIndex: () => Math.max(0, index - 1),
        total: () => pending.length,
      };
      for (;;) {
        for (let b = index; b < Math.min(pending.length, index + PREFETCH_WINDOW); b++) {
          if (!inFlight.has(b) && !resolvedBlobs.has(b)) {
            inFlight.set(
              b,
              render(pending[b]!, b).then((res) => {
                if ("blob" in res && res.blob) {
                  resolvedBlobs.set(b, res.blob);
                  this.activeBlobs[b] = res.blob;
                }
                return res;
              }),
            );
          }
        }
        if (index >= pending.length) {
          if (closed || !live()) {
            playedAll = closed;
            break;
          }
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const at = index;
        index += 1;
        let blob = resolvedBlobs.get(at);
        if (!blob) {
          const current = inFlight.get(at) ?? render(pending[at]!, at);
          inFlight.delete(at);
          const rendered = await current;
          if ("error" in rendered) {
            if (live()) {
              this.set({ ...IDLE, error: rendered.error instanceof Error ? rendered.error.message : String(rendered.error) });
            }
            controller.abort();
            return;
          }
          blob = rendered.blob;
          resolvedBlobs.set(at, blob);
          this.activeBlobs[at] = blob;
        }
        if (!live()) {
          controller.abort();
          return;
        }
        const navOffset = this.navRequest?.offsetSec;
        this.navRequest = null;
        this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: pending[at]! });
        this.setPlayback({
          paused: false,
          blockIndex: at,
          totalBlocks: pending.length,
          canDownload: true,
        });
        const played = await this.play(blob, live, opts.messageId, at, navOffset);
        if (this.navRequest && live()) {
          index = Math.max(0, Math.min(pending.length - 1, this.navRequest.targetBlock));
          continue;
        }
        if (!played || !live()) {
          if (live()) this.set({ ...IDLE, error: "The generated voice clip couldn't be played." });
          controller.abort();
          return;
        }
      }
      if (playedAll && live() && !finished) {
        this.set(IDLE);
        this.setPlayback({ ...DEFAULT_PLAYBACK, rate: this.ratePref });
      }
      if (this.request === controller) this.request = null;
    };
    const kick = () => {
      if (finished) return;
      wake?.();
      if (running || (!pending.length && !closed)) return;
      // A microtask lets one batch of pushes fill the prefetch window before
      // the first render starts, the way the whole-text path always did.
      running = true;
      void Promise.resolve().then(run).finally(() => {
        running = false;
        finish();
      });
    };
    return {
      push: (block) => {
        if (finished || !block) return;
        pending.push(block);
        kick();
      },
      end: () => {
        closed = true;
        kick();
        return drained;
      },
      prepare: async (text) => {
        const utterances = await this.prepare(text, opts.voiceId, controller.signal);
        recordPrepared(opts.messageId, utterances.length);
        return utterances;
      },
      identify: (messageId) => this.adoptMessageId(opts, live, messageId),
      cancel: () => { if (live()) this.stop(); },
      fail: (error) => {
        if (finished) return;
        const wasLive = live();
        controller.abort();
        if (wasLive) {
          if (this.settlePlayback) this.settlePlayback(false);
          else this.teardownAudio();
          this.set({ ...IDLE, error });
        }
        if (this.request === controller) this.request = null;
        finish();
      },
    };
  }

  private speakWithLocalSystem(
    text: string,
    opts: SpeakOptions,
    live: () => boolean,
  ): Promise<void> {
    if (!live()) return Promise.resolve();
    const value = text.trim();
    if (!value) {
      this.set(IDLE);
      return Promise.resolve();
    }

    const synth = window.speechSynthesis;
    const utterance = new window.SpeechSynthesisUtterance(value);
    const selected = resolveLocalSystemVoice(remoteSystemVoice(opts.botId));
    if (selected) utterance.voice = selected;
    this.localUtterance = utterance;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (finished: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (this.localUtterance === utterance) this.localUtterance = null;
        if (this.settleLocalSpeech === finish) this.settleLocalSpeech = null;
        if (live()) this.set(finished ? IDLE : { ...IDLE, ...(error ? { error } : {}) });
        resolve();
      };
      this.settleLocalSpeech = finish;
      utterance.onstart = () => {
        if (live()) {
          this.set({
            status: "speaking",
            botId: opts.botId,
            messageId: opts.messageId,
            caption: value,
          });
        }
      };
      utterance.onend = () => finish(true);
      utterance.onerror = (event) => {
        const interrupted = event.error === "canceled" || event.error === "interrupted";
        finish(false, interrupted ? undefined : "This Mac could not play its selected voice.");
      };
      try {
        synth.speak(utterance);
      } catch {
        finish(false, "This Mac could not start its selected voice.");
      }
    });
  }

  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    const body: TtsPrepareBody = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `the voice service returned ${res.status}`);
    if (!body.ready) {
      throw new Error("Set up a voice provider in an agent profile on this computer, then pick a voice for the agent.");
    }
    return body.utterances ?? [];
  }

  private async render(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `the voice service returned ${res.status}`);
    }
    return res.blob();
  }

  private play(blob: Blob, live: () => boolean, probeMessageId?: string, probeBlock?: number, initialOffsetSec?: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      try { audio.playbackRate = this.ratePref; } catch { /* ignore */ }
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
        audio.onloadedmetadata = null;
        if (probeMessageId !== undefined && probeBlock !== undefined) {
          recordBlockTiming(probeMessageId, probeBlock, "audioEnd");
        }
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onloadedmetadata = () => {
        const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        if (initialOffsetSec !== undefined && dur > 0) {
          const startAt = initialOffsetSec < 0 ? Math.max(0, dur - 5) : Math.min(dur, initialOffsetSec);
          try { audio.currentTime = startAt; } catch { /* ignore */ }
        }
        this.setPlayback({ duration: dur, currentTime: audio.currentTime || 0 });
      };
      audio.ontimeupdate = () => {
        const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : this.playback.duration;
        this.setPlayback({ currentTime: audio.currentTime || 0, duration: dur });
      };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.play().then(
        () => {
          if (probeMessageId !== undefined && probeBlock !== undefined) {
            recordBlockTiming(probeMessageId, probeBlock, "audioStart");
          }
        },
        () => done(false),
      );
    });
  }
}

export const speaker = new Speaker();
