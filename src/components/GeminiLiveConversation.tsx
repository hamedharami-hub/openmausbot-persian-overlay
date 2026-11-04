import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Radio, Square } from "lucide-react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { startCall } from "@/lib/call";
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

export function GeminiLiveConversation({
  botId,
  threadId,
  voiceId,
  className,
}: {
  botId?: string;
  threadId?: string;
  voiceId?: string;
  className?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    try { return localStorage.getItem("omb.geminiLiveVoice") || voiceId || "Kore"; } catch { return voiceId || "Kore"; }
  });
  const session = useRef<GeminiLiveSession | null>(null);
  const newTurnRef = useRef(true);

  useEffect(() => {
    if (voiceId && !localStorage.getItem("omb.geminiLiveVoice")) setSelectedVoice(voiceId);
  }, [voiceId]);

  const stop = useCallback(() => {
    session.current?.close();
    session.current = null;
    setSpeaking(false);
    setMuted(false);
    setPhase("idle");
  }, []);

  useEffect(() => () => { session.current?.close(); session.current = null; }, []);

  const start = useCallback((overrideVoice?: string) => {
    if (session.current) return;
    const useVoice = overrideVoice || selectedVoice || voiceId || "Kore";
    setCaption("");
    setHeard("");
    setSpeaking(false);
    setMuted(false);
    newTurnRef.current = true;
    setPhase("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    session.current = openGeminiLiveConversation({
      url: `${protocol}//${window.location.host}/api/gemini-live/conversation`,
      ...(threadId ? { threadId } : {}),
      voice: useVoice,
      onStateChange: (state) => {
        setPhase(state === "live" ? "live" : state === "connecting" ? "connecting" : state === "error" ? "error" : "idle");
        if (state === "closed" || state === "error") {
          session.current = null;
          setSpeaking(false);
        }
      },
      onEvent: (event: LiveEvent) => {
        if (event.kind === "audio") {
          setSpeaking(true);
        } else if (event.kind === "caption") {
          if (event.role === "user") {
            setHeard(event.text);
          } else {
            setSpeaking(true);
            setCaption((prev) => {
              if (newTurnRef.current || !prev) {
                newTurnRef.current = false;
                return event.text;
              }
              if (event.text.startsWith(prev)) return event.text;
              const sep = prev.endsWith(" ") || event.text.startsWith(" ") ? "" : " ";
              return `${prev}${sep}${event.text}`;
            });
          }
        } else if (event.kind === "turnComplete" || event.kind === "interrupted") {
          setSpeaking(false);
          newTurnRef.current = true;
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

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    session.current?.setMuted(next);
  };

  const interruptReply = () => {
    session.current?.interrupt();
    setSpeaking(false);
    newTurnRef.current = true;
  };

  const switchToFullScreenCall = () => {
    if (!botId) return;
    stop();
    startCall(botId);
  };

  const live = phase === "live" || phase === "connecting";
  const button = "flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors";
  return (
    <div className={cn("pointer-events-auto relative flex flex-col gap-1.5", className)}>
      {live && (
        <div role="status" className="absolute bottom-full end-0 z-20 mb-3 flex max-h-64 w-80 max-w-[88vw] flex-col gap-2 overflow-y-auto rounded-2xl border border-hairline/40 bg-panel px-3.5 py-3 text-[13px] text-ink shadow-xl" dir="auto">
          <div className="flex items-center justify-between gap-2 border-b border-hairline/30 pb-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <span className={cn("size-2 rounded-full", speaking ? "animate-pulse bg-accent" : muted ? "bg-warning" : "bg-success")} />
              <span className="text-ink-secondary">
                {phase === "connecting" ? "در حال اتصال..." : speaking ? "جمینای در حال صحبت..." : muted ? "میکروفون بی‌صدا" : "در حال گوش دادن..."}
              </span>
            </div>
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
          {heard && (
            <div className="rounded-lg bg-inset/60 px-2 py-1 text-[12px] text-ink-secondary">
              <span className="font-medium text-ink-tertiary">شما: </span>
              {heard}
            </div>
          )}
          <div className="min-h-[1.5rem] text-[13px] leading-relaxed">
            {caption || (speaking ? "..." : t("composer.geminiLive.waiting"))}
          </div>
          <div className="flex items-center justify-between gap-1.5 border-t border-hairline/30 pt-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleMute}
                title={muted ? "وصل میکروفون" : "بی‌صدا کردن میکروفون"}
                className={cn(
                  "flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
                  muted ? "bg-warning/15 text-warning" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink",
                )}
              >
                {muted ? <MicOff size={12} /> : <Mic size={12} />}
                <span>{muted ? "وصل میکروفون" : "میکروفون"}</span>
              </button>
              {speaking && (
                <button
                  type="button"
                  onClick={interruptReply}
                  title="قطع صدای فعلی جمینای"
                  className="flex items-center gap-1 rounded-lg bg-inset px-2 py-1 text-[11px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <Square size={11} className="fill-current" />
                  <span>قطع پاسخ</span>
                </button>
              )}
            </div>
            {botId && (
              <button
                type="button"
                onClick={switchToFullScreenCall}
                title="تماس تمام‌صفحه نوبتی با بات (Turn-based Call)"
                className="flex items-center gap-1 rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
              >
                <Phone size={11} />
                <span>تماس نوبتی</span>
              </button>
            )}
          </div>
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
