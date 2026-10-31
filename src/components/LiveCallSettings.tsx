import { useCallback, useId, useState } from "react";

import { LIVE_VOICE_OPTIONS } from "../../shared/live-call";
import { t } from "@/lib/i18n";
import { liveDisclosure } from "@/lib/call-mode";
import { api, useStore, type ConfigStatus } from "@/state/store";
import type { LiveSettings } from "../../shared/wire";
import { LiveKeySetup } from "./LiveKeySetup";
import { KeysLink } from "./keys/KeysLink";
import { GeminiKeySetup } from "./GeminiKeySetup";
import { Select } from "./Select";

const IDLE_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];

export function LiveCallSettings({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, provider: "openai", geminiConfigured: false, voice: "", geminiVoice: "Kore", readTypedReplies: true, idleMinutes: 5 };
  const [saving, setSaving] = useState(false);
  const [changingKey, setChangingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedHintId = useId();
  // Stable, so this callback ref runs once when the popover mounts, not on every save.
  const focusOnOpen = useCallback((dialog: HTMLDivElement | null) => {
    dialog?.querySelector<HTMLElement>("select, input, button")?.focus();
  }, []);
  const provider = live.provider ?? "openai";
  const geminiVoices = ["Kore", "Aoede", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus", "Callirrhoe", "Autonoe", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Rasalgethi", "Achernar", "Schedar", "Gacrux", "Achird", "Sulafat"];
  const voice = provider === "gemini" ? live.geminiVoice || "Kore" : live.voice || "marin";
  const known = provider === "gemini" ? geminiVoices.includes(voice) : LIVE_VOICE_OPTIONS.some((option) => option.id === voice);

  const save = async (patch: Partial<Pick<LiveSettings, "provider" | "voice" | "geminiVoice" | "readTypedReplies" | "idleMinutes">>) => {
    setSaving(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = provider === "gemini"
        ? await api("/api/config", { method: "PUT", body: JSON.stringify({ gemini: { apiKey: "" } }) })
        : window.ogb?.setCredential
          ? await window.ogb.setCredential("openaiLiveKey", "")
          : await api("/api/config", { method: "PUT", body: JSON.stringify({ live: { key: "" } }) });
      dispatch({ type: "configStatus", config: status });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={focusOnOpen}
      role="dialog"
      tabIndex={-1}
      aria-label={t("call.live.settings")}
      className="flex w-[300px] max-w-[90vw] flex-col gap-3 rounded-xl border border-hairline bg-panel p-3 text-[13px] text-ink shadow-lg"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.provider")}</span>
        <Select size="sm" value={provider} disabled={saving} onChange={(event) => void save({ provider: event.target.value as "openai" | "gemini" })}>
          <option value="openai">{t("call.live.provider.openai")}</option>
          <option value="gemini">{t("call.live.provider.gemini")}</option>
        </Select>
      </label>
      {provider === "gemini" && <div className="-mt-2 text-[11px] text-ink-tertiary">{t("call.live.gemini.sessionLimit")}</div>}
      <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.voice")}</span>
        <Select
          size="sm"
          value={voice}
          disabled={saving}
          onChange={(event) => void save(provider === "gemini" ? { geminiVoice: event.target.value } : { voice: event.target.value })}
        >
          {!known && <option value={voice}>{voice}</option>}
          {provider === "gemini"
            ? geminiVoices.map((name) => <option key={name} value={name}>{name}</option>)
            : LIVE_VOICE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </label>
      <div className="-mt-2 text-[12px] text-ink-tertiary">{t("call.live.voiceNext")}</div>
      {provider === "openai" && <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.readTyped")}</span>
        <input
          type="checkbox"
          checked={live.readTypedReplies}
          disabled={saving}
          aria-describedby={typedHintId}
          onChange={(event) => void save({ readTypedReplies: event.target.checked })}
        />
      </label>}
      {provider === "openai" && <div id={typedHintId} className="-mt-2 text-[12px] text-ink-tertiary">{t("call.live.readTypedHint")}</div>}
      {provider === "openai" && <label className="flex items-center justify-between gap-2">
        <span className="text-ink-secondary">{t("call.live.idle")}</span>
        <Select
          size="sm"
          value={live.idleMinutes}
          disabled={saving}
          onChange={(event) => void save({ idleMinutes: Number(event.target.value) })}
        >
          {[...new Set([...IDLE_CHOICES, live.idleMinutes])].sort((a, b) => a - b).map((minutes) => (
            <option key={minutes} value={minutes}>{minutes}</option>
          ))}
        </Select>
      </label>}
      <div className="flex items-center justify-between gap-2 border-t border-hairline/60 pt-2">
        <span className="text-ink-secondary">{provider === "gemini" ? t("voice.gemini.keyTitle") : t("call.live.key")}</span>
        <span className="flex gap-2">
          <button type="button" className="text-accent hover:underline" onClick={() => setChangingKey((open) => !open)}>
            {t("call.live.keyChange")}
          </button>
          {((provider === "openai" && live.keySource === "live") || (provider === "gemini" && live.geminiConfigured)) && (
            <button type="button" className="text-danger hover:underline" disabled={saving} onClick={() => void removeKey()}>
              {t("call.live.keyRemove")}
            </button>
          )}
        </span>
      </div>
      {provider === "openai" && live.keySource !== "live" && (
        <div className="-mt-2 text-[12px] text-ink-tertiary">{t(live.keySource === "openai" ? "call.live.keyFromApiKeys" : "call.live.needsKey")} <KeysLink id="openai" purpose="liveCalls" /></div>
      )}
      {provider === "gemini" && !live.geminiConfigured && <div className="-mt-2 text-[12px] text-ink-tertiary">{t("call.live.gemini.needsKey")}</div>}
      {changingKey && (provider === "gemini" ? <GeminiKeySetup compact onSaved={() => setChangingKey(false)} /> : <LiveKeySetup compact onSaved={() => setChangingKey(false)} />)}
      <div className="text-[12px] text-ink-tertiary">{provider === "gemini" ? `${liveDisclosure({ provider })} ${t("call.live.gemini.cost")}` : `${liveDisclosure({ cloudHome: state.config?.cloudHome === true })} ${t("call.live.cost")}`}</div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
