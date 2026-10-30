// Facts bots added to About me on their own; a removed fact is remembered by identity and never added again.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { factIdentity, foldForMatch, passageMatcher } from "./memory-entries.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_KEPT = 200;
const MAX_REMOVED = 500;
const MAX_FORGOTTEN = 200;
const TEXT_MAX = 300;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const PERSON_KEY = /^p_[A-Za-z0-9_-]{22}$/;

export interface LearnedFact {
  id: string;
  text: string;
  line: string;
  botId: string;
  botName: string;
  at: number;
}

interface LearnedFile {
  learned: LearnedFact[];
  removed: string[];
  /** What the person asked a bot to forget, as they named it: no bot learns a fact that mentions one again. */
  forgotten?: string[];
}

function filePath(scopeKey?: string): string {
  if (scopeKey === undefined) return join(DATA_DIR, "profile-learned.json");
  if (!PERSON_KEY.test(scopeKey)) throw new Error("A valid account key is required for learned facts");
  return join(DATA_DIR, "profile-learned", `${scopeKey}.json`);
}

function load(scopeKey?: string): LearnedFile {
  let text: string;
  try {
    text = readFileSync(filePath(scopeKey), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { learned: [], removed: [] };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("Learned facts file is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Learned facts file is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Learned facts file is malformed");
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.learned) || record.learned.length > MAX_KEPT ||
    (record.removed !== undefined && (!Array.isArray(record.removed) || record.removed.length > MAX_REMOVED))) {
    throw new Error("Learned facts file has an unsupported format");
  }
  const learned: LearnedFact[] = [];
  for (const value of record.learned) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Learned facts file contains an invalid fact");
    const fact = value as Record<string, unknown>;
    if (typeof fact.id !== "string" || !fact.id || fact.id.length > 128 ||
      typeof fact.text !== "string" || fact.text.length > TEXT_MAX ||
      typeof fact.line !== "string" || fact.line.length > 512 ||
      typeof fact.botId !== "string" || fact.botId.length > 128 ||
      typeof fact.botName !== "string" || fact.botName.length > 128 ||
      typeof fact.at !== "number" || !Number.isFinite(fact.at)) {
      throw new Error("Learned facts file contains an invalid fact");
    }
    learned.push({ id: fact.id, text: fact.text, line: fact.line, botId: fact.botId, botName: fact.botName, at: fact.at });
  }
  const removed = record.removed ?? [];
  if (!Array.isArray(removed) || removed.some((identity) => typeof identity !== "string" || identity.length > 512)) {
    throw new Error("Learned facts file contains invalid removal history");
  }
  const forgotten = record.forgotten ?? [];
  if (!Array.isArray(forgotten) || forgotten.length > MAX_FORGOTTEN || forgotten.some((value) => typeof value !== "string" || value.length > 512)) {
    throw new Error("Learned facts file contains invalid forgotten history");
  }
  return { learned, removed: [...removed] as string[], forgotten: [...forgotten] as string[] };
}

function save(file: LearnedFile, scopeKey?: string): void {
  const target = filePath(scopeKey);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileAtomic(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function listLearnedFacts(scopeKey?: string): LearnedFact[] {
  return [...load(scopeKey).learned].reverse();
}

export function aboutMeLine(fact: { text: string; botName: string }, today: string): string {
  return `- ${today} · learned by ${fact.botName.replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, 60)} · ${fact.text}`;
}

/** A line aboutMeLine wrote: learned from chats, not typed by the person. */
export const LEARNED_LINE = /^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /;

function lineIdentity(line: string): string {
  return factIdentity(line.replace(LEARNED_LINE, ""));
}

export function planLearned(from: { botId: string; botName: string }, texts: readonly string[], aboutMe: string, today: string, now = Date.now(), scopeKey?: string): LearnedFact[] {
  const file = load(scopeKey);
  const known = new Set([...file.removed, ...aboutMe.split("\n").map(lineIdentity)]);
  const forgotten = forgottenIn(file);
  const out: LearnedFact[] = [];
  for (const raw of texts) {
    const text = redactSecretsInText(raw.replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX);
    const key = factIdentity(text);
    if (!key || known.has(key) || forgotten(text)) continue;
    known.add(key);
    out.push({ id: randomUUID(), text, line: aboutMeLine({ text, botName: from.botName }, today), botId: from.botId, botName: from.botName, at: now });
  }
  return out;
}

export function commitLearned(facts: readonly LearnedFact[], scopeKey?: string): void {
  if (!facts.length) return;
  const file = load(scopeKey);
  file.learned = [...file.learned, ...facts].slice(-MAX_KEPT);
  save(file, scopeKey);
}

export function appendAboutMe(aboutMe: string, lines: readonly string[], maxChars = 24_000): string | null {
  if (!lines.length) return aboutMe;
  const base = aboutMe.replace(/\s+$/, "");
  const next = base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
  return next.length > maxChars ? null : next;
}

function forgottenIn(file: LearnedFile): (text: string) => boolean {
  const matchers = (file.forgotten ?? []).map(passageMatcher).filter((match): match is (text: string) => boolean => match !== null);
  return (text) => matchers.some((matches) => matches(text));
}

export function isForgotten(text: string, scopeKey?: string): boolean {
  return forgottenIn(load(scopeKey))(text);
}

/** Learned facts that mention it are dropped and never added again, and so is any fact that mentions it later. */
export function rememberForgotten(passage: string, mentions: (text: string) => boolean, scopeKey?: string): void {
  const file = load(scopeKey);
  const gone = file.learned.filter((fact) => mentions(fact.text));
  const folded = foldForMatch(passage);
  file.learned = file.learned.filter((fact) => !mentions(fact.text));
  file.removed = [...file.removed, ...gone.map((fact) => factIdentity(fact.text))].slice(-MAX_REMOVED);
  file.forgotten = [...(file.forgotten ?? []).filter((kept) => kept !== folded), folded].slice(-MAX_FORGOTTEN);
  save(file, scopeKey);
}

/** The person asked to remember something again: what they forgot before stops blocking it. */
export function clearForgotten(text: string, scopeKey?: string): void {
  const file = load(scopeKey);
  const kept = (file.forgotten ?? []).filter((passage) => !passageMatcher(passage)?.(text));
  if (kept.length === (file.forgotten ?? []).length) return;
  save({ ...file, forgotten: kept, removed: file.removed.filter((identity) => identity !== factIdentity(text)) }, scopeKey);
}

/** Save About me before committing removal, so a failed profile save leaves the fact retryable. */
export function removeLearned(id: string, aboutMe: string, saveAboutMe?: (text: string) => void, scopeKey?: string): { fact: LearnedFact; aboutMe: string } | null {
  const file = load(scopeKey);
  const fact = file.learned.find((f) => f.id === id);
  if (!fact) return null;
  const lines = aboutMe.split("\n");
  const at = lines.indexOf(fact.line);
  if (at !== -1) lines.splice(at, 1);
  const next = lines.join("\n");
  if (next !== aboutMe) saveAboutMe?.(next);
  file.learned = file.learned.filter((f) => f.id !== id);
  file.removed = [...file.removed, factIdentity(fact.text)].slice(-MAX_REMOVED);
  save(file, scopeKey);
  return { fact, aboutMe: next };
}

/** What this server learned about the person, and what the person removed, as another server takes them. */
export function learnedState(): { learned: LearnedFact[]; removed: string[] } {
  const { learned, removed } = load();
  return { learned, removed };
}

/** Another server's learned facts and removals: each fact neither removed here nor already in About me is added to it
 * once, and its removals are remembered here too. Null when About me has no room for them. */
export function adoptLearned(facts: readonly LearnedFact[], removed: readonly string[], aboutMe: string): { aboutMe: string; added: number } | null {
  const file = load();
  const tombstones = new Set([...file.removed, ...removed]);
  const known = new Set([...file.learned.map((fact) => factIdentity(fact.text)), ...aboutMe.split("\n").map(lineIdentity)]);
  const held = new Set([...file.learned.map((fact) => fact.id), ...file.learned.map((fact) => factIdentity(fact.text))]);
  const lines: string[] = [], kept: LearnedFact[] = [];
  for (const fact of facts) {
    const key = factIdentity(fact.text);
    if (!key || tombstones.has(key)) continue;
    if (!held.has(fact.id) && !held.has(key)) { kept.push(fact); held.add(fact.id).add(key); }
    if (!known.has(key)) { lines.push(fact.line); known.add(key); }
  }
  const next = appendAboutMe(aboutMe, lines);
  if (next === null) return null;
  const removals = [...new Set([...file.removed, ...removed])].slice(-MAX_REMOVED);
  if (kept.length || removals.length !== file.removed.length) save({ ...file, learned: [...file.learned, ...kept].slice(-MAX_KEPT), removed: removals });
  return { aboutMe: next, added: lines.length };
}
