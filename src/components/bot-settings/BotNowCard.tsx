import type { Bot } from "@/state/store";
import { visibleMessages } from "@/state/snapshot-navigation";
import { t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/memory";
import { botNow, type BotNowState } from "@/lib/bot-now";

const TONE: Record<BotNowState, string> = {
  working: "bg-accent/10 text-accent",
  "waiting-on-you": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  idle: "bg-ink/[0.06] text-ink-secondary",
  "no-signal": "bg-ink/[0.06] text-ink-secondary",
  parked: "bg-ink/[0.06] text-ink-secondary",
  unknown: "bg-ink/[0.06] text-ink-secondary",
};

/** What this bot's recorded state says right now; absent facts stay "not established". */
export function BotNowCard({ bot, queued = 0 }: { bot: Bot; queued?: number }) {
  const messages = visibleMessages(bot);
  const now = botNow(bot, messages, queued);
  const locale = typeof navigator === "undefined" ? "en" : navigator.language;
  const when = (at: number) => localizedRelativeTime(at, locale);
  return (
    <section data-bot-now className="rounded-xl border border-hairline/45 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-medium text-ink">{t("botNow.title")}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[now.state]}`}>{t(`botNow.state.${now.state}`)}</span>
        {now.startedAt !== null && <span className="text-[12px] text-ink-secondary">{t("botNow.since", { when: when(now.startedAt) })}</span>}
      </div>
      {now.missionTitle && <p className="mt-1 text-[13px] text-ink">{t("botNow.mission", { title: now.missionTitle })}</p>}
      {now.blocker && (
        <p data-bot-now-blocker className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[13px] text-ink">
          {now.blocker.kind === "approval"
            ? t("botNow.blocked.approval", { tool: now.blocker.detail ?? t("botNow.blocked.aCommand") })
            : t("botNow.blocked.question")}{" "}
          <span className="text-ink-secondary">{when(now.blocker.at)}</span>
        </p>
      )}
      {now.queued > 0 && <p className="mt-2 text-[13px] text-ink-secondary">{t("botNow.queued", { count: String(now.queued) })}</p>}
      <div className="mt-2 text-[13px]">
        {now.lastResult ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-ink-secondary">
              <span>{t("botNow.last.label")}</span>
              <span>{when(now.lastResult.at)}</span>
              <span data-bot-now-outcome className="rounded border border-hairline/45 px-1.5 text-[11px]">
                {now.lastResult.succeeded === true ? t("botNow.last.succeeded")
                  : now.lastResult.succeeded === false ? t("botNow.last.failed")
                  : t("botNow.last.unknown")}
              </span>
            </div>
            <p dir="auto" className="mt-1 line-clamp-3 text-ink">{now.lastResult.excerpt}</p>
          </>
        ) : <p className="text-ink-secondary">{t("botNow.last.none")}</p>}
      </div>
      <p className="mt-2 text-[11px] text-ink-tertiary">{t("botNow.scope")}</p>
    </section>
  );
}
