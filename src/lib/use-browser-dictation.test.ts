// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBrowserDictation } from "./use-browser-dictation";

let hook: ReturnType<typeof useBrowserDictation>;
let root: Root;
let container: HTMLDivElement;
let text = "draft";
let draftId = "one";
const onText = vi.fn();
const trackStop = vi.fn();
const media = { getTracks: () => [{ stop: trackStop }] };
class Recorder {
  static instance: Recorder;
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Recorder.instance = this; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["fake-audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
}
function Harness() { hook = useBrowserDictation({ draftId, text, onText, enabled: true }); return null; }
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(() => {}); }
function render() { flushSync(() => root.render(createElement(Harness))); }

beforeEach(async () => {
  text = "draft"; draftId = "one"; onText.mockReset(); trackStop.mockReset();
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(media) } });
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith("status") ? { configured: true } : { text: "سلام hello" }), { headers: { "content-type": "application/json" } }))));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  render(); await settle();
});
afterEach(() => {
  try {
    flushSync(() => root.unmount());
    container.remove();
    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(/^\/api\/gemini-voice\/(status|transcribe\?language=(auto|fa|en))$/);
    }
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("records then inserts text into the draft, never sends a message", async () => {
  expect(hook.available).toBe(true);
  onText.mockImplementation((next: string) => { text = next; render(); });
  await hook.toggle(); await settle(); expect(hook.recording).toBe(true);
  await hook.toggle(); await settle();
  expect(onText).toHaveBeenCalledWith("draft سلام hello");
  expect(trackStop).toHaveBeenCalled();
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls[1][0]).toContain("/transcribe?language=auto");
  expect(calls.every(([url]) => !String(url).includes("messages"))).toBe(true);
  expect((calls[1][1]!.signal as AbortSignal).aborted).toBe(false);
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
});

it("cancel releases tracks without uploading or changing text", async () => {
  await hook.toggle(); await settle(); hook.stop(); await settle();
  expect(trackStop).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it.each(["edit", "edit then restore", "thread change", "cancel"])("ignores late transcription after %s", async (change) => {
  let done!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  expect(hook.transcribing).toBe(true);
  const signal = vi.mocked(fetch).mock.calls[1][1]?.signal as AbortSignal;
  if (change === "cancel") hook.stop();
  else if (change === "thread change") { draftId = "two"; render(); }
  else {
    text = "manually edited"; render();
    if (change === "edit then restore") { text = "draft"; render(); }
  }
  await settle();
  expect(signal.aborted).toBe(true);
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  done(new Response(JSON.stringify({ text: "late result" })));
  await settle();
  expect(onText).not.toHaveBeenCalled();
  expect(hook.speechError).toBeNull();
});

it.each(["cancel", "thread change", "draft edit"])("releases pending microphone permission after %s", async (change) => {
  let allow!: (value: MediaStream | PromiseLike<MediaStream>) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise<MediaStream>((resolve) => { allow = resolve; }));
  const starting = hook.toggle(); await settle();
  expect(hook.recording).toBe(true);
  if (change === "cancel") await hook.toggle();
  else if (change === "thread change") { draftId = "two"; render(); }
  else { text = "edited"; render(); }
  await settle();
  expect(hook.recording).toBe(false);
  allow(media as unknown as MediaStream); await starting; await settle();
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(hook.transcribing).toBe(false);
});

it("supports English selection and empty results without erasing the draft", async () => {
  flushSync(() => hook.setLanguage("en"));
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ text: "" })));
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  expect(vi.mocked(fetch).mock.calls[1][0]).toContain("language=en");
  expect(onText).not.toHaveBeenCalled(); expect(hook.speechError).toBeTruthy();
  expect(hook.recording).toBe(false); expect(hook.transcribing).toBe(false);
});

it("stops recording on programmatic draft edits even if the text is restored", async () => {
  await hook.toggle(); await settle();
  const capture = Recorder.instance;
  text = "edited elsewhere"; render(); await settle();
  expect(capture.state).toBe("inactive");
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  text = "draft"; render();
  capture.onstop?.(); await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it("finishes recording at the maximum duration", async () => {
  vi.useFakeTimers();
  await hook.toggle(); render();
  expect(hook.recording).toBe(true);
  await vi.advanceTimersByTimeAsync(120_000); render();
  expect(Recorder.instance.state).toBe("inactive");
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(onText).toHaveBeenCalledWith("draft سلام hello");
});

it("does not let a stale onstop release a newer recording stream", async () => {
  await hook.toggle(); await settle();
  const oldCapture = Recorder.instance;
  const lateStop = oldCapture.onstop;
  oldCapture.onstop = null;
  hook.stop(); await settle();
  const newerTrackStop = vi.fn();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce({ getTracks: () => [{ stop: newerTrackStop }] } as unknown as MediaStream);
  await hook.toggle(); await settle();
  lateStop?.(); await settle();
  expect(Recorder.instance.state).toBe("recording");
  expect(hook.recording).toBe(true);
  expect(newerTrackStop).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
  hook.stop(); await settle();
  expect(newerTrackStop).toHaveBeenCalledTimes(1);
});

it("releases late permission without touching a newer recording", async () => {
  let allow!: (value: MediaStream | PromiseLike<MediaStream>) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise<MediaStream>((resolve) => { allow = resolve; }));
  const starting = hook.toggle(); await settle();
  hook.stop(); await settle();
  await hook.toggle(); await settle();
  const cancelledTrackStop = vi.fn();
  allow({ getTracks: () => [{ stop: cancelledTrackStop }] } as unknown as MediaStream);
  await starting; await settle();
  expect(cancelledTrackStop).toHaveBeenCalledTimes(1);
  expect(trackStop).not.toHaveBeenCalled();
  expect(hook.recording).toBe(true);
  expect(Recorder.instance.state).toBe("recording");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it("does not let a late result clear a newer transcription", async () => {
  let oldDone!: (response: Response) => void;
  let newDone!: (response: Response) => void;
  vi.mocked(fetch)
    .mockImplementationOnce(() => new Promise((resolve) => { oldDone = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { newDone = resolve; }));
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  hook.stop(); await settle();
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  oldDone(new Response(JSON.stringify({ text: "stale" }))); await settle();
  expect(onText).not.toHaveBeenCalled();
  expect(hook.transcribing).toBe(true);
  expect((vi.mocked(fetch).mock.calls[2][1]!.signal as AbortSignal).aborted).toBe(false);
  newDone(new Response(JSON.stringify({ text: "current" }))); await settle();
  expect(onText).toHaveBeenCalledExactlyOnceWith("draft current");
  expect(hook.transcribing).toBe(false);
});

it("reports denied permission without uploading or changing the draft", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new Error("denied"));
  await hook.toggle(); await settle();
  expect(hook.speechError).toBeTruthy();
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it("ignores late permission denial after cancel", async () => {
  let deny!: (reason: Error) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(new Promise<MediaStream>((_resolve, reject) => { deny = reject; }));
  const starting = hook.toggle(); await settle();
  hook.stop(); await settle();
  deny(new Error("denied")); await starting; await settle();
  expect(hook.speechError).toBeNull();
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it("reports empty audio without uploading or changing the draft", async () => {
  vi.spyOn(Recorder.prototype, "stop").mockImplementation(function (this: Recorder) {
    this.state = "inactive";
    this.onstop?.();
  });
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(hook.speechError).toBeTruthy();
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it.each(["network", "http", "invalid JSON"])("reports %s transcription failure without changing the draft", async (failure) => {
  if (failure === "network") vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  else if (failure === "http") vi.mocked(fetch).mockResolvedValueOnce(new Response("failed", { status: 500 }));
  else vi.mocked(fetch).mockResolvedValueOnce(new Response("not JSON"));
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(hook.speechError).toBeTruthy();
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(onText).not.toHaveBeenCalled();
});

it("reports recorder failure without uploading or changing the draft", async () => {
  await hook.toggle(); await settle();
  Recorder.instance.onerror?.(); await settle();
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(hook.speechError).toBeTruthy();
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onText).not.toHaveBeenCalled();
});

it("ignores a late failed transcription after cancel", async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await hook.toggle(); await settle(); await hook.toggle(); await settle();
  hook.stop(); await settle();
  fail(new Error("late failure")); await settle();
  expect(hook.speechError).toBeNull();
  expect(hook.recording).toBe(false);
  expect(hook.transcribing).toBe(false);
  expect(onText).not.toHaveBeenCalled();
});
