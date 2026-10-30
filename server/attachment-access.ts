/** Tracks who may still read an uploaded attachment before a message explicitly shares it. */
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";

const PERSON = /^p_[\w-]{22}$/;
const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,12}$/i;
const MAX_ENTRIES = 200_000;

type Persisted = { version: 1; owners: Record<string, string> };
export type AttachmentClaim = "claimed" | "already-owned" | "conflict" | "storage-error";

export class AttachmentAccess {
  private readonly owners = new Map<string, string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`attachment access store could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("attachment access store is malformed");
    const document = raw as Partial<Persisted>;
    if (document.version !== 1 || !document.owners || typeof document.owners !== "object" || Array.isArray(document.owners)) {
      throw new Error("attachment access store has an unsupported format");
    }
    const entries = Object.entries(document.owners);
    if (entries.length > MAX_ENTRIES) throw new Error("attachment access store has too many entries");
    for (const [name, owner] of entries) {
      if (!FILE.test(name) || (owner !== "operator" && (typeof owner !== "string" || !PERSON.test(owner)))) {
        throw new Error("attachment access store contains an invalid entry");
      }
      this.owners.set(name, owner);
    }
  }

  owner(name: string): string | undefined {
    return this.owners.get(name);
  }

  /** A retry may claim its existing upload, but a different account cannot reuse its upload id. */
  claim(name: string, owner: string): AttachmentClaim {
    if (!FILE.test(name) || (owner !== "operator" && !PERSON.test(owner))) return "storage-error";
    const existing = this.owners.get(name);
    if (existing !== undefined) return existing === owner ? "already-owned" : "conflict";
    if (this.owners.size >= MAX_ENTRIES) return "storage-error";
    this.owners.set(name, owner);
    try {
      this.persist();
      return "claimed";
    } catch (error) {
      this.owners.delete(name);
      console.warn(`attachment access: could not save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      return "storage-error";
    }
  }

  private persist(): void {
    writeFileAtomic(this.file, `${JSON.stringify({ version: 1, owners: Object.fromEntries(this.owners) } satisfies Persisted)}\n`, { mode: 0o600 });
  }
}
