import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("reloads learned facts after restart and never replaces a corrupt account file with an empty one", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-profile-learned-"));
  directories.push(dataDir);
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  vi.resetModules();

  const personKey = "p_" + "a".repeat(22);
  const source = { botId: "fixture-bot", botName: "Fixture" };
  const firstRun = await import("./profile-learned.ts");
  const facts = firstRun.planLearned(source, ["Prefers concise answers"], "", "2026-10-24", 100, personKey);
  expect(facts).toHaveLength(1);
  firstRun.commitLearned(facts, personKey);
  const persistedPath = join(dataDir, "profile-learned", personKey + ".json");
  const persistedBeforeRestart = readFileSync(persistedPath, "utf8");

  vi.resetModules();
  const restarted = await import("./profile-learned.ts");
  expect(restarted.listLearnedFacts(personKey)).toEqual(facts);
  expect(restarted.planLearned(source, ["Prefers concise answers"], facts[0]!.line, "2026-10-24", 101, personKey)).toEqual([]);
  expect(restarted.listLearnedFacts("p_" + "b".repeat(22))).toEqual([]);

  writeFileSync(persistedPath, "{broken");
  expect(() => restarted.listLearnedFacts(personKey)).toThrow(/malformed/);
  expect(() => restarted.planLearned(source, ["Another fact"], "", "2026-10-24", 102, personKey)).toThrow(/malformed/);
  expect(() => restarted.commitLearned(facts, personKey)).toThrow(/malformed/);
  expect(readFileSync(persistedPath, "utf8")).toBe("{broken");
  expect(persistedBeforeRestart).toContain("Prefers concise answers");
});

it("keeps forgotten passages isolated to the account that asked to forget them", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-profile-forget-scope-"));
  directories.push(dataDir);
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  vi.resetModules();

  const first = "p_" + "a".repeat(22);
  const second = "p_" + "b".repeat(22);
  const learned = await import("./profile-learned.ts");
  const mentions = (text: string) => text.toLowerCase().includes("short answers");

  learned.rememberForgotten("short answers", mentions, first);
  expect(learned.isForgotten("Prefers short answers", first)).toBe(true);
  expect(learned.isForgotten("Prefers short answers", second)).toBe(false);

  learned.clearForgotten("Prefers short answers", second);
  expect(learned.isForgotten("Prefers short answers", first)).toBe(true);
  learned.clearForgotten("Prefers short answers", first);
  expect(learned.isForgotten("Prefers short answers", first)).toBe(false);
});
