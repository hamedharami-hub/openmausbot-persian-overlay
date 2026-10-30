// Its data channel may only send session.close; everything else about the call runs on the harness.
import { useSyncExternalStore } from "react";
import type { LiveCallState, LiveEndReason } from "../../shared/wire";
import { api, ApiError } from "@/state/store";
import { openExternalLink } from "./app-links";
import { endCall, startCall } from "./call";
import { desktopCapabilitiesNow } from "./desktop";
import { t } from "./i18n";

export type LiveMediaPhase = "idle" | "starting" | "live" | "ending" | "ended" | "failed";

export type LiveCallAction = "retry" | "open-in-browser";

export function isLiveCallRunning(phase: LiveMediaPhase): boolean {
  return phase === "starting" || phase === "live" || phase === "ending";
}

export interface LiveMediaState {
  phase: LiveMediaPhase;
  callId: string | null;
  botId: string | null;
  threadId: string | null;
  startedAt: number | null;
  muted: boolean;
  caption: string;
  heard: string;
  notice: string | null;
  needsKey: boolean;
  busyWith: LiveCallState | null;
  action: LiveCallAction | null;
  hangingUp: boolean;
  /** The notice is the computer refusing the microphone: it comes with Open System Settings. */
  micSettings?: boolean;
  provider?: "openai" | "gemini";
}

export interface LiveMediaDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T>;
  playRemote(track: MediaStreamTrack): Promise<void> | void;
  stopRemote(): void;
  iceTimeoutMs: number;
  capabilities(): DesktopCapabilities;
  pageMicrophone(): Promise<"allowed" | "refused" | undefined>;
  openInBrowser(url: string): void;
}

const IDLE: LiveMediaState = {
  phase: "idle", callId: null, botId: null, threadId: null, startedAt: null, muted: false,
  caption: "", heard: "", notice: null, needsKey: false, busyWith: null, action: null, hangingUp: false,
};
const CAPTION_CHARS = 240;
const HEARD_CHARS = 160;
const HEARD_CLEAR_MS = 2_500;
const ENDED_NOTICE_MS = 4_000;
const SERVER_CLOSE_GRACE_MS = 3_000;
export const MEDIA_CONNECT_TIMEOUT_MS = 20_000;

class LiveUnsupportedError extends Error {}

let audio: HTMLAudioElement | null = null;
const defaults: LiveMediaDeps = {
  getUserMedia: (constraints) => {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) return Promise.reject(new LiveUnsupportedError(t("call.live.unsupported")));
    return navigator.mediaDevices.getUserMedia(constraints);
  },
  createPeer: () => {
    if (typeof RTCPeerConnection === "undefined") throw new LiveUnsupportedError(t("call.live.unsupported"));
    return new RTCPeerConnection();
  },
  request: (path, init) => api(path, init),
  playRemote: async (track) => {
    audio ??= Object.assign(document.createElement("audio"), { autoplay: true });
    audio.srcObject = new MediaStream([track]);
    await audio.play();
  },
  stopRemote: () => {
    if (audio) audio.srcObject = null;
  },
  iceTimeoutMs: 10_000,
  capabilities: desktopCapabilitiesNow,
  pageMicrophone: async () => {
    try {
      return (await globalThis.window?.ogb?.permStatus?.())?.pageMic;
    } catch {
      return undefined;
    }
  },
  openInBrowser: (url) => void openExternalLink(url).catch(() => undefined),
};
let deps: LiveMediaDeps = defaults;

let state: LiveMediaState = IDLE;
let generation = 0;
let microphone: MediaStream | null = null;
let geminiSocket: WebSocket | null = null;
let geminiAudioContext: AudioContext | null = null;
let geminiProcessor: ScriptProcessorNode | null = null;
let geminiOutputSources = new Set<AudioBufferSourceNode>();
let geminiOutputTime = 0;
let geminiLeaseCallId: string | null = null;
let geminiReady = false;
let geminiSessionTimer: ReturnType<typeof setTimeout> | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let heardTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let stopGestureWait: (() => void) | null = null;
let serverCall: LiveCallState | null = null;
let serverAttached = false;
const watchers = new Set<() => void>();

function set(patch: Partial<LiveMediaState>) {
  state = { ...state, ...patch };
  for (const watcher of Array.from(watchers)) watcher();
}

export function liveMedia(): LiveMediaState {
  return state;
}

/** One function for every consumer, so useSyncExternalStore never resubscribes on a render. */
export function subscribeLiveMedia(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function useLiveMedia(): LiveMediaState {
  return useSyncExternalStore(subscribeLiveMedia, liveMedia, liveMedia);
}

export function configureLiveMedia(overrides: Partial<LiveMediaDeps>): void {
  deps = { ...defaults, ...overrides };
}

export function resetLiveMedia(): void {
  release();
  generation += 1;
  deps = defaults;
  state = IDLE;
  serverCall = null;
  serverAttached = false;
}

export function applyCaption(current: { caption: string; heard: string }, event: { type?: unknown; delta?: unknown }): { caption: string; heard: string } {
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (event.type === "session.output_transcript.delta") return { caption: (current.caption + delta).slice(-CAPTION_CHARS), heard: "" };
  if (event.type === "session.input_transcript.delta") return { caption: current.caption, heard: (current.heard + delta).slice(-HEARD_CHARS) };
  return current;
}

export function endNotice(reason: LiveEndReason | undefined): { text: string; dropped: boolean } {
  switch (reason) {
    case "idle": return { text: t("call.live.endedIdle"), dropped: false };
    case "expired": return { text: t("call.live.endedExpired"), dropped: false };
    case "content": return { text: t("call.live.endedContent"), dropped: false };
    case "deleted": return { text: t("call.live.endedDeleted"), dropped: false };
    case "shutdown": return { text: t("call.live.endedShutdown"), dropped: false };
    case "signed-out": return { text: t("call.live.endedSignedOut"), dropped: false };
    case "remote-hangup":
    case "connection-lost":
    case "sideband-lost":
    case "error": return { text: t("call.live.dropped"), dropped: true };
    default: return { text: t("call.live.ended"), dropped: false };
  }
}

function inWebBrowser(capabilities: DesktopCapabilities): boolean {
  return capabilities.dictation.reasonCode === "desktop-app-required";
}

function micBlocked(capabilities: DesktopCapabilities, pageMic: "allowed" | "refused" | undefined): { notice: string; action: LiveCallAction; micSettings?: true } {
  if (pageMic === "refused" || (pageMic === undefined && capabilities.dictation.reasonCode === "remote-server")) {
    return { notice: t("call.live.micAppRefused"), action: "open-in-browser" };
  }
  return inWebBrowser(capabilities) ? { notice: t("call.live.micBlockedBrowser"), action: "retry" }
    : { notice: t("call.live.micBlocked"), action: "retry", micSettings: true };
}

function liveClient(capabilities: DesktopCapabilities): "desktop" | "web" {
  return inWebBrowser(capabilities) ? "web" : "desktop";
}

type GeminiLiveResponse = {
  token: string;
  callId: string;
  idleMinutes: number;
  setup: Record<string, unknown>;
  initialTurns: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
};

type GeminiLiveServerMessage = {
  error?: { message?: string };
  setupComplete?: unknown;
  serverContent?: {
    inputTranscription?: { text?: string };
    interimInputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> };
};

export function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate = 16_000): Uint8Array {
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const pcm = new Uint8Array(length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let total = 0;
    for (let sample = start; sample < end; sample += 1) total += input[sample] ?? 0;
    const average = end > start ? total / (end - start) : 0;
    const clamped = Math.max(-1, Math.min(1, average));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return pcm;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sendGeminiRealtimeAudio(mine: number, input: Float32Array, sampleRate: number) {
  if (mine !== generation || !geminiReady || state.muted || geminiSocket?.readyState !== WebSocket.OPEN) return;
  const bytes = downsampleToPcm16(input, sampleRate);
  if (!bytes.byteLength) return;
  geminiSocket.send(JSON.stringify({ realtimeInput: { audio: { data: bytesToBase64(bytes), mimeType: "audio/pcm;rate=16000" } } }));
}

function scheduleGeminiAudio(base64: string, mimeType: string) {
  const context = geminiAudioContext;
  if (!context) return;
  const match = /rate=(\d+)/i.exec(mimeType);
  const sampleRate = match ? Number(match[1]) : 24_000;
  const bytes = base64ToBytes(base64);
  if (bytes.byteLength < 2 || bytes.byteLength % 2) return;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const buffer = context.createBuffer(1, pcm.length, sampleRate);
  const channelData = buffer.getChannelData(0);
  for (let index = 0; index < pcm.length; index += 1) channelData[index] = pcm[index]! / 32768;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const startAt = Math.max(context.currentTime + 0.02, geminiOutputTime);
  source.onended = () => { geminiOutputSources.delete(source); try { source.disconnect(); } catch {} };
  geminiOutputSources.add(source);
  source.start(startAt);
  geminiOutputTime = startAt + buffer.duration;
}

function interruptGeminiAudio() {
  for (const source of geminiOutputSources) {
    try { source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }
  geminiOutputSources.clear();
  geminiOutputTime = geminiAudioContext?.currentTime ?? 0;
}

function handleGeminiMessage(mine: number, raw: unknown) {
  if (mine !== generation) return;
  let message: GeminiLiveServerMessage;
  try { message = JSON.parse(String(raw)) as GeminiLiveServerMessage; } catch { return; }
  if (message.error) return void finish({ text: "Gemini Live ended unexpectedly.", dropped: true }, "Gemini Live returned an error. Check the key and Google AI Studio quota.");
  const server = message.serverContent;
  if (server && typeof server === "object") {
    const inputText = typeof server.inputTranscription?.text === "string" ? server.inputTranscription.text :
      typeof server.interimInputTranscription?.text === "string" ? server.interimInputTranscription.text : "";
    const outputText = typeof server.outputTranscription?.text === "string" ? server.outputTranscription.text : "";
    if (inputText || outputText) {
      set({
        ...(inputText ? { heard: inputText.slice(-HEARD_CHARS) } : {}),
        ...(outputText ? { caption: (state.caption + outputText).slice(-CAPTION_CHARS), heard: "" } : {}),
      });
    }
    if (server.interrupted) interruptGeminiAudio();
    const parts = server.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part.inlineData?.data === "string") scheduleGeminiAudio(part.inlineData.data, part.inlineData.mimeType ?? "audio/pcm;rate=24000");
      }
    }
    if (server.turnComplete && state.phase === "starting") set({ phase: "live", startedAt: Date.now() });
  }
  const functions = message.toolCall?.functionCalls;
  if (Array.isArray(functions) && functions.length) void respondToGeminiTools(mine, functions);
}

async function respondToGeminiTools(mine: number, functions: Array<{ id?: string; name?: string; args?: unknown }>) {
  const responses = [];
  for (const call of functions) {
    if (call.name !== "delegate_to_openmausbot" || !call.id) {
      if (call.id && call.name) responses.push({ id: call.id, name: call.name, response: { error: "Unsupported tool." } });
      continue;
    }
    const textValue = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>).text : undefined;
    const task = typeof textValue === "string" ? textValue.trim().slice(0, 3_000) : "";
    try {
      if (!task || !state.botId || !state.threadId) throw new Error("The task was empty.");
      const callId = geminiLeaseCallId;
      if (!callId) throw new Error("The Live session ended.");
      const result = await deps.request<{ accepted?: boolean; queued?: boolean; error?: string }>("/api/live/gemini/delegate", {
        method: "POST",
        body: JSON.stringify({ callId, botId: state.botId, threadId: state.threadId, text: task }),
        timeoutMs: 20_000,
      });
      responses.push({ id: call.id, name: call.name, response: { accepted: result.accepted === true, queued: result.queued === true } });
    } catch {
      responses.push({ id: call.id, name: call.name, response: { accepted: false, error: "The OpenMausBot agent did not accept the task. Check the chat for status." } });
    }
  }
  if (mine === generation && geminiSocket?.readyState === WebSocket.OPEN && responses.length) {
    geminiSocket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }
}

async function startGeminiLiveCall(target: { botId: string; threadId: string }): Promise<void> {
  if (isLiveCallRunning(state.phase)) return;
  release();
  const mine = ++generation;
  geminiReady = false;
  set({ ...IDLE, phase: "starting", botId: target.botId, threadId: target.threadId, provider: "gemini" });
  startCall(target.botId);
  try {
    const stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (mine !== generation) return void stream.getTracks().forEach((track) => track.stop());
    microphone = stream;
    for (const track of stream.getAudioTracks()) track.enabled = !state.muted;
    if (typeof AudioContext === "undefined" || typeof WebSocket === "undefined") throw new LiveUnsupportedError(t("call.live.unsupported"));
    const context = new AudioContext();
    geminiAudioContext = context;
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    geminiProcessor = processor;
    processor.onaudioprocess = (event) => {
      sendGeminiRealtimeAudio(mine, event.inputBuffer.getChannelData(0), context.sampleRate);
      event.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(processor);
    processor.connect(context.destination);
    const result = await deps.request<GeminiLiveResponse>("/api/live/gemini/token", {
      method: "POST", body: JSON.stringify({ botId: target.botId, threadId: target.threadId }), timeoutMs: 20_000,
    });
    if (mine !== generation) {
      await deps.request("/api/live/gemini/end", { method: "POST", body: JSON.stringify({ callId: result.callId }), timeoutMs: 5_000 }).catch(() => undefined);
      return;
    }
    geminiLeaseCallId = result.callId;
    set({ callId: result.callId });
    geminiSessionTimer = setTimeout(() => {
      if (mine === generation) finish({ text: t("call.live.gemini.endedExpired"), dropped: false });
    }, 14 * 60_000 + 50_000);
    const socket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(result.token)}`);
    geminiSocket = socket;
    socket.onopen = () => {
      if (mine !== generation) return;
      socket.send(JSON.stringify({ setup: result.setup }));
    };
    socket.onmessage = (event) => {
      if (mine !== generation) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
      if (data.setupComplete) {
        socket.send(JSON.stringify({ clientContent: { turns: result.initialTurns, turnComplete: true } }));
        geminiReady = true;
        set({ phase: "live", startedAt: Date.now() });
        return;
      }
      handleGeminiMessage(mine, event.data);
    };
    socket.onerror = () => {
      if (mine === generation) void dropped("Gemini Live connection failed.");
    };
    socket.onclose = () => {
      if (mine === generation && state.phase !== "ending" && isLiveCallRunning(state.phase)) void dropped("Gemini Live connection closed.");
    };
  } catch (error) {
    if (mine !== generation) return;
    release();
    const body = error instanceof ApiError ? error.body as { needsKey?: boolean } | undefined : undefined;
    if (body?.needsKey) return set({ ...IDLE, needsKey: true, botId: target.botId, threadId: target.threadId, provider: "gemini" });
    if (error instanceof DOMException && error.name === "NotFoundError") return set({ ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, provider: "gemini", notice: t("call.live.micMissing"), action: "retry" });
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      const pageMic = await deps.pageMicrophone();
      if (mine !== generation) return;
      return set({ ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, provider: "gemini", ...micBlocked(deps.capabilities(), pageMic) });
    }
    set({ ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, provider: "gemini", action: error instanceof LiveUnsupportedError ? null : "retry", notice: error instanceof Error ? error.message : "Gemini Live could not start." });
  }
}

export async function startLiveCall(target: { botId: string; threadId: string }, provider: "openai" | "gemini" = "openai"): Promise<void> {
  if (provider === "gemini") return startGeminiLiveCall(target);
  if (isLiveCallRunning(state.phase)) return;
  release();
  const mine = ++generation;
  serverAttached = false;
  set({ ...IDLE, phase: "starting", botId: target.botId, threadId: target.threadId, provider: "openai" });
  startCall(target.botId);
  try {
    const stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (mine !== generation) return void stream.getTracks().forEach((track) => track.stop());
    microphone = stream;
    for (const track of stream.getAudioTracks()) track.enabled = !state.muted;
    const connection = deps.createPeer();
    peer = connection;
    connection.ontrack = (event) => {
      if (mine !== generation) return;
      void Promise.resolve(deps.playRemote(event.track)).catch(() => {
        if (mine !== generation) return;
        set({ notice: t("call.live.clickToHear") });
        playOnGesture(mine, event.track);
      });
    };
    connection.onconnectionstatechange = () => {
      if (mine !== generation) return;
      if (connection.connectionState === "connected") stopConnectWait();
      else if (connection.connectionState === "failed") void dropped(t("call.live.dropped"));
    };
    for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
    // the event channel must exist before the offer is created
    const events = connection.createDataChannel("oai-events");
    channel = events;
    events.onopen = () => {
      if (mine === generation) goLiveWhenReady();
    };
    events.onmessage = (event) => {
      if (mine === generation) onChannelMessage(event.data);
    };
    await connection.setLocalDescription(await connection.createOffer());
    await iceGathered(connection, deps.iceTimeoutMs);
    if (mine !== generation) return;
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error(t("call.live.noOffer"));
    const result = await deps.request<{ call: LiveCallState; transport: { sdp: string } }>("/api/live/session", {
      method: "POST",
      body: JSON.stringify({ botId: target.botId, threadId: target.threadId, sdp, client: liveClient(deps.capabilities()) }),
      timeoutMs: 35_000,
    });
    if (mine !== generation) {
      void endOnServer(result.call.callId);
      return;
    }
    const seen = serverCall;
    set({ callId: result.call.callId });
    applyServerCall(result.call);
    // The SSE frame can overtake this response; it was ignored then because the id was not known yet.
    if (seen?.callId === result.call.callId) applyServerCall(seen);
    if (mine !== generation) return;
    await connection.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
    if (mine !== generation) return;
    if (connection.connectionState !== "connected") {
      connectTimer = setTimeout(() => {
        if (mine === generation) void dropped(t("call.live.droppedNoAudio"));
      }, MEDIA_CONNECT_TIMEOUT_MS);
    }
  } catch (error) {
    if (mine !== generation) return;
    const body = error instanceof ApiError ? (error.body as { needsKey?: boolean; activeCall?: LiveCallState } | undefined) : undefined;
    if (state.callId) void endOnServer(state.callId);
    release();
    if (body?.needsKey) return set({ ...IDLE, needsKey: true, botId: target.botId, threadId: target.threadId });
    if (body?.activeCall) return set({ ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, busyWith: body.activeCall, notice: busyText(body.activeCall) });
    const failed = { ...IDLE, phase: "failed" as const, botId: target.botId, threadId: target.threadId };
    if (error instanceof DOMException && error.name === "NotFoundError") return set({ ...failed, notice: t("call.live.micMissing"), action: "retry" });
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      const pageMic = await deps.pageMicrophone();
      if (mine !== generation) return;
      return set({ ...failed, ...micBlocked(deps.capabilities(), pageMic) });
    }
    const hopeless = error instanceof LiveUnsupportedError || (error instanceof ApiError && error.status === 401);
    set({ ...failed, action: hopeless ? null : "retry", notice: error instanceof Error ? error.message : String(error) });
  }
}

export async function hangUpLiveCall(): Promise<void> {
  const { callId, phase, provider } = state;
  if (phase === "idle" || phase === "ended" || phase === "failed") return dismissLiveNotice();
  const mine = ++generation;
  set({ phase: "ending", hangingUp: true });
  // Stop capturing now; keep the channel alive until its close command and the end request leave.
  stopCapturing();
  if (provider === "gemini") {
    try { geminiSocket?.close(); } catch {}
    geminiLeaseCallId = null;
    if (callId) await endGeminiOnServer(callId);
  } else {
    sendClose();
    if (callId) await endOnServer(callId);
  }
  if (mine !== generation) return;
  release();
  set({ ...IDLE });
}

export function setLiveMuted(muted: boolean): void {
  for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !muted;
  set({ muted });
}

export type LiveCallShortcut = "mute" | "hangUp";

type ChordEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "defaultPrevented">;

export function liveCallShortcut(event: ChordEvent, isMac: boolean): LiveCallShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || !event.shiftKey) return null;
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const key = event.key.toLowerCase();
  return key === "m" ? "mute" : key === "h" ? "hangUp" : null;
}

export function liveCallChord(action: LiveCallShortcut, isMac: boolean): { text: string; aria: string } {
  const letter = action === "mute" ? "M" : "H";
  return isMac ? { text: `⌘⇧${letter}`, aria: `Meta+Shift+${letter}` } : { text: `Ctrl+Shift+${letter}`, aria: `Control+Shift+${letter}` };
}

export function handleLiveCallKey(event: ChordEvent, isMac: boolean): boolean {
  const action = liveCallShortcut(event, isMac);
  if (!action || !isLiveCallRunning(state.phase)) return false;
  if (action === "mute") setLiveMuted(!state.muted);
  else void hangUpLiveCall();
  return true;
}

export function dismissStartPrompt(botId: string): void {
  if (state.needsKey && state.botId === botId) dismissLiveNotice();
}

export function takeLiveCallAction(): void {
  const { action, botId, threadId, phase, provider } = state;
  if (phase !== "failed") return;
  if (action === "retry" && botId && threadId) void startLiveCall({ botId, threadId }, provider ?? "openai");
  else if (action === "open-in-browser" && globalThis.location?.href) deps.openInBrowser(globalThis.location.href);
}

export function dismissLiveNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  if (state.phase === "ended" || state.phase === "failed" || state.needsKey) set({ ...IDLE });
}

export function endSignedOut(): void {
  if (!isLiveCallRunning(state.phase)) return;
  finish(endNotice("signed-out"));
}

export async function checkLiveSignIn(): Promise<void> {
  if (!isLiveCallRunning(state.phase)) return;
  const mine = generation;
  try {
    await deps.request("/api/live/call", { timeoutMs: 8_000 });
  } catch (error) {
    if (mine === generation && error instanceof ApiError && error.status === 401) endSignedOut();
  }
}

export function onLiveStreamConnected(connected: boolean): void {
  if (!connected) void checkLiveSignIn();
}

export function onServerCall(call: LiveCallState | null): void {
  serverCall = call;
  applyServerCall(call);
}

function applyServerCall(call: LiveCallState | null) {
  if (!state.callId) return;
  if (!call) {
    if (state.phase === "starting" || state.phase === "live") finish({ text: t("call.live.ended"), dropped: false });
    return;
  }
  if (call.callId !== state.callId) return;
  if (call.status === "ended") {
    if (call.endReason === "hung-up" && state.hangingUp) endQuietly();
    else finish(endNotice(call.endReason), call.error);
    return;
  }
  if (call.status !== "connecting") serverAttached = true;
  if (call.status === "ending") {
    stopCapturing();
    stopConnectWait();
    if (state.phase !== "ending") set({ phase: "ending" });
    return;
  }
  goLiveWhenReady();
}

function goLiveWhenReady() {
  if (state.phase !== "starting" || !serverAttached || channel?.readyState !== "open") return;
  set({ phase: "live", startedAt: Date.now() });
}

function endQuietly() {
  release();
  generation += 1;
  set({ ...IDLE });
}

function finish(notice: { text: string; dropped: boolean }, detail?: string) {
  const { callId, botId, threadId, provider } = state;
  if (provider === "gemini") {
    const lease = geminiLeaseCallId ?? callId;
    geminiLeaseCallId = null;
    if (lease) void endGeminiOnServer(lease);
    try { geminiSocket?.close(); } catch {}
  } else sendClose();
  generation += 1;
  release();
  set({
    ...IDLE, phase: notice.dropped ? "failed" : "ended", botId, threadId,
    provider, notice: detail?.trim() || notice.text, action: notice.dropped ? "retry" : null,
  });
  if (!notice.dropped) {
    noticeTimer = setTimeout(dismissLiveNotice, ENDED_NOTICE_MS);
  }
}

async function dropped(text: string) {
  const { callId, provider } = state;
  finish({ text, dropped: true });
  if (provider !== "gemini" && callId) await endOnServer(callId);
}

async function endOnServer(callId: string): Promise<void> {
  await deps.request("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId }), timeoutMs: 8_000 }).catch(() => undefined);
}

async function endGeminiOnServer(callId: string): Promise<void> {
  await deps.request("/api/live/gemini/end", { method: "POST", body: JSON.stringify({ callId }), timeoutMs: 8_000 }).catch(() => undefined);
}

function onChannelMessage(raw: unknown) {
  let event: { type?: unknown; delta?: unknown };
  try {
    event = JSON.parse(String(raw)) as { type?: unknown; delta?: unknown };
  } catch {
    return;
  }
  if (event.type === "session.closed") {
    stopCapturing();
    stopConnectWait();
    if (!closeTimer) void checkLiveSignIn();
    closeTimer ??= setTimeout(() => finish({ text: t("call.live.ended"), dropped: false }), SERVER_CLOSE_GRACE_MS);
    return;
  }
  const next = applyCaption(state, event);
  if (next.caption === state.caption && next.heard === state.heard) return;
  set(next);
  if (event.type === "session.input_transcript.delta") {
    if (heardTimer) clearTimeout(heardTimer);
    heardTimer = setTimeout(() => set({ heard: "" }), HEARD_CLEAR_MS);
  }
}

/** Autoplay was blocked: the next click or key press plays the audio (a user gesture allows play()). */
function playOnGesture(mine: number, track: MediaStreamTrack) {
  const target = globalThis.document;
  if (!target || stopGestureWait) return;
  const retry = () => {
    stopGestureWait?.();
    stopGestureWait = null;
    if (mine !== generation) return;
    void Promise.resolve(deps.playRemote(track)).then(
      () => {
        if (mine === generation && state.notice === t("call.live.clickToHear")) set({ notice: null });
      },
      () => {
        if (mine === generation) playOnGesture(mine, track);
      },
    );
  };
  target.addEventListener("pointerdown", retry, true);
  target.addEventListener("keydown", retry, true);
  stopGestureWait = () => {
    target.removeEventListener("pointerdown", retry, true);
    target.removeEventListener("keydown", retry, true);
  };
}

function stopConnectWait() {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
}

function sendClose() {
  if (channel?.readyState === "open") {
    try { channel.send(JSON.stringify({ type: "session.close" })); } catch {}
  }
}

function stopCapturing() {
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
}

function release() {
  for (const timer of [heardTimer, closeTimer, noticeTimer, connectTimer, geminiSessionTimer]) if (timer) clearTimeout(timer);
  heardTimer = closeTimer = noticeTimer = connectTimer = null;
  geminiSessionTimer = null;
  stopGestureWait?.();
  stopGestureWait = null;
  stopCapturing();
  try { geminiProcessor?.disconnect(); } catch {}
  geminiProcessor = null;
  interruptGeminiAudio();
  try { geminiAudioContext?.close(); } catch {}
  geminiAudioContext = null;
  try { geminiSocket?.close(); } catch {}
  geminiSocket = null;
  const lease = geminiLeaseCallId;
  geminiLeaseCallId = null;
  if (lease) void endGeminiOnServer(lease);
  geminiReady = false;
  try { channel?.close(); } catch {}
  channel = null;
  try { peer?.close(); } catch {}
  peer = null;
  deps.stopRemote();
  if (state.botId) endCall(state.botId);
}

function busyText(call: LiveCallState): string {
  return t(`call.live.busy.${call.client}`);
}

/** Non-trickle ICE: OpenAI takes one offer, so gathering past `timeoutMs` sends the candidates found so far. */
function iceGathered(connection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }, timeoutMs);
    function onState() {
      if (connection.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }
    connection.addEventListener("icegatheringstatechange", onState);
  });
}
