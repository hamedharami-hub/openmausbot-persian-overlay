import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { ResearchRequest } from "../../shared/research-request";

export function ResearchRequestBar({ value, onChange }: { value: ResearchRequest; onChange(value: ResearchRequest | null): void }) {
  return <div data-research-request className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-accent/5 px-3 py-2 text-xs text-ink" dir="auto">
    <span className="font-medium">{t(`research.mode.${value.mode}`)}</span>
    <label className="flex items-center gap-1">{t("research.depth")}
      <select aria-label={t("research.depth")} value={value.depth} className="rounded-lg bg-inset px-1 py-1" onChange={(event) => onChange({ ...value, depth: event.target.value as ResearchRequest["depth"] })}>
        <option value="standard">{t("research.depth.standard")}</option><option value="deep">{t("research.depth.deep")}</option>
      </select>
    </label>
    <label className="flex items-center gap-1">{t("research.length")}
      <select aria-label={t("research.length")} value={value.length} className="rounded-lg bg-inset px-1 py-1" onChange={(event) => onChange({ ...value, length: event.target.value as ResearchRequest["length"] })}>
        <option value="short">{t("research.length.short")}</option><option value="normal">{t("research.length.normal")}</option><option value="long">{t("research.length.long")}</option>
      </select>
    </label>
    <button type="button" onClick={() => onChange(null)} aria-label={t("research.clear")} className="ms-auto rounded p-1 hover:bg-ink/5"><X size={14} /></button>
    <span className="basis-full text-ink-secondary">{t("research.scope")}</span>
  </div>;
}
