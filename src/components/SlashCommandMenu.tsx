import { useState, type RefObject } from "react";
import { BookOpen, CheckCircle2, FileText, GraduationCap, Search, Settings, Sparkles, Target, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { ComposerSlashCommand } from "@/lib/composer-commands";
import type { MenuMotion } from "./MenuMotion";

type CategoryId = "all" | "actions" | "research" | "skills";

interface CategoryDef {
  id: CategoryId;
  label: string;
}

const CATEGORIES: CategoryDef[] = [
  { id: "all", label: "همه" },
  { id: "actions", label: "🎯 عملیات" },
  { id: "research", label: "🔍 پژوهش" },
  { id: "skills", label: "⚡ مهارت‌ها" },
];

const CATEGORY_STYLE: Record<Exclude<CategoryId, "all">, { icon: string; title: string; hint: string }> = {
  actions: { icon: "bg-sky-500/15 text-sky-500", title: "🎯 عملیات و هدف", hint: "کارهای اجرایی و هدف‌گذاری" },
  research: { icon: "bg-emerald-500/15 text-emerald-500", title: "🔍 پژوهش و راستی‌آزمایی", hint: "جستجو، بررسی و گزارش" },
  skills: { icon: "bg-violet-500/15 text-violet-500", title: "⚡ مهارت‌های تخصصی", hint: "مهارت‌های نصب‌شده بات" },
};

export function commandCategory(cmd: ComposerSlashCommand): Exclude<CategoryId, "all"> {
  if (cmd.kind === "skill") return "skills";
  if (cmd.id === "research" || cmd.id === "verify" || cmd.id === "report") return "research";
  return "actions";
}

function commandIcon(command: ComposerSlashCommand) {
  if (command.kind === "skill") return <Sparkles size={17} aria-hidden="true" />;
  switch (command.id) {
    case "goal":
      return <Target size={17} aria-hidden="true" />;
    case "learn":
      return <GraduationCap size={17} aria-hidden="true" />;
    case "setup":
      return <Settings size={17} aria-hidden="true" />;
    case "research":
      return <Search size={17} aria-hidden="true" />;
    case "verify":
      return <CheckCircle2 size={17} aria-hidden="true" />;
    case "report":
      return <FileText size={17} aria-hidden="true" />;
    default:
      return <BookOpen size={17} aria-hidden="true" />;
  }
}

/** The composer's / list: Telegram-bot style categorized command & skill menu. */
export function SlashCommandMenu({
  listRef,
  motion,
  commands,
  highlight,
  onPick,
  onHighlight,
  onClose,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  motion: MenuMotion;
  commands: ComposerSlashCommand[];
  highlight: number;
  onPick: (command: ComposerSlashCommand) => void;
  onHighlight: (index: number) => void;
  onClose?: () => void;
}) {
  const [activeCategory, setActiveCategory] = useState<CategoryId>("all");

  if (!motion.shown) return null;

  const counts: Record<CategoryId, number> = {
    all: commands.length,
    actions: commands.filter((c) => commandCategory(c) === "actions").length,
    research: commands.filter((c) => commandCategory(c) === "research").length,
    skills: commands.filter((c) => commandCategory(c) === "skills").length,
  };

  const effectiveCat = counts[activeCategory] > 0 ? activeCategory : "all";
  const visibleEntries = commands
    .map((command, index) => ({ command, index, category: commandCategory(command) }))
    .filter((entry) => effectiveCat === "all" || entry.category === effectiveCat);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("composer.commands.aria")}
      dir="rtl"
      className={cn(
        "absolute bottom-full inset-x-2 z-20 mb-2 flex max-h-[min(30rem,65vh)] flex-col overflow-hidden rounded-3xl border border-hairline/40 bg-raised shadow-2xl sm:inset-x-auto sm:left-2 sm:w-[26rem]",
        motion.className,
      )}
      {...motion.exitProps}
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-1.5 pt-3">
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-ink">دستورات و مهارت‌ها</div>
          <div className="text-[11px] text-ink-tertiary">یک مورد را انتخاب کنید یا برای جستجو تایپ کنید</div>
        </div>
        {onClose && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
            aria-label="Close commands menu"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-inset/60 text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Category chips (Telegram bot menu style) */}
      <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2.5 pt-1 no-scrollbar">
        {CATEGORIES.filter((cat) => cat.id === "all" || counts[cat.id] > 0).map((cat) => {
          const active = effectiveCat === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-all",
                active
                  ? "bg-accent text-accent-ink shadow-sm"
                  : "bg-inset/60 text-ink-secondary hover:bg-raised-hover hover:text-ink",
              )}
            >
              <span>{cat.label}</span>
              <span
                className={cn(
                  "min-w-[1.25rem] rounded-full px-1 text-center text-[10px] leading-4",
                  active ? "bg-accent-ink/20" : "bg-hairline/30 text-ink-tertiary",
                )}
              >
                {counts[cat.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain border-t border-hairline/20 px-2 py-1.5">
        {visibleEntries.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-ink-tertiary">موردی پیدا نشد</div>
        )}
        {visibleEntries.map((entry, pos) => {
          const { command, index, category } = entry;
          const prevCat = pos > 0 ? visibleEntries[pos - 1]?.category : null;
          const showSectionHeader = effectiveCat === "all" && category !== prevCat;
          const style = CATEGORY_STYLE[category];
          const selected = index === highlight;
          return (
            <div key={`${command.kind}:${command.id}`}>
              {showSectionHeader && (
                <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-raised/95 px-2 pb-1 pt-2.5 backdrop-blur">
                  <span className="text-[11px] font-bold text-ink-secondary">{style.title}</span>
                  <span className="text-[10px] text-ink-tertiary">{style.hint}</span>
                </div>
              )}
              <button
                data-command-index={index}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(command)}
                onMouseEnter={() => onHighlight(index)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-start transition-colors",
                  selected ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-raised-hover/70",
                )}
              >
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-2xl", style.icon)}>
                  {commandIcon(command)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2" dir="ltr">
                    <span className="truncate font-mono text-[14px] font-semibold text-ink">{command.label}</span>
                    {command.kind === "skill" && (
                      <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 text-[10px] font-medium leading-4 text-violet-500">
                        {t("composer.command.skillTag")}
                      </span>
                    )}
                  </span>
                  <span dir="auto" className="mt-0.5 line-clamp-2 block text-[12px] leading-[17px] text-ink-secondary">
                    {command.description}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="hidden items-center justify-center gap-3 border-t border-hairline/20 bg-inset/30 px-3 py-1.5 text-[10px] text-ink-tertiary sm:flex">
        <span>↑↓ حرکت</span>
        <span>Enter انتخاب</span>
        <span>Esc بستن</span>
      </div>
    </div>
  );
}
