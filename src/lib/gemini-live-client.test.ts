// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { downsampleTo16k, floatToPcm16, floatToPcm16Value, openGeminiLiveConversation } from "./gemini-live-client";

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: Array<string | Uint8Array> = [];
  listeners = new Map<string, ((event: unknown) => void)[]>();
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(public url: string) {}
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({}); }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open() { this.onopen?.({}); this.emit("open", {}); }
}

describe("live conversation audio", () => {
  it("converts float samples to signed 16-bit PCM", () => {
    expect(floatToPcm16Value(0)).toBe(0);
    expect(floatToPcm16Value(1)).toBe(32767);
    expect(floatToPcm16Value(-1)).toBe(-32767);
    expect(floatToPcm16Value(2)).toBe(32767);
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1])))).toEqual([0, 32767, -32767]);
  });

  it("downsamples 48 kHz capture to 16 kHz mono by averaging each group", () => {
    const source = new Float32Array(480);
    source.fill(1);
    const out = downsampleTo16k(source, 48000);
    expect(out.length).toBe(160);
    expect(out[0]).toBe(32767);
    const mixed = new Float32Array(480);
    for (let i = 0; i < mixed.length; i++) mixed[i] = i % 2 === 0 ? 1 : 0;
    expect(downsampleTo16k(mixed, 48000)[0]).toBe(Math.round((2 / 3) * 32767));
  });

  it("keeps 16 kHz input unchanged", () => {
    const source = new Float32Array([0.5, -0.5]);
    expect(Array.from(downsampleTo16k(source, 16000))).toEqual([16384, -16383]);
  });

  it("sends the thread with the connection and forwards captions", () => {
    const socket = new FakeSocket("ws://host/api/gemini-live/conversation");
    const events: unknown[] = [];
    const states: string[] = [];
    const session = openGeminiLiveConversation({
      url: "ws://host/api/gemini-live/conversation",
      threadId: "thread one",
      createSocket: (url) => { socket.url = url; return socket as unknown as WebSocket; },
      onEvent: (event) => events.push(event),
      onStateChange: (state) => states.push(state),
    });
    socket.open();
    expect(socket.url).toContain("threadId=thread%20one");
    socket.emit("message", { data: JSON.stringify({ kind: "caption", text: "سلام", role: "assistant" }) });
    expect(events).toEqual([{ kind: "caption", text: "سلام", role: "assistant" }]);
    session.send("hello");
    expect(socket.sent).toContain(JSON.stringify({ type: "text", text: "hello" }));
    session.close();
    expect(states.at(-1)).toBe("closed");
  });

  it("queues audio chunks end-to-end and cancels the queue on interruption and close", () => {
    const socket = new FakeSocket("ws://host/live");
    const nodes: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const context = {
      currentTime: 10, destination: {}, resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
      createBuffer: vi.fn((_channels: number, count: number, rate: number) => ({ duration: count / rate, copyToChannel: vi.fn() })),
      createBufferSource: vi.fn(() => {
        const node = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), onended: null, buffer: null };
        nodes.push(node); return node;
      }),
    };
    const session = openGeminiLiveConversation({ url: "ws://host/live", createSocket: () => socket as unknown as WebSocket,
      audioContext: context as unknown as AudioContext, onEvent: () => {} });
    const audio = JSON.stringify({ kind: "audio", data: btoa(String.fromCharCode(...new Uint8Array(4800))), mimeType: "audio/pcm;rate=24000" });
    socket.emit("message", { data: audio });
    socket.emit("message", { data: audio });
    expect(nodes[0]!.start).toHaveBeenCalledWith(10.02);
    expect(nodes[1]!.start.mock.calls[0]![0]).toBeCloseTo(10.12);
    socket.emit("message", { data: JSON.stringify({ kind: "interrupted" }) });
    expect(nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
    socket.emit("message", { data: audio });
    expect(nodes[2]!.start).toHaveBeenCalledWith(10.02);
    session.close();
    expect(nodes[2]!.stop).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
    socket.emit("message", { data: audio });
    expect(nodes).toHaveLength(3);
  });

  it("stops a microphone granted after the call was closed", async () => {
    const socket = new FakeSocket("ws://host/live");
    const stop = vi.fn();
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const session = openGeminiLiveConversation({ url: "ws://host/live", createSocket: () => socket as unknown as WebSocket,
      media: { getUserMedia } as unknown as MediaDevices, onEvent: () => {} });
    socket.open();
    await Promise.resolve();
    session.close();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("never puts a credential into what the browser sends", () => {
    const socket = new FakeSocket("ws://host/api/gemini-live/conversation");
    const session = openGeminiLiveConversation({
      url: "ws://host/api/gemini-live/conversation",
      createSocket: () => socket as unknown as WebSocket,
      onEvent: () => {},
    });
    socket.open();
    session.send("hello");
    expect(JSON.stringify(socket.sent)).not.toMatch(/sk-|key=/);
    expect(JSON.stringify(socket.sent)).toContain("hello");
    session.close();
  });
});
