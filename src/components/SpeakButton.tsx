import { useState } from "react";
import { Download, Loader2, Pause, Play, Square, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import type { ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ACTION_ICON } from "@/components/MessageActions";

type SpeakArgs = {
  text: string;
  botId?: string;
  messageId: string;
  voiceId?: string;
  tts: ConfigStatus["tts"];
  localVoice: boolean;
};

export function useSpeakAction({ text, botId, messageId, voiceId, tts, localVoice }: SpeakArgs) {
  const speech = useSpeech();
  const configured = localVoice || Boolean(tts?.configured);
  const ready = localVoice || (configured && Boolean(voiceId || tts?.voice));
  const mine = speech.messageId === messageId && speech.status !== "idle";
  const preparing = mine && speech.status === "preparing";
  const paused = mine && speech.status === "paused";
  const playbackRate = speech.playbackRate ?? 1;
  const label = !configured
    ? t((tts?.provider ?? "gemini") === "elevenlabs" ? "chat.speak.needsKey" : "chat.speak.needsSetup")
    : !ready
      ? t("chat.speak.needsVoice")
      : preparing
        ? t("chat.speak.stop")
        : paused
          ? t("chat.speak.resume")
          : mine
            ? t("chat.speak.pause")
            : t("chat.speak.read");
  const toggle = () => {
    if (mine) return preparing ? speaker.stop() : speaker.pauseOrResume();
    void speaker.speak(text, { botId, messageId, voiceId });
  };
  return { configured, ready, mine, preparing, paused, playbackRate, label, toggle };
}

export function SpeakButton({ className, ...args }: SpeakArgs & { className?: string }) {
  const { text, voiceId, tts, localVoice } = args;
  const { configured, ready, mine, preparing, paused, playbackRate, label, toggle } = useSpeakAction(args);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadable = !localVoice && tts?.provider === "gemini" && configured && ready;
  const download = async () => {
    if (!downloadable || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch("/api/tts/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voiceId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Audio download failed (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "openmausbot-speech.wav";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        onClick={toggle}
        disabled={!ready}
        aria-label={label}
        title={label}
        className={cn(
          "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
          mine ? "text-accent opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
          className,
        )}
      >
        {preparing ? <Loader2 {...ACTION_ICON} className="animate-spin" /> : paused ? <Play {...ACTION_ICON} /> : mine ? <Pause {...ACTION_ICON} /> : <Volume2 {...ACTION_ICON} />}
      </button>
      {mine && !preparing && <>
        <button type="button" onClick={() => speaker.stop()} aria-label={t("chat.speak.stop")} title={t("chat.speak.stop")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
          <Square {...ACTION_ICON} className="fill-current" />
        </button>
        <button type="button" onClick={() => speaker.cyclePlaybackRate()} aria-label={t("chat.speak.speed", { rate: playbackRate })} title={t("chat.speak.speed", { rate: playbackRate })} className="rounded-md px-1.5 py-1 text-[10px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink">
          {playbackRate}×
        </button>
      </>}
      {downloadable && <button type="button" onClick={() => void download()} disabled={downloading} aria-label={t("chat.speak.download")} title={t("chat.speak.download")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50">
        {downloading ? <Loader2 {...ACTION_ICON} className="animate-spin" /> : <Download {...ACTION_ICON} />}
      </button>}
      {downloadError && <span role="status" className="ms-1 max-w-48 truncate text-[10px] text-danger">{downloadError}</span>}
    </span>
  );
}
