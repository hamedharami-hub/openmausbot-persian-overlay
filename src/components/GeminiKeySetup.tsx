import { useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

export function GeminiKeySetup({ onSaved, compact = false }: { onSaved?: () => void; compact?: boolean }) {
  const { dispatch } = useStore();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify({ gemini: { apiKey: value } }) });
      dispatch({ type: "configStatus", config: status });
      setKey("");
      onSaved?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className={`flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel text-left ${compact ? "p-3" : "p-4"}`}>
      <div className="text-[13.5px] font-medium text-ink">{t("voice.gemini.keyTitle")}</div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder={t("voice.gemini.keyPlaceholder")}
        aria-label={t("voice.gemini.keyTitle")}
        className="rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/60"
      />
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <button type="submit" disabled={!key.trim() || saving} className="ui-button ui-button-primary self-start">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        {saving ? t("call.live.keySaving") : t("common.save")}
      </button>
      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-[12px] text-accent hover:underline">
        {t("voice.gemini.getKey")}
      </a>
      <p className="text-[11px] leading-[1.45] text-ink-tertiary">{t("voice.gemini.freePrivacy")}</p>
    </form>
  );
}
