import { useCallback, useEffect, useRef, useState } from "react";
import { PhoneOff, Radio } from "lucide-react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { openGeminiLiveConversation, type GeminiLiveSession } from "@/lib/gemini-live-client";
import type { LiveEvent } from "../../server/gemini-live";

type Phase = "idle" | "connecting" | "live" | "error";

const LIVE_VOICES = [
  { id: "Kore", label: "Kore · کوره (زن · شفاف)" },
  { id: "Aoede", label: "Aoede · آئوده (زن · صمیمی)" },
  { id: "Puck", label: "Puck · پاک (مرد · پرانرژی)" },
  { id: "Charon", label: "Charon · کارون (مرد · بم)" },
  { id: "Fenrir", label: "Fenrir · فنریر (مرد · پرقدرت)" },
  { id: "Zephyr", label: "Zephyr · زفیر (زن · روشن)" },
  { id: "Leda", label: "Leda · لدا (زن · شاداب)" },
  { id: "Orus", label: "Orus · اوروس (مرد · قاطع)" },
];

export function GeminiLiveConversation({ threadId, voiceId, className }: { threadId?: string; voiceId?: string; className?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    try { return localStorage.getItem("omb.geminiLiveVoice") || voiceId || "Kore"; } catch { return voiceId || "Kore"; }
  });
  const session = useRef<GeminiLiveSession | null>(null);

  useEffect(() => {
    if (voiceId && !localStorage.getItem("omb.geminiLiveVoice")) setSelectedVoice(voiceId);
  }, [voiceId]);

  const stop = useCallback(() => {
    session.current?.close();
    session.current = null;
    setPhase("idle");
  }, []);

  useEffect(() => () => { session.current?.close(); session.current = null; }, []);

  const start = useCallback((overrideVoice?: string) => {
    if (session.current) return;
    const useVoice = overrideVoice || selectedVoice || voiceId || "Kore";
    setCaption(""); setHeard(""); setPhase("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    session.current = openGeminiLiveConversation({
      url: `${protocol}//${window.location.host}/api/gemini-live/conversation`,
      ...(threadId ? { threadId } : {}),
      voice: useVoice,
      onStateChange: (state) => {
        setPhase(state === "live" ? "live" : state === "connecting" ? "connecting" : state === "error" ? "error" : "idle");
        if (state === "closed" || state === "error") session.current = null;
      },
      onEvent: (event: LiveEvent) => {
        if (event.kind === "caption") {
          if (event.role === "user") setHeard(event.text);
          else setCaption(event.text);
        }
      },
    });
  }, [threadId, selectedVoice, voiceId]);

  const changeVoice = (next: string) => {
    setSelectedVoice(next);
    try { localStorage.setItem("omb.geminiLiveVoice", next); } catch { /* ignore */ }
    if (session.current) {
      stop();
      setTimeout(() => start(next), 80);
    }
  };

  const live = phase === "live" || phase === "connecting";
  const button = "flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors";
  return (
    <div className={cn("pointer-events-auto relative flex flex-col gap-1.5", className)}>
      {live && (
        <div role="status" className="absolute bottom-full end-0 z-20 mb-3 flex max-h-52 w-72 max-w-[85vw] flex-col gap-1.5 overflow-y-auto rounded-xl border border-hairline/40 bg-panel px-3 py-2.5 text-[13px] text-ink shadow-lg" dir="auto">
          <div className="flex items-center justify-between gap-2 border-b border-hairline/30 pb-1.5">
            <span className="text-[11px] font-medium text-ink-secondary">صدای مکالمه:</span>
            <select
              value={selectedVoice}
              onChange={(e) => changeVoice(e.target.value)}
              aria-label="Gemini Live Voice"
              className="rounded-md border border-hairline/50 bg-inset px-1.5 py-0.5 text-[11px] text-ink focus:outline-none"
            >
              {LIVE_VOICES.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>
          {heard && <div className="text-ink-secondary">{heard}</div>}
          <div>{caption || t("composer.geminiLive.waiting")}</div>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {live ? (
          <button type="button" onClick={stop} aria-label={t("composer.geminiLive.stop")} className={cn(button, "bg-danger/15 text-danger hover:bg-danger/25")}>
            <PhoneOff size={14} /> <span className="@max-[30rem]/composer:hidden">{t("composer.geminiLive.stop")}</span>
          </button>
        ) : (
          <button type="button" onClick={() => start()} aria-label={t("composer.geminiLive.start")} className={cn(button, "text-ink-secondary hover:bg-raised hover:text-ink")}>
            {phase === "error" ? <Radio size={14} className="text-danger" /> : <Radio size={14} />}
            <span className="@max-[30rem]/composer:hidden">{t("composer.geminiLive.start")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
