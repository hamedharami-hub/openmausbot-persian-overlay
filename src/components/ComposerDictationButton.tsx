import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { Mic } from "lucide-react";
import { t } from "@/lib/i18n";

type Language = "auto" | "fa" | "en";
const languages: { value: Language; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "fa", label: "فارسی" },
  { value: "en", label: "English" },
];

export function ComposerDictationButton({ language, onLanguage, cloud, transcribing, onClick, ...props }: {
  language: Language;
  onLanguage: (language: Language) => void;
  cloud: boolean;
  transcribing: boolean;
} & Pick<ComponentProps<"button">, "className" | "title" | "aria-label" | "onClick">) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const id = useId();
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (!open) return;
    select.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const reveal = () => {
    clearTimer();
    suppressClick.current = true;
    setOpen(true);
  };
  return <div ref={root} className="relative flex shrink-0" onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button {...props} ref={trigger} type="button"
      aria-haspopup={cloud ? "dialog" : undefined}
      aria-expanded={cloud ? open : undefined}
      aria-controls={open ? id : undefined}
      onPointerDown={(event) => {
        clearTimer();
        suppressClick.current = false;
        if (!cloud || event.button !== 0) return;
        timer.current = setTimeout(reveal, 500);
      }}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={() => { clearTimer(); suppressClick.current = true; }}
      onContextMenu={cloud ? (event) => { event.preventDefault(); reveal(); } : undefined}
      onKeyDown={(event) => {
        if (!open && (event.key === "Enter" || event.key === " ")) suppressClick.current = false;
        if (cloud && (event.key === "ArrowDown" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          reveal();
        }
      }}
      onClick={(event) => {
        clearTimer();
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        onClick?.(event);
      }}
    >
      {transcribing ? <span className="animate-pulse text-xs">…</span> : <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />}
    </button>
    {open && <div id={id} role="dialog" aria-label={t("composer.cloudVoice.language")}
      className="absolute bottom-full end-0 z-40 mb-2 rounded-xl bg-menu p-3 shadow-lg"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
      <label className="flex flex-col gap-2 text-sm text-ink">
        {t("composer.cloudVoice.language")}
        <select ref={select} value={language} onChange={(event) => {
          onLanguage(event.target.value as Language);
          setOpen(false);
          trigger.current?.focus();
        }} className="rounded-lg bg-inset p-2 text-ink">
          {languages.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>}
  </div>;
}
