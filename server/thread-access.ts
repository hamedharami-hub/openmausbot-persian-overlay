// Per-thread account access is deliberately separate from thread-starters.json, whose entries only gate security cards.
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";

const PERSON = /^p_[\w-]{22}$/;
const THREAD = /^[\w-]{1,128}$/;
const MAX_ENTRIES = 50_000;

type Persisted = { version: 1; privateThreads: Record<string, string> };

export class ThreadAccess {
  private readonly owners = new Map<string, string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`thread access store could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("thread access store is malformed");
    const document = raw as Partial<Persisted>;
    if (document.version !== 1 || !document.privateThreads || typeof document.privateThreads !== "object" || Array.isArray(document.privateThreads)) {
      throw new Error("thread access store has an unsupported format");
    }
    const entries = Object.entries(document.privateThreads);
    if (entries.length > MAX_ENTRIES) throw new Error("thread access store has too many entries");
    for (const [threadId, person] of entries) {
      if (!THREAD.test(threadId) || typeof person !== "string" || !PERSON.test(person)) {
        throw new Error("thread access store contains an invalid entry");
      }
      this.owners.set(threadId, person);
    }
  }

  privateOwner(threadId: string): string | undefined {
    return this.owners.get(threadId);
  }

  canAccess(threadId: string, person: string | undefined): boolean {
    const owner = this.privateOwner(threadId);
    // Unknown ownership is not an account grant. Explicitly shared rooms use VisibleSet instead.
    return owner !== undefined && Boolean(person) && owner === person;
  }

  /** Claim only a new thread. If persistence fails, roll back the in-memory grant as well. */
  claimPrivate(threadId: string, person: string): boolean {
    if (!THREAD.test(threadId) || !PERSON.test(person)) return false;
    const current = this.owners.get(threadId);
    if (current !== undefined) return current === person;
    if (this.owners.size >= MAX_ENTRIES) return false;
    this.owners.set(threadId, person);
    try {
      this.persist();
      return true;
    } catch (error) {
      this.owners.delete(threadId);
      console.warn(`thread access: could not save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Retain the private grant if its durable removal fails; that is the safe outcome. */
  forget(threadId: string): boolean {
    const current = this.owners.get(threadId);
    if (current === undefined) return true;
    this.owners.delete(threadId);
    try {
      this.persist();
      return true;
    } catch (error) {
      this.owners.set(threadId, current);
      console.warn(`thread access: could not update ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private persist(): void {
    const privateThreads = Object.fromEntries(this.owners);
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, privateThreads } satisfies Persisted)}\n`, { mode: 0o600 });
  }
}
