import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ThreadAccess } from "./thread-access.ts";

const dirs: string[] = [];
const personA = `p_${"a".repeat(22)}`;
const personB = `p_${"b".repeat(22)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-thread-access-"));
  dirs.push(dir);
  return { dir, file: join(dir, "thread-access.json") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("thread account access", () => {
  it("persists a private owner, denies other accounts, and allows explicit cleanup", () => {
    const { file } = fixture();
    const access = new ThreadAccess(file);
    expect(access.privateOwner("task-1")).toBeUndefined();
    expect(access.canAccess("task-1", personB)).toBe(false); // legacy direct threads need explicit account ownership
    expect(access.claimPrivate("task-1", personA)).toBe(true);
    expect(access.claimPrivate("task-1", personA)).toBe(true);
    expect(access.claimPrivate("task-1", personB)).toBe(false);
    expect(access.canAccess("task-1", personA)).toBe(true);
    expect(access.canAccess("task-1", personB)).toBe(false);

    const restarted = new ThreadAccess(file);
    expect(restarted.privateOwner("task-1")).toBe(personA);
    expect(restarted.canAccess("task-1", personB)).toBe(false);
    expect(restarted.forget("task-1")).toBe(true);
    expect(new ThreadAccess(file).canAccess("task-1", personB)).toBe(false);
  });

  it("fails closed on corrupt access data instead of silently making private threads public", () => {
    const { file } = fixture();
    const access = new ThreadAccess(file);
    expect(access.claimPrivate("task-1", personA)).toBe(true);
    const corrupted = JSON.parse(readFileSync(file, "utf8"));
    corrupted.privateThreads["task-1"] = "not-a-person-key";
    writeFileSync(file, JSON.stringify(corrupted));
    expect(() => new ThreadAccess(file)).toThrow(/invalid entry/);
  });

  it("does not grant an in-memory private scope when durable storage fails", () => {
    const { dir } = fixture();
    const access = new ThreadAccess(join(dir, "missing", "thread-access.json"));
    expect(access.claimPrivate("task-1", personA)).toBe(false);
    expect(access.privateOwner("task-1")).toBeUndefined();
  });
});
