import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PhoneOff, Radio } from "lucide-react";

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
  const button = "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors";
  return (
    <div className={cn("pointer-events-auto flex flex-col gap-1.5", className)}>
      {live && (
        <div className="mx-5 mb-1 flex flex-col gap-1 rounded-xl border bg-panel px-3 py-2 text-[13px] text-ink" dir="auto">
          {heard && <div className="text-ink-secondary">{heard}</div>}
          <div>{caption || t("composer.geminiLive.waiting")}</div>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {live ? (
          <button type="button" onClick={stop} aria-label={t("composer.geminiLive.stop")} className={cn(button, "bg-danger/15 text-danger hover:bg-danger/25")}>
            <PhoneOff size={14} /> {t("composer.geminiLive.stop")}
          </button>
        ) : (
          <button type="button" onClick={start} aria-label={t("composer.geminiLive.start")} className={cn(button, "text-ink-secondary hover:bg-raised hover:text-ink")}>
            {phase === "connecting" ? <Loader2 size={14} className="animate-spin" /> : <Radio size={14} />}
            {t("composer.geminiLive.start")}
          </button>
        )}
      </div>
    </div>
  );
}
