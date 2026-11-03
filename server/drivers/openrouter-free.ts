// OpenRouter refuses every paid model with HTTP 402 for an account that never bought credit (its /key reports
// `is_free_tier`), so such a key defaults to a free model that can call tools. OpenRouter names free models "<id>:free".
import { createHash } from "node:crypto";
import type { ModelCatalog, ProviderInstance } from "../contracts.ts";
import { checkProviderKey } from "../provider-key-check.ts";
import { httpStatusOf } from "./engine-errors.ts";

/** Free models that call tools well, best first; when none is listed, the first free tool-capable model wins. */
export const FREE_MODEL_PREFERENCE: readonly string[] = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3.5-lightning:free",
];

/** The paid models a bot starts on when the key has credit and the owner chose no model. */
export const PAID_MODEL_PREFERENCE: readonly string[] = [
  "anthropic/claude-sonnet-5.5",
  "openai/gpt-6.1-terra",
  "google/gemini-4-argon",
  "deepseek/deepseek-v4.1-flash-1017",
  "qwen/qwen3.8-max-prime",
  "x-ai/grok-4.7",
  "mistralai/mistral-large-4-0",
  "moonshotai/kimi-k3.1-pro",
];

export const OPENROUTER_FAILURES = {
  credits: "This model needs OpenRouter credit (HTTP 402). Pick a model marked (free), or add credit at openrouter.ai/credits.",
  privacy: "OpenRouter's privacy settings block this free model (HTTP 404). Allow free model endpoints at openrouter.ai/settings/privacy, or pick another model.",
  tools: "This model can't use tools, which bots need (HTTP 404). Pick another model, such as one marked (free).",
  freeLimit: "OpenRouter's limit for free models is used up for now (HTTP 429). Free models allow a set number of requests each day: wait for it to reset, or add credit at openrouter.ai/credits to raise it.",
} as const;

const TIER_TIMEOUT_MS = 5_000;
const FIRST_TURN_WAIT_MS = 4_000;
const REMEMBERED_KEYS = 32;

type Option = ModelCatalog["options"][number];

export interface OpenRouterModelRow {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
}

export function isOpenRouterOrigin(url: string): boolean {
  try {
    return new URL(url).origin === "https://openrouter.ai";
  } catch {
    return false;
  }
}

const freeId = (id: unknown): id is string => typeof id === "string" && id.endsWith(":free");

export function isFreeModel(row: OpenRouterModelRow): boolean {
  const pricing = row.pricing && typeof row.pricing === "object" ? (row.pricing as { prompt?: unknown; completion?: unknown }) : null;
  const zero = (value: unknown) => (typeof value === "string" && value.trim() !== "" || typeof value === "number") && Number(value) === 0;
  return freeId(row.id) || (zero(pricing?.prompt) && zero(pricing?.completion));
}

export function freeLabel(label: string, row: OpenRouterModelRow): string {
  return isFreeModel(row) && !/\(free\)\s*$/i.test(label) ? `${label} (free)` : label;
}

/** Free models that take tools, in OpenRouter's order. */
export function freeToolModels(rows: readonly OpenRouterModelRow[]): string[] {
  return rows.flatMap((row) =>
    typeof row.id === "string" && isFreeModel(row) && Array.isArray(row.supported_parameters) && row.supported_parameters.includes("tools") ? [row.id] : []);
}

export function freeDefault(freeTools: readonly string[]): string | undefined {
  return FREE_MODEL_PREFERENCE.find((id) => freeTools.includes(id)) ?? freeTools[0];
}

/** The listed paid model the catalog offers, so a bot with credit never starts on an obscure one. */
export function paidDefault(options: readonly Option[]): string | undefined {
  const ids = new Set(options.map((option) => option.id));
  return PAID_MODEL_PREFERENCE.find((id) => ids.has(id));
}

export function freeToolsFirst(options: readonly Option[], freeTools: readonly string[]): Option[] {
  const free = new Set(freeTools);
  return [...options.filter((option) => free.has(option.id)), ...options.filter((option) => !free.has(option.id))];
}

const modelProvider = (id: string): string => id.split("/")[0]?.toLowerCase() ?? "";

/** A model's branch, with its version numbers and dates removed: "anthropic/claude-sonnet-5.5" and
 * "anthropic/claude-3.7-sonnet" both belong to the branch "anthropic/claude-sonnet". */
export function openRouterFamily(id: string): string {
  return id.split("/").map((part) => part.split("-").map((token) => token.replace(/\d+(?:\.\d+)*/g, "").replace(/\.+/g, "")).filter(Boolean).join("-")).filter(Boolean).join("/");
}

/** How long a branch stays in the list after its provider moved on: a branch whose newest model is older than this
 * beside the provider's newest model is a retired generation. */
export const BRANCH_AGE_DAYS = 270;

/** OpenRouter's active catalog stays the source of truth: keep every free model and, from each branch of each
 * provider, its newest model. Older versions of a branch never reach the model list. */
export function curatedOpenRouterRows<T extends OpenRouterModelRow>(rows: readonly T[]): T[] {
  const valid = rows.filter((row): row is T & { id: string } => typeof row.id === "string" && row.id.includes("/"));
  const byProvider = new Map<string, (T & { id: string })[]>();
  for (const row of valid) {
    if (row.id.endsWith(":batch")) continue;
    const provider = modelProvider(row.id);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), row]);
  }
  const keep = new Set(valid.filter(isFreeModel).map((row) => row.id));
  for (const rows of byProvider.values()) {
    const newestOfProvider = Math.max(...rows.map((row) => typeof row.created === "number" ? row.created : 0));
    const window = BRANCH_AGE_DAYS * 24 * 60 * 60;
    const newestOfBranch = new Map<string, T & { id: string }>();
    for (const row of rows) {
      if (isFreeModel(row)) continue;
      const branch = openRouterFamily(row.id);
      const current = newestOfBranch.get(branch);
      const created = typeof row.created === "number" ? row.created : 0;
      const currentCreated = typeof current?.created === "number" ? current.created : 0;
      if (!current || created > currentCreated || (created === currentCreated && row.id < current.id)) newestOfBranch.set(branch, row);
    }
    for (const row of newestOfBranch.values()) {
      const created = typeof row.created === "number" ? row.created : 0;
      if (created >= newestOfProvider - window) keep.add(row.id);
    }
  }
  return valid.filter((row) => keep.has(row.id));
}

/** Before OpenRouter's catalog arrives, a free-tier key already defaults to the first preferred free model. */
export function freeFallbackCatalog(seeded: ModelCatalog): ModelCatalog {
  const id = FREE_MODEL_PREFERENCE[0]!;
  return { default: id, options: [{ id, label: freeLabel(id, { id }), custom: true }, ...seeded.options] };
}

const tiers = new Map<string, Promise<boolean | null>>();

/** Security invariant: only the key's SHA-256 is remembered, and the key goes nowhere but OpenRouter's /key over TLS.
 * Asked once per key; an unknown answer (null) is asked again next time. */
export function openRouterFreeTier(key: string, url?: string): Promise<boolean | null> {
  const hash = createHash("sha256").update(key).digest("hex");
  const known = tiers.get(hash);
  if (known) return known;
  const asked = checkProviderKey({ provider: "openrouter", key, url }, undefined, TIER_TIMEOUT_MS)
    .then((verdict) => (verdict.ok ? verdict.freeTier ?? null : null));
  if (tiers.size >= REMEMBERED_KEYS) tiers.delete(tiers.keys().next().value!);
  tiers.set(hash, asked);
  void asked.then((tier) => {
    if (tier === null && tiers.get(hash) === asked) tiers.delete(hash);
  });
  return asked;
}

/** OpenRouter's refusal in plain words, or null when it is none of these. */
export function openRouterFailure(text: string, model: string): string | null {
  const status = httpStatusOf(text);
  const free = model.endsWith(":free");
  if (status === 402 || /\binsufficient credits\b|\brequires more credits\b/i.test(text)) return OPENROUTER_FAILURES.credits;
  if (/\bno endpoints found matching your data policy\b/i.test(text) && (free || /\bfree model/i.test(text))) {
    return OPENROUTER_FAILURES.privacy;
  }
  if (/\bno endpoints found that support tool use\b/i.test(text)) return OPENROUTER_FAILURES.tools;
  if ((status === 429 || /\brate limit exceeded\b/i.test(text)) && (free || /\bfree-models-per-/i.test(text))) {
    return OPENROUTER_FAILURES.freeLimit;
  }
  return null;
}

/** A turn or helper call without a chosen model waits briefly for `loading` (the key's tier and the catalog), so it
 * runs on the free default; OpenRouter's refusals reach the chat in plain words. */
export function withOpenRouterTurns(instance: ProviderInstance, loading: Promise<unknown>): ProviderInstance {
  const settled = async () => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([loading, new Promise((resolve) => { timer = setTimeout(resolve, FIRST_TURN_WAIT_MS); })]);
    clearTimeout(timer);
  };
  const { adapter } = instance;
  const send = adapter.sendTurn;
  const listen = adapter.onEvent;
  const generate = instance.generateText;
  const turnModels = new Map<string, string>();
  listen((event) => {
    if (event.type === "turn.completed") turnModels.delete(event.threadId);
  });
  adapter.sendTurn = async (turn) => {
    if (!turn.model) await settled();
    turnModels.set(turn.threadId, turn.model || instance.models.default);
    return send(turn);
  };
  adapter.onEvent = (listener) => listen((event) => listener(event.type === "runtime.error"
    ? { ...event, message: openRouterFailure(event.message, turnModels.get(event.threadId) ?? "") ?? event.message }
    : event));
  if (generate) {
    instance.generateText = async (prompt, options) => {
      if (!options?.model) await settled();
      return generate(prompt, options);
    };
  }
  return Object.assign(instance, { startupModelRefresh: loading.then(() => {}) });
}
