import { isPersistentQuestionCard } from "../../shared/ask-question";
import { pendingApprovals } from "@/components/PendingApproval";
import type { Bot, Message } from "@/state/store";

export type BotNowState = "working" | "waiting-on-you" | "idle" | "no-signal" | "parked" | "unknown";

export interface BotNowBlocker { kind: "approval" | "question"; messageId: string; at: number; detail?: string }
export interface BotNowLastResult { messageId: string; at: number; excerpt: string; succeeded: boolean | null }
export interface BotNow {
  state: BotNowState;
  startedAt: number | null;
  blocker: BotNowBlocker | null;
  lastResult: BotNowLastResult | null;
  queued: number;
  missionTitle: string | null;
}

const MAX_AGE_MS = 24 * 60 * 60_000;
const FUTURE_SKEW_MS = 5 * 60_000;

function timeOf(value: number | null | undefined, now: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now + FUTURE_SKEW_MS ? value : null;
}

function excerpt(text: string | undefined): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 160 ? `${value.slice(0, 159).trimEnd()}…` : value;
}

/** Reads only recorded client state: no progress percentages, no completion inferred from silence. */
export function botNow(bot: Bot, messages: readonly Message[], queued = 0, now = Date.now()): BotNow {
  const rows = messages as Message[];
  const approval = pendingApprovals(rows)[0];
  const question = rows.filter((message) => message.kind === "options" && message.card
    && isPersistentQuestionCard(message.card) && !message.card.answered && !message.card.dismissed && !message.card.expired).at(-1);
  const blocker: BotNowBlocker | null = approval
    ? { kind: "approval", messageId: approval.message.id, at: approval.message.at, ...(approval.tool ? { detail: approval.tool } : {}) }
    : question ? { kind: "question", messageId: question.id, at: question.at } : null;
  const activity = bot.activity;
  const state: BotNowState = blocker ? "waiting-on-you"
    : activity === "working" ? "working"
    : activity === "waiting-on-you" ? "waiting-on-you"
    : activity === "parked.computer" ? "parked"
    : activity === "no-signal" ? "no-signal"
    : activity === "idle" ? "idle"
    : activity === "dead" ? "unknown"
    : bot.busy === true ? "working"
    : rows.length > 0 || (bot.tasks?.length ?? 0) > 0 ? "idle"
    : "unknown";
  const last = rows.filter((message) => message.role === "bot" && message.kind === "text" && !message.webhookPost
    && Boolean(message.text?.trim()) && timeOf(message.at, now) !== null && now - message.at <= MAX_AGE_MS).at(-1);
  const startedAt = state === "working" || state === "waiting-on-you" ? timeOf(bot.turnStartedAt, now) : null;
  return {
    state,
    startedAt,
    blocker,
    lastResult: last ? {
      messageId: last.id, at: last.at, excerpt: excerpt(last.text),
      succeeded: last.turnSucceeded === true ? true : last.turnSucceeded === false ? false : null,
    } : null,
    queued: Number.isInteger(queued) && queued > 0 ? queued : 0,
    missionTitle: bot.busy || state === "working" ? (bot.tasks?.find((task) => task.threadId === bot.threadId)?.title ?? null) : null,
  };
}
