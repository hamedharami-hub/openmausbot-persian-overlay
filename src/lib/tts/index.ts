// Audio comes from the harness, which holds the voice keys: the renderer never sees them or calls a voice provider.

import { localDeviceVoiceActive, remoteSystemVoice, resolveLocalDeviceVoice } from "@/lib/local-voice";
import { recordBlockTiming, recordPrepared, recordSpeakEnter } from "../voice-latency-probe";

export type SpeechStatus = "idle" | "preparing" | "speaking" | "paused";

export interface SpeechSnapshot {
  status: SpeechStatus;
  playbackRate?: number;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
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

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; cacheNamespace?: string; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };
const PREFETCH_WINDOW = 3;
const AUDIO_CACHE_TTL_MS = 30 * 60 * 1_000;
const AUDIO_CACHE_MAX_ENTRIES = 40;
const AUDIO_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const AUDIO_CACHE_MAX_CLIP_BYTES = 4 * 1024 * 1024;

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  private localUtterance: SpeechSynthesisUtterance | null = null;
  private settleLocalSpeech: ((finished: boolean) => void) | null = null;
  private playbackRate = 1;
  /** Identity is the claim object, not the callback, so an older release cannot clear a newer claim. */
  private externalClaim: { pause: () => void } | null = null;
  /** Memory-only and bounded; text and clips are never written to disk by this cache. */
  private renderedAudio = new Map<string, { blob: Blob; storedAt: number }>();

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of Array.from(this.watchers)) watcher(next);
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  pauseOrResume(): void {
    if (this.snapshot.status === "preparing") return;
    if (this.audio) {
      if (this.audio.paused) {
        void this.audio.play().then(() => this.set({ ...this.snapshot, status: "speaking" })).catch(() => {
          this.set({ ...this.snapshot, status: "paused", error: "The generated voice clip couldn't resume." });
        });
      } else {
        this.audio.pause();
        this.set({ ...this.snapshot, status: "paused" });
      }
      return;
    }
    if (!this.localUtterance || typeof window === "undefined") return;
    if (this.snapshot.status === "paused") {
      window.speechSynthesis?.resume();
      this.set({ ...this.snapshot, status: "speaking" });
    } else {
      window.speechSynthesis?.pause();
      this.set({ ...this.snapshot, status: "paused" });
    }
  }

  cyclePlaybackRate(): number {
    const rates = [0.75, 1, 1.25, 1.5, 1.75, 2];
    const index = rates.indexOf(this.playbackRate);
    this.playbackRate = rates[(index + 1) % rates.length] ?? 1;
    if (this.audio) this.audio.playbackRate = this.playbackRate;
    if (this.localUtterance) this.localUtterance.rate = this.playbackRate;
    if (this.snapshot.status !== "idle") this.set({ ...this.snapshot, playbackRate: this.playbackRate });
    return this.playbackRate;
  }

  stop() {
    this.token += 1;
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

    this.set({ status: "preparing", ...(opts.botId ? { botId: opts.botId } : {}), ...(opts.messageId ? { messageId: opts.messageId } : {}) });
    return localDeviceVoiceActive()
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
    let cacheNamespace = "";
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
      return this.render(utterance, opts.voiceId, controller.signal, cacheNamespace).then(
        (blob) => {
          recordBlockTiming(opts.messageId, block, "renderDone");
          return { blob };
        },
        (error: unknown) => ({ error }),
      );
    };
    const run = async (): Promise<void> => {
      const inFlight: Promise<Rendered>[] = [];
      let index = 0;
      let playedAll = false;
      for (;;) {
        while (inFlight.length < PREFETCH_WINDOW && index + inFlight.length < pending.length) {
          const block = index + inFlight.length;
          inFlight.push(render(pending[block]!, block));
        }
        if (!inFlight.length) {
          if (closed || !live()) {
            playedAll = closed;
            break;
          }
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const current = inFlight.shift()!;
        const at = index;
        index += 1;
        const rendered = await current;
        if ("error" in rendered) {
          if (live()) {
            this.set({ ...IDLE, error: rendered.error instanceof Error ? rendered.error.message : String(rendered.error) });
          }
          controller.abort();
          return;
        }
        if (!live()) {
          controller.abort();
          return;
        }
        this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: pending[at]! });
        const played = await this.play(rendered.blob, live, opts.messageId, at);
        if (!played || !live()) {
          if (live()) this.set({ ...IDLE, error: "The generated voice clip couldn't be played." });
          controller.abort();
          return;
        }
      }
      if (playedAll && live() && !finished) this.set(IDLE);
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
        const prepared = await this.prepare(text, opts.voiceId, controller.signal);
        cacheNamespace = prepared.cacheNamespace;
        recordPrepared(opts.messageId, prepared.utterances.length);
        return prepared.utterances;
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
    utterance.rate = this.playbackRate;
    const scriptIsPersian = /[\u0600-\u06FF]/u.test(value);
    if (scriptIsPersian) utterance.lang = "fa-IR";
    const selected = resolveLocalDeviceVoice(remoteSystemVoice(opts.botId)) ??
      (scriptIsPersian
        ? window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("fa")) ?? null
        : null);
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
        finish(false, interrupted ? undefined : "This device could not play its selected voice.");
      };
      try {
        synth.speak(utterance);
      } catch {
        finish(false, "This device could not start its selected voice.");
      }
    });
  }

  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<{ utterances: string[]; cacheNamespace: string }> {
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
    return { utterances: body.utterances ?? [], cacheNamespace: body.cacheNamespace ?? "" };
  }

  private async render(text: string, voiceId: string | undefined, signal: AbortSignal, cacheNamespace: string): Promise<Blob> {
    const key = JSON.stringify([cacheNamespace, voiceId ?? "", text]);
    const now = Date.now();
    for (const [cachedKey, value] of this.renderedAudio) {
      if (now - value.storedAt >= AUDIO_CACHE_TTL_MS) this.renderedAudio.delete(cachedKey);
    }
    const cached = this.renderedAudio.get(key);
    if (cached) {
      this.renderedAudio.delete(key);
      this.renderedAudio.set(key, cached);
      return cached.blob;
    }
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
    const blob = await res.blob();
    if (!signal.aborted && blob.size > 0 && blob.size <= AUDIO_CACHE_MAX_CLIP_BYTES) {
      this.renderedAudio.set(key, { blob, storedAt: now });
      while (this.renderedAudio.size > AUDIO_CACHE_MAX_ENTRIES ||
        [...this.renderedAudio.values()].reduce((sum, value) => sum + value.blob.size, 0) > AUDIO_CACHE_MAX_BYTES) {
        const oldest = this.renderedAudio.keys().next().value;
        if (oldest === undefined) break;
        this.renderedAudio.delete(oldest);
      }
    }
    return blob;
  }

  private play(blob: Blob, live: () => boolean, probeMessageId?: string, probeBlock?: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = this.playbackRate;
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        if (probeMessageId !== undefined && probeBlock !== undefined) {
          recordBlockTiming(probeMessageId, probeBlock, "audioEnd");
        }
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
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
