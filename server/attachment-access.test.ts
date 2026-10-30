import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttachmentAccess } from "./attachment-access.ts";

const dirs: string[] = [];
const personA = `p_${"a".repeat(22)}`;
const personB = `p_${"b".repeat(22)}`;
const fileName = "11111111-1111-4111-8111-111111111111.pdf";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-attachment-access-"));
  dirs.push(dir);
  return { dir, file: join(dir, "attachment-access.json") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uploaded attachment account access", () => {
  it("persists the uploader, allows idempotent retries, and rejects cross-account upload-id reuse", () => {
    const { file } = fixture();
    const access = new AttachmentAccess(file);
    expect(access.owner(fileName)).toBeUndefined();
    expect(access.claim(fileName, personA)).toBe("claimed");
    expect(access.claim(fileName, personA)).toBe("already-owned");
    expect(access.claim(fileName, personB)).toBe("conflict");

    const restarted = new AttachmentAccess(file);
    expect(restarted.owner(fileName)).toBe(personA);
    expect(restarted.claim(fileName, personB)).toBe("conflict");
  });

  it("fails closed on malformed persisted ownership", () => {
    const { file } = fixture();
    const access = new AttachmentAccess(file);
    expect(access.claim(fileName, personA)).toBe("claimed");
    const corrupted = JSON.parse(readFileSync(file, "utf8"));
    corrupted.owners[fileName] = "not-an-account";
    writeFileSync(file, JSON.stringify(corrupted));
    expect(() => new AttachmentAccess(file)).toThrow(/invalid entry/);
  });

  it("does not grant access if the private ownership record cannot be saved", () => {
    const { dir } = fixture();
    const access = new AttachmentAccess(join(dir, "missing", "attachment-access.json"));
    expect(access.claim(fileName, personA)).toBe("storage-error");
    expect(access.owner(fileName)).toBeUndefined();
  });
});
