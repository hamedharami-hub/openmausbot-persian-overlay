import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

import { json, readBody } from "./harness/http.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createPersonalProfileStore } from "./personal-profile.ts";
import { createPersonalProfileRoutes } from "./routes/personal-profile.ts";
import { dispatchRoutes } from "./routes/table.ts";

const dirs: string[] = [];
const servers: Server[] = [];
const memberKey = `p_${"a".repeat(22)}`;
const ownerKey = `p_${"b".repeat(22)}`;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-person-profile-"));
  dirs.push(dir);
  return dir;
}

function sessionAuth(id: string, scopes: readonly ("admin" | "client")[]): RequestAuth {
  return { kind: "session", via: "bearer", scopes, session: { id, scopes, label: id, expiresAt: Date.now() + 60_000 } } as RequestAuth;
}

async function serve(input: { store: ReturnType<typeof createPersonalProfileStore>; auth: RequestAuth; shared: boolean; profile?: (auth: RequestAuth) => { name?: string; aboutMe?: string } | undefined; saveLegacy?: (auth: RequestAuth, patch: { name?: string; aboutMe?: string }) => void }) {
  const routes = [createPersonalProfileRoutes({
    store: input.store,
    personKey: (auth) => auth.kind === "session" ? auth.session.id === "member" ? memberKey : ownerKey : undefined,
    shared: () => input.shared,
    profile: input.profile ?? (() => undefined),
    saveLegacy: input.saveLegacy ?? (() => {}),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: input.auth, json, readBody })) {
        json(res, 404, { error: "not found" });
      }
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me/profile`;
  return {
    get: () => fetch(url),
    put: (profile: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) }),
  };
}

it("persists profile fields by hashed account key and never crosses accounts", () => {
  const file = join(directory(), "personal-profiles.json");
  const store = createPersonalProfileStore(file, () => 123);
  expect(store.get(memberKey)).toBeUndefined();
  store.save(memberKey, { aboutMe: "Member-only facts", name: "Member" });
  store.save(ownerKey, { aboutMe: "Owner-only facts" });
  expect(createPersonalProfileStore(file).get(memberKey)).toMatchObject({ name: "Member", aboutMe: "Member-only facts", updatedAt: 123 });
  expect(createPersonalProfileStore(file).get(ownerKey)).toMatchObject({ aboutMe: "Owner-only facts" });
  expect(readFileSync(file, "utf8")).not.toContain("member@example.invalid");
});

it("persists provider/model favorites per account", () => {
  const file = join(directory(), "personal-profiles.json");
  const store = createPersonalProfileStore(file, () => 456);
  const favorites = [{ instanceId: "openai-account-1", model: "gpt-model" }];
  store.save(memberKey, { modelFavorites: favorites });
  store.save(ownerKey, { modelFavorites: [{ instanceId: "grok", model: "gpt-model" }] });
  expect(createPersonalProfileStore(file).get(memberKey)?.modelFavorites).toEqual(favorites);
  expect(createPersonalProfileStore(file).get(ownerKey)?.modelFavorites).toEqual([{ instanceId: "grok", model: "gpt-model" }]);
  expect(() => store.save(memberKey, { modelFavorites: Array.from({ length: 501 }, (_, index) => ({ instanceId: "engine", model: `model-${index}` })) })).toThrow("invalid or exceed");
});

it("persists ordered sidebar favorites separately for each account", () => {
  const file = join(directory(), "personal-profiles.json");
  const store = createPersonalProfileStore(file, () => 789);
  store.save(memberKey, { sidebarFavorites: ["group-1", "bot-1"] });
  store.save(ownerKey, { sidebarFavorites: ["bot-2"] });
  expect(createPersonalProfileStore(file).get(memberKey)?.sidebarFavorites).toEqual(["group-1", "bot-1"]);
  expect(createPersonalProfileStore(file).get(ownerKey)?.sidebarFavorites).toEqual(["bot-2"]);
  expect(() => store.save(memberKey, { sidebarFavorites: ["duplicate", "duplicate"] })).toThrow("invalid or exceed");
});

it("serves and saves a member's profile without exposing the installation profile", async () => {
  const store = createPersonalProfileStore(join(directory(), "personal-profiles.json"));
  const member = await serve({
    store, auth: sessionAuth("member", ["client"]), shared: true,
    profile: () => undefined,
  });
  expect(await (await member.get()).json()).toEqual({ profile: { name: "", aboutMe: "", modelFavorites: [] }, preferenceScope: "account" });
  expect((await member.put({ aboutMe: "MEMBER_PRIVATE_FACT", modelFavorites: [{ instanceId: "provider-a", model: "model-a" }], sidebarFavorites: ["group-private"] })).status).toBe(200);
  expect(await (await member.get()).json()).toEqual({ profile: { name: "", aboutMe: "MEMBER_PRIVATE_FACT", modelFavorites: [{ instanceId: "provider-a", model: "model-a" }], sidebarFavorites: ["group-private"] }, preferenceScope: "account" });

  const owner = await serve({
    store, auth: sessionAuth("owner", ["admin", "client"]), shared: true,
    profile: () => ({ name: "Owner", aboutMe: "OWNER_PRIVATE_FACT" }),
  });
  expect(await (await owner.get()).json()).toEqual({ profile: { name: "Owner", aboutMe: "OWNER_PRIVATE_FACT", modelFavorites: [] }, preferenceScope: "account" });
  expect((await owner.put({ aboutMe: "OWNER_NEW_FACT" })).status).toBe(200);
  expect(await (await owner.get()).json()).toEqual({ profile: { name: "Owner", aboutMe: "OWNER_NEW_FACT", modelFavorites: [] }, preferenceScope: "account" });
  expect(await (await member.get()).json()).toEqual({ profile: { name: "", aboutMe: "MEMBER_PRIVATE_FACT", modelFavorites: [{ instanceId: "provider-a", model: "model-a" }], sidebarFavorites: ["group-private"] }, preferenceScope: "account" });
});

it("keeps the legacy profile path for a single-user installation", async () => {
  const store = createPersonalProfileStore(join(directory(), "personal-profiles.json"));
  let legacy = { name: "Single user", aboutMe: "Old notes" };
  const api = await serve({
    store, auth: sessionAuth("owner", ["admin", "client"]), shared: false,
    profile: () => legacy,
    saveLegacy: (_auth, patch) => { legacy = { ...legacy, ...patch }; },
  });
  expect(await (await api.get()).json()).toEqual({ profile: { ...legacy, modelFavorites: [] }, preferenceScope: "installation" });
  expect((await api.put({ aboutMe: "Updated notes" })).status).toBe(200);
  expect(await (await api.get()).json()).toEqual({ profile: { name: "Single user", aboutMe: "Updated notes", modelFavorites: [] }, preferenceScope: "installation" });
  expect(store.get(ownerKey)).toBeUndefined();
});

it("keeps single-user favorites installation-scoped and rejects client writes", async () => {
  const store = createPersonalProfileStore(join(directory(), "personal-profiles.json"));
  const owner = await serve({ store, auth: sessionAuth("owner", ["admin", "client"]), shared: false });
  const member = await serve({ store, auth: sessionAuth("member", ["client"]), shared: false });
  const favorites = [{ instanceId: "provider-a", model: "model-a" }];
  expect((await owner.put({ modelFavorites: favorites })).status).toBe(200);
  await expect((await member.get()).json()).resolves.toMatchObject({ profile: { modelFavorites: favorites } });
  expect((await member.put({ modelFavorites: [] })).status).toBe(403);
});

it("bounds profile input and fails closed on a corrupt on-disk profile file", async () => {
  const dir = directory();
  const file = join(dir, "personal-profiles.json");
  const store = createPersonalProfileStore(file);
  expect(() => store.save(memberKey, { aboutMe: "x".repeat(24_001) })).toThrow("About me is too long");
  expect(() => store.save("../../other", { name: "x" })).toThrow("valid account key");
  const api = await serve({ store, auth: sessionAuth("member", ["client"]), shared: true });
  expect((await api.put({ aboutMe: "x".repeat(24_001) })).status).toBe(400);
  rmSync(file, { force: true });
  await import("node:fs").then(({ writeFileSync }) => writeFileSync(file, "{broken"));
  expect(() => store.get(memberKey)).toThrow();
});
