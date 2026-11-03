import { useCallback, useEffect, useRef, useState } from "react";
import { PhoneOff, Radio } from "lucide-react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { openGeminiLiveConversation, type GeminiLiveSession } from "@/lib/gemini-live-client";
import type { LiveEvent } from "../../server/gemini-live";

type Phase = "idle" | "connecting" | "live" | "error";

export function GeminiLiveConversation({ threadId, className }: { threadId?: string; className?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const session = useRef<GeminiLiveSession | null>(null);

  const stop = useCallback(() => {
    session.current?.close();
    session.current = null;
    setPhase("idle");
  }, []);

  useEffect(() => () => { session.current?.close(); session.current = null; }, []);

  const start = useCallback(() => {
    if (session.current) return;
    setCaption(""); setHeard(""); setPhase("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    session.current = openGeminiLiveConversation({
      url: `${protocol}//${window.location.host}/api/gemini-live/conversation`,
      ...(threadId ? { threadId } : {}),
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
  }, [threadId]);

  const live = phase === "live" || phase === "connecting";
  const button = "flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors";
  return (
    <div className={cn("pointer-events-auto relative flex flex-col gap-1.5", className)}>
      {live && (
        <div role="status" className="absolute bottom-full end-0 z-20 mb-3 flex max-h-40 w-64 max-w-[75vw] flex-col gap-1 overflow-y-auto rounded-xl bg-panel px-3 py-2 text-[13px] text-ink shadow-lg" dir="auto">
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
          <button type="button" onClick={start} aria-label={t("composer.geminiLive.start")} className={cn(button, "text-ink-secondary hover:bg-raised hover:text-ink")}>
            {phase === "error" ? <Radio size={14} className="text-danger" /> : <Radio size={14} />}
            <span className="@max-[30rem]/composer:hidden">{t("composer.geminiLive.start")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
