import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";

export type DictationLanguage = "auto" | "fa" | "en";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MS = 120_000;

export function useBrowserDictation({ draftId, text, onText, enabled }: {
  draftId: string; text: string; onText: (text: string) => void; enabled: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [language, setLanguage] = useState<DictationLanguage>("auto");
  const current = useRef({ draftId, text, onText });
  current.current = { draftId, text, onText };
  const generation = useRef(0);
  const originDraft = useRef<{ draftId: string; text: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const release = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    originDraft.current = null;
    request.current?.abort(); request.current = null;
    const active = recorder.current;
    if (active && active.state !== "inactive") active.stop();
    release();
    setRecording(false); setTranscribing(false);
  }, [release]);

  useEffect(() => {
    if (!enabled || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
    const controller = new AbortController();
    fetch("/api/gemini-voice/status", { signal: controller.signal, credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : null)
      .then((s) => { if (!controller.signal.aborted) setAvailable(Boolean(s?.configured)); })
      .catch(() => {});
    return () => { controller.abort(); setAvailable(false); };
  }, [enabled]);

  useEffect(() => () => stop(), [draftId, stop]);

  useEffect(() => {
    const origin = originDraft.current;
    if (origin && (draftId !== origin.draftId || text !== origin.text)) stop();
  }, [draftId, text, stop]);

  const toggle = async () => {
    if (transcribing || (recording && !recorder.current)) { stop(); return; }
    if (recorder.current) {
      if (recorder.current.state !== "inactive") recorder.current.stop();
      return;
    }
    if (!available) return;
    const token = ++generation.current;
    const origin = { ...current.current };
    originDraft.current = origin;
    const selectedLanguage = language;
    const active = () => generation.current === token && current.current.draftId === origin.draftId && current.current.text === origin.text;
    setSpeechError(null); setRecording(true);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!active()) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((mime) => MediaRecorder.isTypeSupported(mime));
      const capture = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      const chunks: Blob[] = [];
      let size = 0;
      capture.ondataavailable = (event) => {
        if (!active() || !event.data.size) return;
        size += event.data.size;
        if (size > MAX_BYTES) { stop(); setSpeechError(t("composer.cloudVoice.tooLarge")); return; }
        chunks.push(event.data);
      };
      capture.onerror = () => { if (active()) { stop(); setSpeechError(t("composer.cloudVoice.failed")); } };
      capture.onstop = async () => {
        const mime = capture.mimeType || chunks[0]?.type || "audio/webm";
        if (generation.current !== token || recorder.current !== capture) return;
        release();
        setRecording(false);
        if (!active()) return;
        if (!size) { originDraft.current = null; setSpeechError(t("composer.cloudVoice.empty")); return; }
        setTranscribing(true);
        const controller = new AbortController();
        request.current = controller;
        try {
          const response = await fetch(`/api/gemini-voice/transcribe?language=${selectedLanguage}`, {
            method: "POST", credentials: "same-origin", headers: { "content-type": mime },
            body: new Blob(chunks, { type: mime }), signal: controller.signal,
          });
          if (!response.ok) throw new Error("transcription failed");
          const result = await response.json();
          if (!active()) return;
          if (typeof result.text !== "string" || !result.text.trim()) { setSpeechError(t("composer.cloudVoice.empty")); return; }
          const transcript = result.text.trim();
          originDraft.current = null;
          current.current.onText(origin.text ? `${origin.text}${/\s$/.test(origin.text) ? "" : " "}${transcript}` : transcript);
        } catch {
          if (active() && !controller.signal.aborted) setSpeechError(t("composer.cloudVoice.failed"));
        } finally {
          if (generation.current === token) { originDraft.current = null; request.current = null; setTranscribing(false); }
        }
      };
      capture.start(1000);
      timer.current = setTimeout(() => { if (generation.current === token && capture.state !== "inactive") capture.stop(); }, MAX_MS);
    } catch {
      if (generation.current === token) { originDraft.current = null; release(); setRecording(false); setSpeechError(t("composer.cloudVoice.permission")); }
    }
  };

  return { available, recording, transcribing, speechError, language, setLanguage, toggle, stop };
}
