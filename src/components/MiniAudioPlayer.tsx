import { useState } from "react";
import { Download, Loader2, Pause, Play, RotateCcw, RotateCw, Square, Volume2 } from "lucide-react";

import { GEMINI_TTS_QUALITY_OPTIONS, speaker } from "@/lib/tts";
import { useSpeech, useSpeechPlayback } from "@/lib/tts/useSpeech";
import { cn } from "@/lib/cn";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function MiniAudioPlayer({ className }: { className?: string }) {
  const speech = useSpeech();
  const playback = useSpeechPlayback();
  const [downloading, setDownloading] = useState(false);

  if (speech.status === "idle") return null;

  const isPreparing = speech.status === "preparing";
  const paused = playback.paused;
  const duration = playback.duration > 0 ? playback.duration : 0;
  const current = Math.min(duration || playback.currentTime, playback.currentTime);

  const cycleSpeed = () => {
    const idx = SPEEDS.findIndex((s) => Math.abs(s - playback.rate) < 0.05);
    const next = SPEEDS[(idx + 1) % SPEEDS.length] ?? 1;
    speaker.setRate(next);
  };

  const handleDownload = async () => {
    if (downloading || !playback.canDownload) return;
    setDownloading(true);
    try {
      await speaker.downloadCurrentAudio("openmausbot-audio");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Audio player"
      data-mini-audio-player=""
      dir="ltr"
      className={cn(
        "pointer-events-auto mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-accent/30 bg-panel/95 px-3 py-2 text-[12px] text-ink shadow-lg backdrop-blur-md",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <Volume2 size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <button
          type="button"
          onClick={() => speaker.skip(-5)}
          disabled={isPreparing}
          title="5 ثانیه به عقب (-5s)"
          aria-label="Rewind 5 seconds"
          className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <RotateCcw size={13} />
        </button>

        <button
          type="button"
          onClick={() => (isPreparing ? speaker.stop() : speaker.togglePause())}
          title={isPreparing ? "در حال آماده‌سازی..." : paused ? "ادامه پخش (Play)" : "توقف موقت (Pause)"}
          aria-label={paused ? "Play" : "Pause"}
          className="flex size-7 items-center justify-center rounded-full bg-accent text-accent-ink transition-transform hover:brightness-110 active:scale-95"
        >
          {isPreparing ? (
            <Loader2 size={13} className="animate-spin" />
          ) : paused ? (
            <Play size={13} className="fill-current ml-0.5" />
          ) : (
            <Pause size={13} className="fill-current" />
          )}
        </button>

        <button
          type="button"
          onClick={() => speaker.skip(5)}
          disabled={isPreparing}
          title="5 ثانیه به جلو (+5s)"
          aria-label="Forward 5 seconds"
          className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <RotateCw size={13} />
        </button>

        <button
          type="button"
          onClick={() => speaker.stop()}
          title="توقف کامل و بستن (Stop)"
          aria-label="Stop audio"
          className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-danger/15 hover:text-danger"
        >
          <Square size={12} className="fill-current" />
        </button>
      </div>

      {playback.totalBlocks <= 1 && (
        <div className="flex min-w-[140px] flex-1 items-center gap-2">
          <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-secondary">
            {formatClock(current)}
          </span>
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 1}
            step={0.1}
            value={duration > 0 ? current : 0}
            disabled={isPreparing || duration <= 0}
            onChange={(e) => speaker.seek(Number(e.target.value))}
            aria-label="Seek audio position"
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-inset accent-accent disabled:cursor-default disabled:opacity-50"
          />
          <span className="w-8 shrink-0 font-mono text-[11px] tabular-nums text-ink-secondary">
            {formatClock(duration)}
          </span>
        </div>
      )}

      <div className="flex items-center gap-1">
        <select
          value={playback.ttsModel || "auto"}
          onChange={(e) => speaker.setTtsModel(e.target.value)}
          title="کیفیت و مدل خوانش گوگل (Gemini TTS Quality)"
          aria-label="TTS quality model"
          data-mini-tts-quality=""
          className="max-w-[115px] truncate rounded-lg border border-hairline/50 bg-inset px-1.5 py-1 text-[10px] font-medium text-ink focus:outline-none hover:bg-raised"
        >
          {GEMINI_TTS_QUALITY_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.badge} · {opt.id === "auto" ? "خودکار" : opt.id.replace("gemini-", "").replace("-preview", "")}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={cycleSpeed}
          title="تغییر سرعت پخش (Speed)"
          aria-label="Playback speed"
          className="rounded-lg border border-hairline/50 bg-inset px-2 py-1 font-mono text-[11px] font-medium tabular-nums text-ink hover:bg-raised"
        >
          {playback.rate}x
        </button>

        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={!playback.canDownload || downloading}
          title="دانلود فایل صوتی روی دستگاه (Download Audio)"
          aria-label="Download audio"
          className="flex size-7 items-center justify-center rounded-full bg-inset text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        </button>
      </div>
    </div>
  );
}
