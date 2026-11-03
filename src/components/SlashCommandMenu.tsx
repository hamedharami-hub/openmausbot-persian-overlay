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
  { id: "actions", label: "عملیات و هدف" },
  { id: "research", label: "پژوهش و گزارش" },
  { id: "skills", label: "مهارت‌ها" },
];

export function commandCategory(cmd: ComposerSlashCommand): Exclude<CategoryId, "all"> {
  if (cmd.kind === "skill") return "skills";
  if (cmd.id === "research" || cmd.id === "verify" || cmd.id === "report") return "research";
  return "actions";
}

function commandIcon(command: ComposerSlashCommand) {
  if (command.kind === "skill") return <Sparkles size={15} aria-hidden="true" />;
  switch (command.id) {
    case "goal":
      return <Target size={15} aria-hidden="true" />;
    case "learn":
      return <GraduationCap size={15} aria-hidden="true" />;
    case "setup":
      return <Settings size={15} aria-hidden="true" />;
    case "research":
      return <Search size={15} aria-hidden="true" />;
    case "verify":
      return <CheckCircle2 size={15} aria-hidden="true" />;
    case "report":
      return <FileText size={15} aria-hidden="true" />;
    default:
      return <BookOpen size={15} aria-hidden="true" />;
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

  const categoryTitles: Record<Exclude<CategoryId, "all">, string> = {
    actions: "🎯 عملیات و هدف (Actions & Goal)",
    research: "🔍 پژوهش و راستی‌آزمایی (Research & Verify)",
    skills: "⚡ مهارت‌های تخصصی (Bot Skills)",
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("composer.commands.aria")}
      className={cn(
        "absolute bottom-full left-2 z-20 mb-2 flex max-h-[22rem] w-[21rem] max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-raised shadow-xl",
        motion.className,
      )}
      {...motion.exitProps}
    >
      <div className="flex items-center justify-between border-b border-hairline/20 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-secondary">
          {t("composer.commands.title")} · منوی دستورات بات
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close commands menu"
            className="flex size-5 items-center justify-center rounded-full text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Category tabs (Telegram bot menu style) */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-hairline/20 bg-inset/30 px-2.5 py-1.5 no-scrollbar">
        {CATEGORIES.filter((cat) => cat.id === "all" || counts[cat.id] > 0).map((cat) => {
          const active = effectiveCat === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                active
                  ? "bg-accent text-accent-ink shadow-xs"
                  : "bg-raised/70 text-ink-secondary hover:bg-raised-hover hover:text-ink",
              )}
            >
              <span>{cat.label}</span>
              <span className={cn("text-[10px] opacity-80", active ? "text-accent-ink" : "text-ink-tertiary")}>
                {counts[cat.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-1">
        {visibleEntries.map((entry, pos) => {
          const { command, index, category } = entry;
          const prevCat = pos > 0 ? visibleEntries[pos - 1]?.category : null;
          const showSectionHeader = effectiveCat === "all" && category !== prevCat;
          return (
            <div key={`${command.kind}:${command.id}`}>
              {showSectionHeader && (
                <div className="border-y border-hairline/15 bg-inset/25 px-3 py-1 text-[10px] font-semibold tracking-[0.04em] text-ink-secondary first:border-t-0">
                  {categoryTitles[category]}
                </div>
              )}
              <button
                data-command-index={index}
                type="button"
                role="option"
                aria-selected={index === highlight}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(command)}
                onMouseEnter={() => onHighlight(index)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                  index === highlight ? "bg-raised-hover" : "hover:bg-raised-hover/60",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  {commandIcon(command)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[13.5px] font-semibold text-accent">{command.label}</span>
                    {command.kind === "skill" && (
                      <span className="shrink-0 rounded-full bg-accent/10 px-1.5 text-[10px] font-medium leading-4 text-accent">
                        {t("composer.command.skillTag")}
                      </span>
                    )}
                  </span>
                  <span dir="auto" className="block truncate text-xs text-ink-secondary">
                    {command.description}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
