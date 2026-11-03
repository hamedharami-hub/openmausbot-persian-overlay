import { MEMORY_INDEX, type MemoryDoc } from "@/lib/memory";

/** The bullet lines of MEMORY.md, each with the line it sits on so one can be taken out again. */
export interface MemoryNote {
  line: number;
  text: string;
}

const BULLET = /^\s*[-*]\s+(.+?)\s*$/;

export function memoryNotes(text: string): MemoryNote[] {
  return text.split("\n").flatMap((raw, line) => {
    const note = BULLET.exec(raw)?.[1];
    return note ? [{ line, text: note }] : [];
  });
}

export function withoutMemoryNote(text: string, line: number): string {
  const lines = text.split("\n");
  if (!BULLET.test(lines[line] ?? "")) return text;
  lines.splice(line, 1);
  return lines.join("\n");
}

export function withMemoryNote(text: string, note: string): string {
  const body = text.replace(/\s+$/, "");
  const bullet = `- ${note.trim().replace(/\s*\n\s*/g, " ")}`;
  return body ? `${body}\n${bullet}\n` : `${bullet}\n`;
}

/** What a memory line itself records. Absent fields stay absent: no source is invented from the wording. */
export interface MemoryNoteFacts {
  date: string | null;
  source: string | null;
  sourceKind: "chat" | "room" | "thread" | "noticed" | "dream" | "other" | null;
  until: string | null;
  expiredOn: string | null;
  supersededOn: string | null;
  struck: boolean;
}

const DATED_NOTE = /^\s*(?:[-*]\s+)?(~~)?(\d{4}-\d{2}-\d{2}) · from ([^·\n]+?) · (.*)$/;
const MARK = / · (until|expired|superseded|updated|confirmed|moved) (\d{4}-\d{2}-\d{2})/g;

/** Mirrors the MEMORY.md entry grammar the server writes; anything else reads as hand-written. */
export function memoryNoteFacts(text: string): MemoryNoteFacts {
  const head = DATED_NOTE.exec(text);
  const rest = head?.[4] ?? text;
  const facts: MemoryNoteFacts = { date: head?.[2] ?? null, source: head?.[3]?.trim() ?? null, sourceKind: null,
    until: null, expiredOn: null, supersededOn: null, struck: Boolean(head?.[1]) || rest.trimStart().startsWith("~~") };
  const noticed = /\(noticed\)\s*$/u.test(rest);
  const source = facts.source ?? "";
  facts.sourceKind = noticed ? "noticed"
    : !source ? null
    : /^chat\s+"/u.test(source) ? "chat"
    : /^room\s+"/u.test(source) ? "room"
    : /^thread\b/u.test(source) ? "thread"
    : /\bdream\b/u.test(source) ? "dream"
    : "other";
  for (const mark of text.matchAll(MARK)) {
    if (mark[1] === "until") facts.until = mark[2]!;
    if (mark[1] === "expired") facts.expiredOn = mark[2]!;
    if (mark[1] === "superseded") facts.supersededOn = mark[2]!;
  }
  return facts;
}

export function noteIsExpired(facts: MemoryNoteFacts, today: string): boolean {
  return !facts.struck && (facts.expiredOn !== null || (facts.until !== null && facts.until < today));
}

/** A note of one file: a bullet of it, or, for a topic file without bullets, the whole file (`line` null). */
export interface PanelMemoryNote {
  path: string;
  line: number | null;
  text: string;
}

export function panelMemoryNotes(docs: readonly MemoryDoc[]): PanelMemoryNote[] {
  return docs.flatMap((doc): PanelMemoryNote[] => {
    const bullets = memoryNotes(doc.text).map((note) => ({ path: doc.path, ...note }));
    if (bullets.length || doc.path === MEMORY_INDEX) return bullets;
    const text = doc.text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).filter(Boolean).join(" ");
    return text ? [{ path: doc.path, line: null, text }] : [];
  });
}
