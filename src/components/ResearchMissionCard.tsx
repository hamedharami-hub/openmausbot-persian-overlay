import { t } from "@/lib/i18n";
import { researchMission } from "@/lib/research-mission";
import type { Message } from "@/state/store";

const SOURCE_LIMIT = 30;
const EVIDENCE_KINDS = ["citation", "tool-output", "failed-attempt"] as const;

function compact(text: string | undefined, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function ResearchMissionCard({ request, messages, partial = false }: { request: Message; messages: readonly Message[]; partial?: boolean }) {
  const mission = researchMission(request, messages);
  const sources = mission.sources.slice(0, SOURCE_LIMIT);

  return (
    <details className="w-full max-w-[680px] rounded-xl border border-hairline/45 bg-card text-[12px] text-ink-secondary">
      <summary className="cursor-pointer rounded-xl px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        <span className="font-medium text-ink">{t("research.mission.title")}</span>
        {" · "}
        <span>{t(`research.mission.status.${mission.status}`)}</span>
        {" · "}
        <span>{t("research.mission.urls", { count: mission.sources.length })}</span>
      </summary>
      <div className="space-y-2 border-t border-hairline/35 px-3 py-2">
        <p dir="auto" className="break-words text-[13px] text-ink">{compact(request.text, 280)}</p>
        <p>{t("research.mission.counts", { tools: mission.toolCount, failed: mission.failedToolCount, outputs: mission.outputCount })}</p>
        <p>{t("research.mission.disclaimer")}</p>
        {partial && <p>{t("research.mission.partial")}</p>}
        {mission.hasUnattributedActivity && <p>{t("research.mission.unattributed")}</p>}
        {sources.length === 0 ? <p>{t("research.mission.empty")}</p> : (
          <ul className="space-y-2">
            {sources.map((source) => {
              const href = safeHref(source.url);
              return (
                <li key={source.url} className="min-w-0 space-y-1">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" dir="ltr" className="block break-all text-accent underline underline-offset-2">
                      {compact(source.hostname, 100)} · {compact(source.url, 180)}
                    </a>
                  ) : <span dir="ltr" className="block break-all">{compact(source.url, 180)}</span>}
                  <div className="flex flex-wrap gap-1">
                    {Boolean(source.observations?.length) && <span className="rounded border border-hairline/45 px-1.5 py-0.5 text-[11px]">{t("research.mission.content.received")}</span>}
                    {EVIDENCE_KINDS.filter((kind) => source.mentions.some((mention) => mention.kind === kind)).map((kind) => (
                      <span key={kind} className="rounded border border-hairline/45 px-1.5 py-0.5 text-[11px]">
                        {t(`research.mission.evidence.${kind}`)}
                      </span>
                    ))}
                  </div>
                  {source.observations?.length ? <div className="space-y-2 rounded-lg bg-ink/[0.025] p-2">
                    <p>{t("research.mission.content.scope")}</p>
                    {source.observations.map((observation) => <dl key={`${observation.observedAt}:${observation.contentHash}`} className="space-y-1">
                      <div><dt className="inline">{t("research.mission.content.observedAt")} </dt><dd className="inline"><time dateTime={new Date(observation.observedAt).toISOString()} dir="ltr">{new Date(observation.observedAt).toISOString()}</time></dd></div>
                      <div><dt className="inline">{t("research.mission.content.length")} </dt><dd className="inline">{observation.capturedChars} · {t(observation.truncated ? "research.mission.content.partial" : "research.mission.content.bounded")}</dd></div>
                      <div><dt className="inline">{t("research.mission.content.published")} </dt><dd className="inline">{compact(observation.publishedAt, 120) || t("research.mission.content.unknown")}</dd></div>
                      <div><dt className="inline">{t("research.mission.content.modified")} </dt><dd className="inline">{compact(observation.modifiedAt, 120) || t("research.mission.content.unknown")}</dd></div>
                      <div><dt className="inline">{t("research.mission.content.dataDate")} </dt><dd className="inline">{t("research.mission.content.unknown")}</dd></div>
                      <div><dt className="inline">SHA-256 </dt><dd className="inline"><code dir="ltr" title={observation.contentHash}>{observation.contentHash.slice(0, 12)}…</code></dd></div>
                    </dl>)}
                  </div> : <p>{t("research.mission.content.missing")}</p>}
                  {Boolean(source.references?.length) && <details className="rounded-lg bg-ink/[0.025] p-2">
                    <summary className="cursor-pointer">{t("research.mission.references.title")}</summary>
                    <p className="mt-1">{t("research.mission.references.disclaimer")}</p>
                    {source.references?.map((reference, index) => <blockquote key={`${reference.messageId}:${index}`} dir="auto" className="mt-2 border-s-2 border-hairline ps-2">{reference.text}</blockquote>)}
                  </details>}
                </li>
              );
            })}
          </ul>
        )}
        {mission.sources.length > SOURCE_LIMIT && <p>{t("research.mission.limited", { shown: SOURCE_LIMIT, count: mission.sources.length })}</p>}
        {mission.sourcesTruncated && <p>{t("research.mission.truncated")}</p>}
      </div>
    </details>
  );
}
