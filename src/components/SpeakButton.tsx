import { Loader2, Pause, Play, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech, useSpeechPlayback } from "@/lib/tts/useSpeech";
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
  const label = !configured
    ? t((tts?.provider ?? "elevenlabs") === "elevenlabs" ? "chat.speak.needsKey" : "chat.speak.needsSetup")
    : !ready
      ? t("chat.speak.needsVoice")
    : mine
      ? t("chat.speak.stop")
      : t("chat.speak.read");
  const toggle = () => {
    if (mine) return speaker.stop();
    void speaker.speak(text, { botId, messageId, voiceId });
  };
  return { ready, mine, preparing, label, toggle };
}

export function SpeakButton({ className, ...args }: SpeakArgs & { className?: string }) {
  const { ready, mine, preparing, label } = useSpeakAction(args);
  const playback = useSpeechPlayback();
  const paused = mine && playback.paused;
  const onClick = () => {
    if (preparing) return speaker.stop();
    if (mine) return speaker.togglePause();
    void speaker.speak(args.text, { botId: args.botId, messageId: args.messageId, voiceId: args.voiceId });
  };
  const buttonTitle = mine ? (paused ? "ادامه پخش صدا (Play)" : "توقف موقت صدا (Pause)") : label;
  return (
    <button
      onClick={onClick}
      disabled={!ready}
      aria-label={buttonTitle}
      title={buttonTitle}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
        mine ? "text-accent opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        className,
      )}
    >
      {preparing ? (
        <Loader2 {...ACTION_ICON} className="animate-spin" />
      ) : mine ? (
        paused ? <Play {...ACTION_ICON} className="fill-current" /> : <Pause {...ACTION_ICON} className="fill-current" />
      ) : (
        <Volume2 {...ACTION_ICON} />
      )}
    </button>
  );
}
